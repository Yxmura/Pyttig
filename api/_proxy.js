// Shared git proxy core, used by both Vercel entrypoints:
//   api/proxy.js              → /api/proxy            (probe + legacy ?url form)
//   api/proxy/[...path].js    → /api/proxy/<host/...> (preferred path form)
//
// Why two forms? Putting a full URL in the query string survives nothing:
// CDNs and edges normalize/percent-encode it (Vercel did), and some WAFs block
// it outright. The path form — the same one the local launcher uses — is just
// a normal URL path, so it passes through untouched.
//
// Plain Node APIs only (Node 18+), so this also runs behind the local test
// server in scripts/vercel-sim.mjs.

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

function validate(target) {
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

const PING = "__ping";

/**
 * Resolve the upstream URL from the request URL. Supports:
 *   /api/proxy/github.com/user/repo.git/info/refs?service=…   (path form)
 *   /api/proxy?https://github.com/…                            (query form)
 * The query form is decoded defensively: edges sometimes re-encode it.
 */
export function resolveTarget(rawUrl) {
  const q = rawUrl.indexOf("?");
  const rawPath = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
  const rawQuery = q >= 0 ? rawUrl.slice(q + 1) : "";

  const marker = "/api/proxy/";
  const mi = rawPath.indexOf(marker);
  if (mi >= 0) {
    let rest = rawPath.slice(mi + marker.length);
    try {
      rest = decodeURIComponent(rest);
    } catch {
      /* keep raw */
    }
    if (rest === PING) return PING;
    if (rest) {
      const target = rawQuery ? `https://${rest}?${rawQuery}` : `https://${rest}`;
      return validate(target);
    }
  }

  if (rawQuery) {
    let target = rawQuery;
    try {
      target = decodeURIComponent(target);
    } catch {
      /* keep raw */
    }
    if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
    return validate(target);
  }
  return null;
}

export default async function proxyHandler(req, res) {
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

  const target = resolveTarget(req.url ?? "");

  // Capability probe (and a quiet answer for bare HEADs so browsers don't log
  // a 400 for a deliberate check).
  if (target === PING || (req.method === "HEAD" && target === null)) {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (!target) {
    res.writeHead(400, { ...cors, "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: "usage: /api/proxy?<absolute https url> or /api/proxy/<host/path>",
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
