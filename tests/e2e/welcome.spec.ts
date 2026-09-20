import { test, expect } from "@playwright/test";

// The start screen must be there whenever nothing is open — on first boot,
// after a refresh, and after the last tab is closed. (Regression: it could
// silently disappear after a refresh.)
test("start screen persists across refresh and tab close", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
    } catch { /* ignore */ }
  });

  await page.goto("/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });

  await page.reload();
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });

  // Create a file, then close its tab — welcome must come back.
  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".palette input");
  await page.locator(".palette input").fill("New file");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".dialog input");
  await page.locator(".dialog input").fill("hello.py");
  await page.keyboard.press("Enter");
  await expect(page.locator(".welcome-hero")).toHaveCount(0);

  await page.locator(".tab .t-close").click();
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 10000 });
});

// Regression: boot must not depend on network probes. A hung /api/proxy probe
// (or a host where it never answers) used to block startup entirely.
test("start screen appears even when the proxy probe hangs", async ({ page }) => {
  // Pretend to be a plain static host: strip the launcher marker so the app
  // falls back to probing /api/proxy.
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() === "document") {
      const res = await route.fetch();
      const body = (await res.text()).replace(/<meta name="pyttig-launcher"[^>]*>/, "");
      await route.fulfill({ response: res, body });
    } else {
      await route.continue();
    }
  });
  await page.route("**/api/proxy", () => {
    /* never fulfilled */
  });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
    } catch { /* ignore */ }
  });

  await page.goto("/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  // Boot finishes shortly after (the probe times out at 1.5s).
  await expect
    .poll(() => page.evaluate(() => window.__pyttigBooted === true), { timeout: 15000 })
    .toBe(true);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});
