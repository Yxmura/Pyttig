import { test, expect } from "@playwright/test";

// Exercises the *hosted* deployment shape: static dist + COOP/COEP headers +
// the /api/proxy serverless function (see scripts/vercel-sim.mjs). Proves
// isolation is active, the proxy is auto-detected, and clone + pull work
// through it — no launcher, no third-party proxy.
test("hosted deployment: isolate, detect proxy, clone and pull", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
    } catch { /* ignore */ }
  });

  await page.goto("http://127.0.0.1:8902/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });

  // Cross-origin isolation (stop button, interactive input, streaming).
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  // Serverless proxy auto-detected (query form: /api/proxy?<url>).
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __pyttigProxy?: string }).__pyttigProxy ?? null), {
      timeout: 15000,
    })
    .toContain("/api/proxy?");

  // Clone through the serverless proxy.
  await page.locator('.ab-btn[title="Source Control"]').click();
  await page.locator(".side-body .btn", { hasText: "Clone repository" }).click();
  await page.locator(".dialog input").fill("https://github.com/octocat/Hello-World.git");
  await page.keyboard.press("Enter");
  await page.locator(".dialog input").fill("hello-world");
  await page.keyboard.press("Enter");
  await expect(page.locator(".toasts")).toContainText("Cloned into", { timeout: 180000 });
  await page.locator(".dialog .btn.primary").click(); // use as project

  // Cloning lands in the Explorer with the repo revealed; Source Control
  // still has the minimal repo panel (regression: it used to toggle away).
  await expect(page.locator(".side-head")).toContainText("Explorer", { timeout: 30000 });
  await expect(page.locator(".tree-row.selected")).toContainText("hello-world");
  await page.locator('.ab-btn[title="Source Control"]').click();
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".side-body .git-remote")).toContainText("github.com/octocat/Hello-World");

  // Pull through the serverless proxy.
  await page.locator(".side-body .btn", { hasText: "Pull" }).click();
  await expect(page.locator(".toasts")).toContainText(/Pulled|latest/i, { timeout: 180000 });

  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});
