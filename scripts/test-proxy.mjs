import { createServer } from "node:http";
import handler from "../api/proxy.js";

const server = createServer((req, res) => void handler(req, res));
await new Promise((r) => server.listen(8901, "127.0.0.1", r));
const base = "http://127.0.0.1:8901";

const results = [];
async function check(name, fn) {
  try {
    const msg = await fn();
    results.push(`PASS ${name}${msg ? ` — ${msg}` : ""}`);
  } catch (err) {
    results.push(`FAIL ${name} — ${err.message}`);
  }
}

await check("git info/refs through proxy", async () => {
  const r = await fetch(`${base}/?https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack`);
  const text = await r.text();
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!text.includes("# service=git-upload-pack")) throw new Error("bad body");
  if (r.headers.get("access-control-allow-origin") !== "*") throw new Error("missing CORS");
  return `${text.length} bytes`;
});

await check("OPTIONS preflight", async () => {
  const r = await fetch(base, { method: "OPTIONS" });
  if (r.status !== 204) throw new Error(`status ${r.status}`);
});

await check("missing url → 400 json", async () => {
  const r = await fetch(base);
  if (r.status !== 400) throw new Error(`status ${r.status}`);
  const j = await r.json();
  if (!j.error) throw new Error("no error payload");
});

await check("private host blocked", async () => {
  const r = await fetch(`${base}/?http://127.0.0.1:9/x`);
  if (r.status !== 400) throw new Error(`status ${r.status}`);
});

await check("localhost blocked", async () => {
  const r = await fetch(`${base}/?http://localhost:9/x`);
  if (r.status !== 400) throw new Error(`status ${r.status}`);
});

await check("bad method → 405", async () => {
  const r = await fetch(base, { method: "DELETE" });
  if (r.status !== 405) throw new Error(`status ${r.status}`);
});

server.close();
console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
