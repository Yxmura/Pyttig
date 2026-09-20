import { test, expect } from "@playwright/test";

// The classroom flow: an exercise repo (or task) with a requirements.txt,
// one-click install, then run — no setup knowledge needed.
test("requirements.txt install and run", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
    } catch { /* ignore */ }
  });
  await page.goto("/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });

  const newFile = async (name: string, content: string) => {
    await page.keyboard.press("Control+Shift+p");
    await page.waitForSelector(".palette input");
    await page.locator(".palette input").fill("New file");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".dialog input");
    await page.locator(".dialog input").fill(name);
    await page.keyboard.press("Enter");
    await expect(page.locator(".tab.active")).toContainText(name);
    await page.locator(".editor-host").click();
    await page.keyboard.type(content, { delay: 2 });
    await page.waitForTimeout(1600); // autosave
  };

  await newFile("requirements.txt", "# exercise deps\ncowsay==6.1\n");
  await newFile("main.py", "import cowsay\nprint('exercise ran')\n");

  // Install via the command (what the post-clone prompt uses underneath).
  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".palette input");
  await page.locator(".palette input").fill("Install from requirements");
  await page.keyboard.press("Enter");
  await expect(page.locator(".toasts")).toContainText(/Installed 1 package/i, { timeout: 180000 });

  // Ctrl+Enter runs the file (Chromebook-friendly: no F-keys).
  await page.locator(".editor-host").click();
  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#panel-body")).toContainText("exercise ran", { timeout: 180000 });
  await expect(page.locator("#panel-body")).not.toContainText("ModuleNotFoundError");
});
