import { chromium } from "@playwright/test";

const code = process.argv[2] ?? "print('hi')";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => {
  try {
    localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
    localStorage.setItem("pyttig.ui.panelH", "720");
  } catch { /* ignore */ }
});
await page.goto("http://127.0.0.1:8765/");
await page.waitForSelector(".welcome-hero", { timeout: 20000 });
await page.keyboard.press("Control+Shift+p");
await page.waitForSelector(".palette input");
await page.fill(".palette input", "New file");
await page.keyboard.press("Enter");
await page.waitForSelector(".dialog input");
await page.fill(".dialog input", "probe.py");
await page.keyboard.press("Enter");
await page.click(".editor-host");
await page.evaluate((text) => {
  const el = document.querySelector(".editor-host .cm-content");
  if (!el) throw new Error("editor not found");
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, code);
await page.waitForTimeout(1500);
await page.keyboard.press("Control+Enter");
await page.waitForFunction(
  () => (document.getElementById("panel-body")?.innerText ?? "").includes("[done]"),
  undefined,
  { timeout: 300000, polling: 1000 },
);
const term = await page.evaluate(() => document.getElementById("panel-body")?.innerText ?? "");
console.log(term);
await browser.close();
