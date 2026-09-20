// Vercel serverless git proxy — powers clone/pull/fetch from the static site.
//
// The browser calls:  /api/proxy?https://github.com/user/repo.git/info/refs?service=…
// Everything after the first "?" is the upstream URL (isomorphic-git builds
// that form when the proxy URL ends with "?").
//
// Plain Node APIs only, so this file also runs behind a local http server for
// testing. Node 18+ (Vercel default runtime).

import { Readable } from "node:stream";

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "OPTIONS"]);

const HOP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "content-length", // re-derived by fetch from the stream
]);

const FORWARD_RESPONSE_HEADERS = ["content-type", "content-encoding", "cache-control", "etag", "last-modified"];

const PRIVATE_HOST = new RegExp(
  [
    "^localhost$",
    "^127\\.",
    "^0\\.",
    "^10\\.",
    "^192\\.168\\.",
    "^172\\.(1[6-9]|2\\d|3[01])\\.",
    "^169\\.254\\.",
    "^\\[?::1\\]?$",
    "\\.local$",
    "\\.internal$",
    "\\.localhost$",
  ].join("|"),
  "i",
);

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
    "access-control-expose-headers": "*",
    "cache-control": "no-store",
  };
}

function targetFromRequestUrl(rawUrl) {
  const q = rawUrl.indexOf("?");
  if (q < 0) return null;
  let target = rawUrl.slice(q + 1);
  if (!target) return null;
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (PRIVATE_HOST.test(parsed.hostname)) return null;
  return parsed.toString();
}

export default async function handler(req, res) {
  const cors = corsHeaders();

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (!ALLOWED_METHODS.has(req.method)) {
    res.writeHead(405, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  const target = targetFromRequestUrl(req.url ?? "");
  if (!target) {
    res.writeHead(400, { ...cors, "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: "usage: /api/proxy?<absolute https url>",
        hint: "private and local hosts are blocked",
      }),
    );
    return;
  }

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_HEADERS.has(key.toLowerCase()) && typeof value === "string") headers[key] = value;
  }

  try {
    const init = { method: req.method, headers, redirect: "follow" };
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      init.body = Readable.toWeb(req);
      init.duplex = "half";
    }
    const upstream = await fetch(target, init);

    const out = { ...cors };
    for (const h of FORWARD_RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) out[h] = v;
    }
    res.writeHead(upstream.status, out);
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        if (!res.write(chunk)) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
    }
    res.end();
  } catch (err) {
    res.writeHead(502, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ error: `proxy error: ${err?.message ?? err}` }));
  }
}
