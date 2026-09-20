import { chromium } from "@playwright/test";

import { readFileSync } from "node:fs";
const code = process.env.PROBE_CODE_FILE
  ? readFileSync(process.env.PROBE_CODE_FILE, "utf-8")
  : process.argv[2] ?? "print('hi')";
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
const waitMs = Number(process.env.PROBE_WAIT ?? 300000);
const deadline = Date.now() + waitMs;
while (Date.now() < deadline) {
  const t = await page.evaluate(() => document.getElementById("panel-body")?.innerText ?? "");
  if (t.includes("[done]")) break;
  await page.waitForTimeout(1000);
}
const term = await page.evaluate(() => document.getElementById("panel-body")?.innerText ?? "");
console.log(term);
await browser.close();
