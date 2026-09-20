import { test, expect } from "@playwright/test";

// Regression for the reported bug: an open tab from an older deploy references
// a worker chunk that a rebuild has deleted. The feature used to hang
// ("nothing happens") — now it says so and offers a Reload, and recovers once
// the asset is available again.
test("stale tab: worker 404 explains itself and recovers", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
    } catch { /* ignore */ }
  });

  // Simulate the redeploy: the git worker chunk is gone (404).
  const killWorker = async (route: import("@playwright/test").Route) => {
    await route.fulfill({ status: 404, body: "not found" });
  };
  await page.route("**/assets/git.worker-*.js", killWorker);

  await page.goto("/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });

  await page.locator('.ab-btn[title="Source Control"]').click();
  await page.locator(".side-body .btn", { hasText: "Clone repository" }).click();
  await page.locator(".dialog input").fill("https://github.com/octocat/Hello-World.git");
  await page.keyboard.press("Enter");
  await page.locator(".dialog input").fill("hello-world");
  await page.keyboard.press("Enter");

  // Instead of hanging: a clear, actionable message.
  await expect(page.locator(".toasts")).toContainText(/updated while this tab was open|failed to start/i, {
    timeout: 30000,
  });
  await expect(page.locator(".toast .t-actions .btn", { hasText: "Reload" })).toHaveCount(1);

  // "Deploy" the worker again → the retry works.
  await page.unroute("**/assets/git.worker-*.js", killWorker);
  await page.locator(".side-body .btn", { hasText: "Clone repository" }).click();
  await page.locator(".dialog input").fill("https://github.com/octocat/Hello-World.git");
  await page.keyboard.press("Enter");
  await page.locator(".dialog input").fill("hello-world");
  await page.keyboard.press("Enter");
  await expect(page.locator(".toasts")).toContainText("Cloned into", { timeout: 180000 });
});

// Regression for the reported symptom: the worker file exists but the host
// serves it with a non-JavaScript MIME type. The browser refuses module
// workers in that case; Pyttig loads the same code from a blob instead, so
// cloning must simply work.
test("non-JS worker MIME type is worked around (blob fallback)", async ({ page }) => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const workerFile = readdirSync("dist/assets").find((f) => f.startsWith("git.worker-") && f.endsWith(".js"));
  if (!workerFile) throw new Error("git worker bundle not found in dist (run npm run build)");
  const workerCode = readFileSync(`dist/assets/${workerFile}`, "utf8");

  await page.route("**/assets/git.worker-*.js", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: workerCode }),
  );
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
    } catch { /* ignore */ }
  });

  await page.goto("/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });
  await page.locator('.ab-btn[title="Source Control"]').click();
  await page.locator(".side-body .btn", { hasText: "Clone repository" }).click();
  await page.locator(".dialog input").fill("https://github.com/octocat/Hello-World.git");
  await page.keyboard.press("Enter");
  await page.locator(".dialog input").fill("hello-world");
  await page.keyboard.press("Enter");

  await expect(page.locator(".toasts")).toContainText("Cloned into", { timeout: 180000 });
});
