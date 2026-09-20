import { test, expect } from "@playwright/test";

// Deterministic: no background preload (packages are covered manually).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
    } catch { /* ignore */ }
  });
});

test("boot, edit, run Python, lint, complete, git panel", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });

  await page.goto("/");
  await expect(page).toHaveTitle(/Pyttig/);
  await expect(page.locator(".brand")).toContainText("Pyttig");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });

  // Clean slate: no starter files — create main.py ourselves.
  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".palette input");
  await page.locator(".palette input").fill("New file");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".dialog input");
  await page.locator(".dialog input").fill("main.py");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tab.active")).toContainText("main.py");

  // Replace with a tiny program.
  await page.locator(".editor-host").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("print(2 + 2)\n", { delay: 2 });
  await page.waitForTimeout(1800);

  // Run it (Pyodide downloads on first use).
  await page.keyboard.press("F5");
  await expect(page.locator("#panel-body")).toContainText("— run main.py", { timeout: 30000 });
  await expect(page.locator("#panel-body")).toContainText("— done —", { timeout: 180000 });
  await expect(page.locator("#panel-body")).toContainText("4");

  // Lint: unused import → Problems badge.
  await page.locator(".editor-host").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("import os\n", { delay: 2 });
  await expect(page.locator('.panel-tab', { hasText: "Problems" })).toContainText(/Problems\s*\d+/, { timeout: 60000 });

  // Jedi completion after "os.".
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("import os\nos.", { delay: 2 });
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toBeVisible({ timeout: 120000 });

  // Git: the minimal Source Control view offers clone-only when no repo exists.
  await page.locator('.ab-btn[title="Source Control"]').click();
  await expect(page.locator(".side-body")).toContainText("Clone repository", { timeout: 15000 });
  await expect(page.locator(".side-body")).not.toContainText("Commit");

  await page.screenshot({ path: "tests/e2e/shot.png" });

  const fatal = errors.filter((e) => !/favicon/i.test(e));
  expect(fatal).toEqual([]);
});
