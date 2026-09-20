import { test, expect } from "@playwright/test";

// Installs must survive a reload: the worker's filesystem dies with it, so the
// client remembers what was installed and quietly restores it on the next boot.
test("installed packages are restored after a reload", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
      localStorage.setItem("pyttig.ui.panelH", "620");
    } catch { /* ignore */ }
  });
  await page.goto("/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });

  await page.click('.ab-btn[title="Packages"]');
  await page.waitForSelector(".search-box input");
  await page.fill(".search-box input", "cowsay");
  await page.click(".search-box .btn.primary");
  await expect(page.locator(".toasts")).toContainText(/Installed: cowsay/, { timeout: 120000 });
  // the installed list now shows it (and the view no longer crashes)
  await expect(page.locator(".pkg-row", { hasText: "cowsay" })).toBeVisible({ timeout: 30000 });

  await page.reload();
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });

  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".palette input");
  await page.fill(".palette input", "New file");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".dialog input");
  await page.fill(".dialog input", "restored.py");
  await page.keyboard.press("Enter");
  await page.click(".editor-host");
  await page.evaluate(() => {
    const el = document.querySelector(".editor-host .cm-content");
    if (!el) throw new Error("editor not found");
    const dt = new DataTransfer();
    dt.setData("text/plain", "import cowsay\nprint('cowsay came back')\n");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator(".editor-host .cm-content")).toContainText("import cowsay");
  await page.waitForTimeout(1500);

  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#panel-body")).toContainText("cowsay came back", { timeout: 90000 });
  await expect(page.locator("#panel-body")).not.toContainText("ModuleNotFoundError");
});

// Some pure-Python packages only ship a source tarball. The runtime builds
// those in-process (no compiler involved) instead of giving up.
test("source-only packages install by building their sdist", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
      localStorage.setItem("pyttig.ui.panelH", "620");
    } catch { /* ignore */ }
  });
  await page.goto("/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });

  await page.click('.ab-btn[title="Packages"]');
  await page.waitForSelector(".search-box input");
  await page.fill(".search-box input", "hurry.filesize");
  await page.click(".search-box .btn.primary");
  await expect(page.locator(".toasts")).toContainText(/Installed: hurry.filesize/, { timeout: 180000 });

  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".palette input");
  await page.fill(".palette input", "New file");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".dialog input");
  await page.fill(".dialog input", "sdist_check.py");
  await page.keyboard.press("Enter");
  await page.click(".editor-host");
  await page.evaluate(() => {
    const el = document.querySelector(".editor-host .cm-content");
    if (!el) throw new Error("editor not found");
    const dt = new DataTransfer();
    dt.setData("text/plain", "from hurry.filesize import size\nprint('built here:', size(1234567))\n");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator(".editor-host .cm-content")).toContainText("hurry.filesize");
  await page.waitForTimeout(1500);

  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#panel-body")).toContainText("built here:", { timeout: 90000 });
  await expect(page.locator("#panel-body")).not.toContainText("ModuleNotFoundError");
});
