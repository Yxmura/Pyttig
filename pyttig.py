#!/usr/bin/env python3
"""Pyttig launcher — zero-install local server for the Pyttig IDE.

Only the Python standard library is used. It:

  * serves the built app (./dist) on http://127.0.0.1:8765
  * sets Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy so the
    browser enables SharedArrayBuffer (hard stop, interactive input(),
    streaming requests in Pyodide)
  * exposes /__pyttig__/ping so the app can detect "local mode"
  * exposes /__pyttig__/proxy/<url> — a CORS bypass for git smart-HTTP
    (clone/pull/push from GitHub etc.), so everything stays local
  * optionally serves a vendored Pyodide (--pyodide-dir) for fully offline use

Usage:
    python pyttig.py [--port 8765] [--host 127.0.0.1] [--no-browser]
                     [--root ./dist] [--pyodide-dir DIR] [--allow-private]
"""

from __future__ import annotations

import argparse
import functools
import http.server
import ipaddress
import json
import mimetypes
import os
import posixpath
import shutil
import socket
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http import HTTPStatus

VERSION = "0.1.0"
HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}
MAX_PROXY_BYTES = 128 * 1024 * 1024


def is_public_host(host: str, allow_private: bool) -> bool:
    if allow_private:
        return True
    try:
        ips = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return False
    for fam, _, _, _, sockaddr in ips:
        try:
            ip = ipaddress.ip_address(sockaddr[0])
        except ValueError:
            continue
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved:
            return False
    return True


