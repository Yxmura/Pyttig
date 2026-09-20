// Turtle probe: runs a program through the UI and reports canvas + terminal.
//   PROBE_CODE_FILE=... PROBE_EXTRA_FILES=... node scripts/probe-turtle.mjs [--stop] [--key ArrowLeft]
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const code = process.env.PROBE_CODE_FILE
  ? readFileSync(process.env.PROBE_CODE_FILE, "utf-8")
  : "import turtle\nturtle.forward(100)\nturtle.done()\n";
const shouldStop = process.argv.includes("--stop");
const keyIndex = process.argv.indexOf("--key");
const key = keyIndex >= 0 ? process.argv[keyIndex + 1] : null;

const readTerminal = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll(".xterm-rows > div")].map((d) => d.textContent ?? "");
    return rows.join("\n").trim();
  });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (m) => console.log(`[console:${m.type()}]`, m.text().slice(0, 250)));
await page.goto("http://127.0.0.1:8765/");
await page.waitForSelector(".welcome-hero", { timeout: 20000 });

async function writeFile(name, text) {
  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".palette input");
  await page.fill(".palette input", "New file");
  await page.waitForSelector(".palette-item");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".dialog input");
  await page.fill(".dialog input", name);
  await page.keyboard.press("Enter");
  // the editor host already exists, so wait for the new tab before pasting
  await page.waitForFunction(
    (n) => document.querySelector(".tab.active")?.textContent?.includes(n),
    name,
    { timeout: 20000 },
  );
  await page.click(".editor-host");
  await page.evaluate((t) => {
    // several editors can live in the DOM; the hidden ones carry .editor-hidden
    const all = [...document.querySelectorAll(".editor-host .cm-content")];
    const el = all.find((e) => !e.closest(".editor-hidden")) ?? all[0];
    if (!el) throw new Error("editor not found");
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
  await page.waitForTimeout(1500);
}

for (const extra of (process.env.PROBE_EXTRA_FILES ?? "").split(",").filter(Boolean)) {
  await writeFile(extra.split(/[\\/]/).pop(), readFileSync(extra, "utf-8"));
}
await writeFile("turtle_test.py", code);

await page.keyboard.press("Control+Enter");
try {
  await page.waitForSelector("#game-host canvas", { timeout: 90000 });
} catch {
  await page.click('.panel-tab:has-text("Terminal")');
  console.log("no canvas; terminal:", await readTerminal(page));
  await browser.close();
  process.exit(1);
}

const inkOf = () =>
  page.evaluate(() => {
    const c = document.querySelector("#game-host canvas");
    if (!c || !c.width) return -1;
    const d = c.getContext("2d")?.getImageData(0, 0, c.width, c.height).data;
    if (!d) return -1;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) ink++;
    }
    return ink;
  });

let painted = false;
try {
  await page.waitForFunction(
    () => {
      const c = document.querySelector("#game-host canvas");
      if (!c || !c.width) return false;
      const d = c.getContext("2d")?.getImageData(0, 0, c.width, c.height).data;
      if (!d) return false;
      let ink = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) ink++;
      }
      return ink > 200;
    },
    undefined,
    { timeout: 90000, polling: 300 },
  );
  painted = true;
} catch {
  painted = false;
}
console.log("canvas painted:", painted);

if (key) {
  await page.click("#game-host canvas");
  await page.keyboard.press(key);
  await page.waitForTimeout(1500);
}

if (shouldStop) {
  await page.keyboard.press("Shift+F5");
  await page.waitForTimeout(2500);
} else {
  await page.waitForTimeout(3000);
}

const size = await page.evaluate(() => {
  const c = document.querySelector("#game-host canvas");
  return c ? { w: c.width, h: c.height } : null;
});
console.log("canvas:", JSON.stringify({ ...size, ink: await inkOf() }));

await page.click('.panel-tab:has-text("Terminal")');
console.log("terminal:", JSON.stringify((await readTerminal(page)).slice(0, 600)));
console.log("responsive:", await page.evaluate(() => 1 + 1));
await browser.close();
