// Library support check: installs the PyPI download top 100 plus a curated
// list of commonly used libraries in the built app, then imports each one and
// reports what works and why the rest can't.
//
//   npm run build
//   python pyttig.py --port 8765        (in another shell)
//   node scripts/check-libs.mjs         (all lists)
//   node scripts/check-libs.mjs numpy pandas torch   (only these)
//
// Exit code is non-zero if anything outside the known-impossible set fails.
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const ONLY = process.argv.slice(2);

function loadLists() {
  if (ONLY.length) return [{ name: "given", pkgs: ONLY }];
  const lists = [];
  const top = JSON.parse(readFileSync("scripts/top-100-packages.json", "utf-8"));
  lists.push({ name: "PyPI top 100 (downloads)", pkgs: top.rows.map((r) => r.project) });
  const popular = JSON.parse(readFileSync("scripts/popular-libraries.json", "utf-8"));
  const curated = [];
  for (const [key, arr] of Object.entries(popular)) {
    if (key === "note" || !Array.isArray(arr)) continue;
    for (const p of arr) curated.push(p);
  }
  lists.push({ name: "commonly used", pkgs: curated });
  return lists;
}

// Expected to stay unsupported in a browser, with the reason. Anything else
// failing is a regression and fails the run.
const UNSUPPORTED = new Map([
  // compiled C/C++/Rust extensions with no wasm build
  ["grpcio", "compiled C++ extension, no wasm build"],
  ["grpcio-status", "compiled C++ extension, no wasm build"],
  ["greenlet", "compiled C extension, no wasm build"],
  ["psycopg2-binary", "compiled C extension, no wasm build"],
  ["catboost", "compiled C++ extension, no wasm build"],
  ["spacy", "compiled C/C++ extensions, no wasm build"],
  ["ruff", "Rust binary, not a Python package"],
  ["keras", "needs a compiler/CMake to build its backend"],
  ["transformers", "depends on tokenizers (Rust, no wasm build)"],
  ["litellm", "depends on tokenizers (Rust, no wasm build)"],
  ["pdfplumber", "depends on pypdfium2 (C++, no wasm build)"],
  ["scrapy", "Twisted's reactor needs UNIX sockets"],
  ["soupsieve", "its 2.8.x release imports bs4 without declaring it; install beautifulsoup4 instead"],
  // no source distribution at all
  ["torch", "no wheel and no sdist for wasm"],
  ["tensorflow", "no wheel and no sdist for wasm"],
  // OS/desktop only
  ["playwright", "drives real browsers via subprocesses"],
  ["psutil", "reads OS process tables; refuses to run on emscripten"],
  ["turtle", "desktop Tk window"],
  ["tkinter", "desktop Tk window"],
  ["wxpython", "desktop GUI toolkit"],
  ["pyqt5", "desktop GUI toolkit"],
  ["kivy", "desktop/mobile GUI toolkit"],
  // host tooling
  ["pip", "pip itself needs subprocesses"],
  ["setuptools", "build tooling for a host machine"],
  ["wheel", "build tooling for a host machine"],
  ["build", "build tooling for a host machine"],
  ["twine", "upload tooling for a host machine"],
  ["tox", "needs the venv module and subprocesses"],
  ["virtualenv", "needs the venv module and subprocesses"],
  ["pre-commit", "needs git hooks and subprocesses"],
]);

const CHECK = `
import importlib, importlib.metadata as md, json, sys

def toplevels(dist_name):
    try:
        dist = md.distribution(dist_name)
    except Exception:
        return None
    tops = set()
    for f in (dist.files or []):
        p = str(f).replace("\\\\", "/")
        head = p.split("/")[0]
        if p.endswith(".pth") or head.startswith(".."):
            continue
        if head.endswith((".dist-info", ".egg-info")) or head in ("bin", "share", "include", "Scripts", "data", "tests", "test", "docs", "examples", "__pycache__"):
            continue
        if head.endswith(".py"):
            tops.add(head[:-3])
        elif "." not in head:
            tops.add(head)
        elif ".so" in head:
            tops.add(head.split(".")[0])
    skip = {"setup", "conftest", "noxfile", "tasks", "scripts", "sitecustomize", "_distutils_hack"}
    return sorted(t for t in tops if t and t not in skip)

names = json.loads(sys.argv[1]) if False else None
names = __import__("json").loads(open("/tmp/check_names.json").read())
results = []
for name in names:
    tops = toplevels(name)
    if tops is None:
        guess = name.lower().replace("-", "_").replace(".", "_")
        tops = [guess]
    if not tops:
        results.append({"name": name, "ok": False, "module": "", "error": "no importable module found"})
        continue
    ok = None
    first_err = ""
    for t in tops:
        try:
            importlib.import_module(t)
            ok = t
            break
        except BaseException as e:
            if not first_err:
                first_err = f"{type(e).__name__}: {str(e)[:150]}"
    if ok:
        results.append({"name": name, "ok": True, "module": ok, "error": ""})
    else:
        results.append({"name": name, "ok": False, "module": ",".join(tops[:3]), "error": first_err})
_bad = [r for r in results if not r["ok"]]
for _r in _bad:
    print("WHY " + _r["name"] + " :: " + _r["error"].replace(chr(10), " ")[:70])
print("BADLIST " + ",".join(r["name"] for r in _bad))
print("SUMMARY ok=%d fail=%d total=%d" % (len(results) - len(_bad), len(_bad), len(results)))
`;

const lists = loadLists();
const all = [];
for (const l of lists) for (const p of l.pkgs) if (!all.includes(p)) all.push(p);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  try {
    localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
    localStorage.setItem("pyttig.ui.panelH", "620");
  } catch { /* ignore */ }
});
if (process.env.CHECK_DEBUG) {
  page.on("console", (m) => console.log(`[console:${m.type()}]`, m.text().slice(0, 300)));
}
await page.goto("http://127.0.0.1:8765/");
await page.waitForSelector(".welcome-hero", { timeout: 20000 });

