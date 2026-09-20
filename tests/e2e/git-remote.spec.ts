import { test, expect } from "@playwright/test";

// Proves remote git works: clone + pull from GitHub through the
// launcher-provided CORS proxy (fully local, no third-party proxy).
// The git surface is intentionally minimal: clone / pull / fetch / branch.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
    } catch { /* ignore */ }
  });
});

test("clone and pull a public repo via launcher proxy", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto("/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });
  await page.locator('.ab-btn[title="Source Control"]').click();

  // Minimal surface: no commit UI anywhere.
  await expect(page.locator(".side-body")).not.toContainText("Commit");

  // Clone octocat/Hello-World (tiny fixture repo).
  await page.locator(".side-body .btn", { hasText: "Clone repository" }).click();
  await page.locator(".dialog input").fill("https://github.com/octocat/Hello-World.git");
  await page.keyboard.press("Enter");
  await page.locator(".dialog input").fill("hello-world");
  await page.keyboard.press("Enter");
  await expect(page.locator(".toasts")).toContainText("Cloned into", { timeout: 180000 });
  // Use the clone as the git project.
  await page.locator(".dialog .btn.primary").click();

  // After cloning we land in the Explorer with the repo revealed.
  await expect(page.locator(".side-head")).toContainText("Explorer", { timeout: 30000 });
  await expect(page.locator(".tree")).toContainText("hello-world", { timeout: 30000 });
  await expect(page.locator(".tree-row.selected")).toContainText("hello-world");
  await page.locator(".tree-row", { hasText: "hello-world" }).click();
  await expect(page.locator(".tree")).toContainText("README", { timeout: 30000 });

  // Source Control still shows the repo panel: name, branch chip, remote URL.
  await page.locator('.ab-btn[title="Source Control"]').click();
  await expect(page.locator(".side-body")).toContainText("hello-world", { timeout: 30000 });
  await expect(page.locator(".side-body .git-branch")).toContainText(/master|main/, { timeout: 30000 });
  await expect(page.locator(".side-body .git-remote")).toContainText("github.com/octocat/Hello-World");

  // Pull (exercises fetch+merge against the remote; repo is static so it's a no-op).
  // NOTE: Source Control may already be active — go via Explorer first so the
  // icon click always *shows* the sidebar instead of toggling it away.
  await page.locator('.ab-btn[title="Explorer"]').click();
  await page.locator('.ab-btn[title="Source Control"]').click();
  await page.locator(".side-body .btn", { hasText: "Pull" }).click();
  // No author prompts in the minimal flow — pull goes straight through.
  await expect(page.locator(".toasts")).toContainText(/Pulled|latest/i, { timeout: 180000 });

  const fatal = errors.filter((e) => !/favicon/i.test(e));
  expect(fatal).toEqual([]);
});