class Handler(http.server.SimpleHTTPRequestHandler):
    allow_private = False
    pyodide_dir: str | None = None
    server_version = f"Pyttig/{VERSION}"

    # -- helpers ---------------------------------------------------------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _isolation_headers(self):
        # SharedArrayBuffer needs these. jsdelivr serves CORP: cross-origin,
        # so CDN assets keep working.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "*")
        self.send_header("Access-Control-Expose-Headers", "*")

    def end_headers(self):  # noqa: N802 - http.server hook
        # Every response carries isolation + CORS so the page (and workers it
        # spawns) run cross-origin isolated, and same-origin fetches stay easy.
        self._isolation_headers()
        self._cors_headers()
        # Hashed assets are immutable; everything else (index.html above all)
        # must revalidate or a stale page will reference deleted asset hashes
        # after a rebuild.
        if self.path.startswith("/assets/") or self.path.startswith("/fileicons/"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # -- routing ----------------------------------------------------------
    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path == "/__pyttig__/ping" or self.path.startswith("/__pyttig__/ping?"):
            self._send_json({"ok": True, "name": "pyttig", "version": VERSION})
            return
        if self.path.startswith("/__pyttig__/proxy/"):
            self._proxy()
            return
        if self.path.startswith("/__pyttig__/pyodide/") and self.pyodide_dir:
            self._serve_pyodide()
            return
        # Static app (with isolation headers).
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            self._serve_index()
            return
        # SimpleHTTPRequestHandler honours self.directory (py>=3.7).
        super().do_GET()

    def _serve_index(self):
        """Serve index.html with a launcher marker: the app then knows it is
        running locally (no capability probing needed)."""
        path = os.path.join(self.directory, "index.html")
        try:
            with open(path, "rb") as fh:
                html = fh.read().decode("utf-8")
        except OSError:
            self.send_error(404, "index.html not built (run: npm run build)")
            return
        html = html.replace(
            "</head>",
            '<meta name="pyttig-launcher" content="1" />\n</head>',
            1,
        )
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        self._proxy_or_404()

    def do_PUT(self):  # noqa: N802
        self._proxy_or_404()

    def do_PATCH(self):  # noqa: N802
        self._proxy_or_404()

    def do_DELETE(self):  # noqa: N802
        self._proxy_or_404()

    def _proxy_or_404(self):
        if self.path.startswith("/__pyttig__/proxy/"):
            self._proxy()
        else:
            self.send_error(404)

    # -- vendored pyodide --------------------------------------------------
    def _serve_pyodide(self):
        assert self.pyodide_dir
        rel = urllib.parse.unquote(self.path[len("/__pyttig__/pyodide/"):])
        full = os.path.normpath(os.path.join(self.pyodide_dir, rel))
        if not full.startswith(os.path.abspath(self.pyodide_dir) + os.sep) and full != os.path.abspath(self.pyodide_dir):
            self.send_error(403)
            return
        if os.path.isdir(full):
            self.send_error(404)
            return
        if not os.path.isfile(full):
            self.send_error(404)
            return
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        try:
            with open(full, "rb") as fh:
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(os.path.getsize(full)))
                self.send_header("Cache-Control", "public, max-age=31536000, immutable")
                self.end_headers()
                shutil.copyfileobj(fh, self.wfile)
        except BrokenPipeError:
            pass

    # -- git CORS proxy ----------------------------------------------------
    def _proxy(self):
        raw = self.path[len("/__pyttig__/proxy/"):]
        target = urllib.parse.unquote(raw).lstrip("/")
        # isomorphic-git strips the scheme (corsProxify); default to https
        # exactly like the public cors.isomorphic-git.org proxy does.
        if "://" not in target:
            target = "https://" + target
        try:
            parts = urllib.parse.urlsplit(target)
        except ValueError:
            self.send_error(400, "bad URL")
            return
        if parts.scheme not in ("http", "https") or not parts.hostname:
            self.send_error(400, "only http(s) URLs are proxied")
            return
        if not is_public_host(parts.hostname, self.allow_private):
            self.send_error(403, "private/local hosts are blocked (use --allow-private for LAN git servers)")
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_PROXY_BYTES:
            self.send_error(413, "request body too large")
            return
        body = self.rfile.read(length) if length else None

        fwd = {}
        ctype = self.headers.get("Content-Type")
        if ctype:
            fwd["Content-Type"] = ctype
        for h in ("Accept", "Accept-Encoding", "Authorization", "Git-Protocol"):
            v = self.headers.get(h)
            if v:
                fwd[h] = v
        # isomorphic-git sends credentials via Authorization already.
        req = urllib.request.Request(target, data=body, headers=fwd, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = resp.read(MAX_PROXY_BYTES + 1)
                if len(data) > MAX_PROXY_BYTES:
                    self.send_error(502, "upstream response too large")
                    return
                self.send_response(resp.status)
                for h in ("Content-Type", "Content-Encoding", "Cache-Control"):
                    v = resp.headers.get(h)
                    if v:
                        self.send_header(h, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            try:
                data = e.read(MAX_PROXY_BYTES)
            except Exception:  # noqa: BLE001
                data = b""
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "text/plain"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except BrokenPipeError:
                pass
        except Exception as e:  # noqa: BLE001
            self.send_error(502, f"proxy error: {e}")

    # -- quieter logs -------------------------------------------------------
    def log_message(self, fmt, *args):  # noqa: N802
        if self.path.startswith("/__pyttig__/proxy/"):
            return  # git traffic is noisy; stay quiet
        sys.stderr.write(f"pyttig: {self.address_string()} {fmt % args}\n")


def download_pyodide(version: str, dest: str) -> None:
    """Fetch the official Pyodide release tarball into dest/<version>/."""
    url = f"https://github.com/pyodide/pyodide/releases/download/{version}/pyodide-{version}.tar.bz2"
    out_dir = os.path.join(dest, version)
    os.makedirs(out_dir, exist_ok=True)
    tmp = os.path.join(dest, f"pyodide-{version}.tar.bz2")
    print(f"pyttig: downloading {url} ...")
    urllib.request.urlretrieve(url, tmp)
    print("pyttig: extracting ...")
    shutil.unpack_archive(tmp, out_dir)
    os.remove(tmp)
    print(f"pyttig: Pyodide {version} ready in {out_dir}")
    print("pyttig: serve it with  python pyttig.py --pyodide-dir " + dest)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Pyttig — local launcher (stdlib only)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--root", default=None, help="directory to serve (default: ./dist next to this script)")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--allow-private", action="store_true", help="allow the git proxy to reach LAN/private hosts")
    ap.add_argument("--pyodide-dir", default=None, help="serve a vendored Pyodide at /__pyttig__/pyodide/")
    ap.add_argument("--download-pyodide", metavar="VERSION", default=None, help="download a Pyodide release for offline use and exit")
    args = ap.parse_args(argv)

    if args.download_pyodide:
        here = os.path.dirname(os.path.abspath(__file__))
        download_pyodide(args.download_pyodide, os.path.join(here, ".pyttig", "pyodide"))
        return 0

    root = args.root or os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")
    if not os.path.isfile(os.path.join(root, "index.html")):
        print(f"pyttig: no app found in {root!r}.", file=sys.stderr)
        print("pyttig: run `npm install && npm run build` first (developers),", file=sys.stderr)
        print("pyttig: or download a release bundle that already contains dist/.", file=sys.stderr)
        return 1

    Handler.allow_private = args.allow_private
    Handler.pyodide_dir = os.path.abspath(args.pyodide_dir) if args.pyodide_dir else None
    handler = functools.partial(Handler, directory=os.path.abspath(root))

    class Server(http.server.ThreadingHTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    try:
        httpd = Server((args.host, args.port), handler)
    except OSError as e:
        print(f"pyttig: cannot listen on {args.host}:{args.port}: {e}", file=sys.stderr)
        return 1

    url = f"http://{'localhost' if args.host in ('127.0.0.1', '::1') else args.host}:{args.port}/"
    print(f"pyttig: serving {root}")
    print(f"pyttig: open {url}")
    print("pyttig: cross-origin isolated (SharedArrayBuffer: ON), git proxy at /__pyttig__/proxy/")
    if Handler.pyodide_dir:
        print(f"pyttig: vendored Pyodide at /__pyttig__/pyodide/ from {Handler.pyodide_dir}")
    print("pyttig: press Ctrl+C to stop")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\npyttig: bye 🌶️")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
