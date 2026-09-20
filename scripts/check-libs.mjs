// Verifies which popular libraries install and import in the built app.
// Dev tool: catches Pyodide/package regressions when bumping versions.
//
//   npm run build
//   python pyttig.py --port 8765        (in another shell)
//   node scripts/check-libs.mjs
import { chromium } from "@playwright/test";

const BATCHES = [
  ["numpy", "pandas", "matplotlib", "scipy", "scikit-learn", "sympy", "Pillow", "lxml", "pyyaml", "requests"],
  ["beautifulsoup4", "rich", "tqdm", "openpyxl", "jinja2", "jsonschema", "pytest", "click", "tabulate", "faker"],
  ["seaborn", "python-docx", "python-pptx", "pygame-ce", "pydantic", "flask", "httpx", "aiohttp", "wordcloud", "networkx"],
  ["opencv-python", "reportlab", "art"],
];

// Expected to fail (no wasm build / sdist-only); listed for the record.
const KNOWN_HARD = ["torch", "gevent", "psycopg2-binary", "python-levenshtein", "hurry.filesize"];

const CHECK = `
import sys, importlib
print("Python", sys.version.split()[0])
mods = ["numpy","pandas","matplotlib","scipy","sklearn","sympy","PIL","lxml","yaml","requests",
        "bs4","rich","tqdm","openpyxl","jinja2","jsonschema","pytest","click","tabulate","faker",
        "seaborn","docx","pptx","pygame","pydantic","flask","httpx","aiohttp","wordcloud","networkx",
        "cv2","reportlab","art"]
bad = []
for m in mods:
    try:
        importlib.import_module(m)
        print("OK  ", m)
    except BaseException as e:
        bad.append(m)
        print("FAIL", m, "->", type(e).__name__ + ":", str(e)[:110])
print("SUMMARY", len(mods) - len(bad), "ok /", len(bad), "fail |", ",".join(bad) or "none")
`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  try {
    localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
    localStorage.setItem("pyttig.ui.panelH", "620");
  } catch { /* ignore */ }
});
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !t.includes("favicon")) console.log("[console]", t.slice(0, 200));
});

await page.goto("http://127.0.0.1:8765/");
await page.waitForSelector(".welcome-hero", { timeout: 20000 });
console.log("booted");

await page.click('.ab-btn[title="Packages"]');
await page.waitForSelector(".search-box input", { timeout: 10000 });

for (const batch of BATCHES) {
  const t0 = Date.now();
  await page.fill(".search-box input", batch.join(" "));
  await page.click(".search-box .btn.primary");
  await page.waitForFunction(
    () => {
      const b = document.querySelector(".search-box .btn.primary");
      return b && !b.disabled;
    },
    undefined,
    { timeout: 600000, polling: 1000 },
  );
  const toast = await page.evaluate(() => document.querySelector(".toast")?.textContent ?? "");
  console.log(`batch ${BATCHES.indexOf(batch) + 1} (${Math.round((Date.now() - t0) / 1000)}s): ${toast.slice(0, 300)}`);
}

// run the import check in the editor
await page.keyboard.press("Control+Shift+p");
await page.waitForSelector(".palette input");
await page.fill(".palette input", "New file");
await page.keyboard.press("Enter");
await page.waitForSelector(".dialog input");
await page.fill(".dialog input", "probe_libs.py");
await page.keyboard.press("Enter");
await page.click(".editor-host");
await page.evaluate((text) => {
  const el = document.querySelector(".editor-host .cm-content");
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, CHECK);
await page.waitForTimeout(1500);
await page.keyboard.press("Control+Enter");
await page.waitForFunction(
  () => (document.getElementById("panel-body")?.innerText ?? "").includes("[done]"),
  undefined,
  { timeout: 600000, polling: 1500 },
);
const term = await page.evaluate(() => document.getElementById("panel-body")?.innerText ?? "");
console.log("---- program output ----");
console.log(term);
await browser.close();