// install everything first (chunks keep the fast Pyodide path working)
await page.click('.ab-btn[title="Packages"]');
await page.waitForSelector(".search-box input", { timeout: 10000 });
const chunk = 8;
const installErrors = {};
for (let i = 0; i < all.length; i += chunk) {
  const batch = all.slice(i, i + chunk);
  await page.fill(".search-box input", batch.join(" "));
  await page.click(".search-box .btn.primary");
  await page.waitForFunction(
    () => {
      const b = document.querySelector(".search-box .btn.primary");
      return b && !b.disabled;
    },
    undefined,
    { timeout: 900000, polling: 1000 },
  );
  const toast = await page.evaluate(() => {
    const t = [...document.querySelectorAll(".toast")].pop();
    return t ? (t.textContent ?? "") : "";
  });
  for (const p of batch) {
    // "name: reason" pairs in failure toasts
    const m = toast.match(new RegExp(`(?:^|[—·])\\s*${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: ([^·]+)`));
    if (m) installErrors[p] = m[1].trim();
  }
  if (toast.startsWith("Failed")) console.log(`  ! ${toast.replace(/\s+/g, " ")}`);
}

// import check
await page.keyboard.press("Control+Shift+p");
await page.waitForSelector(".palette input");
await page.fill(".palette input", "New file");
await page.keyboard.press("Enter");
await page.waitForSelector(".dialog input");
await page.fill(".dialog input", "check_libs.py");
await page.keyboard.press("Enter");
await page.click(".editor-host");
await page.evaluate((text) => {
  const el = document.querySelector(".editor-host .cm-content");
  if (!el) throw new Error("editor not found");
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, `import json\nopen("/tmp/check_names.json","w").write(json.dumps(${JSON.stringify(all)}))\nprint("names written")`);
await page.waitForTimeout(1500);
await page.keyboard.press("Control+Enter");
await page.waitForFunction(
  () => (document.getElementById("panel-body")?.innerText ?? "").includes("[done]"),
  undefined,
  { timeout: 300000, polling: 1000 },
);

// paste the real check and run it
await page.keyboard.press("Control+a");
await page.evaluate((text) => {
  const el = document.querySelector(".editor-host .cm-content");
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, CHECK);
await page.waitForTimeout(1200);
await page.keyboard.press("Control+Enter");
await page.waitForFunction(
  () => (document.getElementById("panel-body")?.innerText ?? "").includes("SUMMARY ok="),
  undefined,
  { timeout: 900000, polling: 1500 },
);
const term = await page.evaluate(() => document.getElementById("panel-body")?.innerText ?? "");
if (process.env.CHECK_DEBUG) console.log("---- terminal ----\n" + term.slice(-4000) + "\n------------------");
// BADLIST may wrap across rendered lines; it is printed last, so take
// everything from it up to the SUMMARY line (never the WHY lines before it).
const lines = term.split("\n");
const start = lines.findIndex((l) => l.includes("BADLIST "));
const end = lines.findIndex((l, i) => i > start && l.includes("SUMMARY ok="));
let badNames = new Set();
if (start >= 0 && end > start) {
  const joined = lines.slice(start, end).join("").replace(/\s+/g, "");
  const i = joined.indexOf("BADLIST ");
  badNames = new Set(joined.slice(i + "BADLIST ".length).split(",").filter(Boolean));
}
const whyByName = new Map();
for (const line of lines) {
  const m = line.match(/WHY\s+(\S+)\s+::\s*(.*)$/);
  if (m) whyByName.set(m[1], m[2].trim());
}
const summary = lines.find((l) => l.includes("SUMMARY ok=")) ?? "";
const m = summary.match(/ok=(\d+) fail=(\d+) total=(\d+)/);
if (!m) throw new Error("harness: no SUMMARY line in the terminal");
const okCount = Number(m[1]);
const failCount = Number(m[2]);
const total = Number(m[3]);
if (total !== all.length) {
  console.log(term.slice(-2000));
  throw new Error(`harness: checked ${total} of ${all.length} packages — the run did not cover the list`);
}
const results = all.map((name) => ({ name, ok: !badNames.has(name), error: whyByName.get(name) ?? installErrors[name] ?? "" }));
if (failCount !== badNames.size) {
  console.log(`harness: Python reported ${failCount} failures, parsed ${badNames.size} names`);
}

console.log("\n================ LIBRARY SUPPORT ================");
const ok = results.filter((r) => r.ok);
const bad = results.filter((r) => !r.ok);
for (const r of ok) console.log(`OK    ${r.name}`);
for (const r of bad) {
  const why = installErrors[r.name] || r.error || "unknown";
  const known = UNSUPPORTED.get(r.name);
  const tag = known ? "N/A   " : "FAIL  ";
  const note = known ? ` (expected: ${known})` : "";
  console.log(`${tag}${r.name.padEnd(24)} ${why.replace(/\s+/g, " ").slice(0, 120)}${note}`);
}
console.log(`\n${okCount}/${total} importable, ${failCount} not`);
console.log(`lists: ${lists.map((l) => `${l.name} (${l.pkgs.length})`).join(", ")}`);
await browser.close();

const unexpected = bad.filter((r) => !UNSUPPORTED.has(r.name));
console.log(unexpected.length
  ? `\nUNEXPECTED FAILURES: ${unexpected.map((r) => r.name).join(", ")}`
  : "\nAll failures are the known browser limitations.");
process.exit(unexpected.length ? 1 : 0);
