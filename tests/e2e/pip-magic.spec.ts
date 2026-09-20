import { test, expect } from "@playwright/test";

// Colab habit: `!pip install` inside the program. There is no real pip in the
// browser, so the line is routed to micropip and stripped from the code.
test("!pip install lines work in the runner", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
      localStorage.setItem("pyttig.ui.panelH", "620");
    } catch { /* ignore */ }
  });
  await page.goto("/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });

  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".palette input");
  await page.locator(".palette input").fill("New file");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".dialog input");
  await page.locator(".dialog input").fill("colab.py");
  await page.keyboard.press("Enter");
  await page.locator(".editor-host").click();
  // Paste (like a real user) — avoids auto-close quotes and dropped newlines
  // that keyboard.type/insertText suffer from in CodeMirror.
  await page.evaluate((text) => {
    const el = document.querySelector(".editor-host .cm-content");
    if (!el) throw new Error("editor not found");
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, "!pip install cowsay\nimport cowsay\nprint('pip magic ok')\n");
  await expect(page.locator(".editor-host .cm-content")).toContainText("!pip install cowsay");
  await page.waitForTimeout(1600);

  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#panel-body")).toContainText("[run] colab.py", { timeout: 30000 });
  await expect(page.locator("#panel-body")).toContainText("pip install cowsay", { timeout: 30000 });
  await expect(page.locator("#panel-body")).toContainText("pip magic ok", { timeout: 180000 });
  await expect(page.locator("#panel-body")).not.toContainText("SyntaxError");
});
