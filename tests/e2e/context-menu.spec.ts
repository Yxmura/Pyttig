import { test, expect } from "@playwright/test";

test("explorer context menu", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
    } catch { /* ignore */ }
  });
  await page.goto("/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });

  // create a file first
  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".palette input");
  await page.locator(".palette input").fill("New file");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".dialog input");
  await page.locator(".dialog input").fill("ctx.py");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tab.active")).toContainText("ctx.py");

  // right-click the tree row
  await page.locator(".tree-row", { hasText: "ctx.py" }).click({ button: "right" });
  const menu = page.locator(".ctx-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Open");
  await expect(menu).toContainText("New File…");
  await expect(menu).toContainText("Rename…");
  await expect(menu).toContainText("Delete");
  await expect(menu).toContainText("Download");
  await expect(menu).toContainText("Copy Path");
  // the row got selected
  await expect(page.locator(".tree-row.selected")).toContainText("ctx.py");

  // rename via the menu
  await menu.locator(".ctx-item", { hasText: "Rename…" }).click();
  await expect(page.locator(".dialog h3")).toContainText("Rename");
  await page.keyboard.press("Escape");
  await expect(page.locator(".ctx-menu")).toHaveCount(0);

  // background right-click (empty area below the tree, inside the sidebar)
  await page.locator(".side-body").click({ button: "right", position: { x: 60, y: 340 } });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await expect(page.locator(".ctx-menu")).toContainText("Upload Files…");
  await expect(page.locator(".ctx-menu")).toContainText("Reset Workspace…");

  // closes when clicking elsewhere
  await page.locator(".editor-host").click();
  await expect(page.locator(".ctx-menu")).toHaveCount(0);
});

test("editor context menu", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
    } catch { /* ignore */ }
  });
  await page.goto("/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });
  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".palette input");
  await page.locator(".palette input").fill("New file");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".dialog input");
  await page.locator(".dialog input").fill("menu.py");
  await page.keyboard.press("Enter");
  await page.locator(".editor-host").click();
  await page.keyboard.type("x = 1\ny = 2\n", { delay: 2 });
  await page.waitForTimeout(1200);

  // no selection: edit items that need one are disabled
  await page.locator(".editor-host").click({ button: "right" });
  const menu = page.locator(".ctx-menu");
  await expect(menu).toBeVisible();
  for (const label of ["Undo", "Redo", "Cut", "Copy", "Paste", "Go to Definition", "Find References", "Rename Symbol", "Format Document", "Command Palette…"]) {
    await expect(menu.locator(".ctx-item", { hasText: label })).toHaveCount(1);
  }
  await expect(menu.locator(".ctx-item", { hasText: "Cut" })).toBeDisabled();
  await expect(menu.locator(".ctx-item", { hasText: "Go to Definition" })).toBeEnabled();

  // keyboard navigation: moving the pointer away clears the hover highlight,
  // then ArrowUp selects the last item and Escape closes.
  await page.mouse.move(5, 5);
  await page.keyboard.press("ArrowUp");
  await expect(menu.locator(".ctx-item.selected")).toContainText("Command Palette");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // selecting text enables Cut/Copy, and the palette item opens the palette
  await page.locator(".editor-host").click();
  await page.keyboard.press("Control+a");
  await page.locator(".editor-host").click({ button: "right" });
  await expect(page.locator(".ctx-menu .ctx-item", { hasText: "Cut" })).toBeEnabled();
  await page.locator(".ctx-menu .ctx-item", { hasText: "Command Palette…" }).click();
  await expect(page.locator(".palette input")).toBeVisible();
  await page.keyboard.press("Escape");

  // non-python files disable LSP actions
  await page.locator(".editor-host").click();
  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".palette input");
  await page.locator(".palette input").fill("New file");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".dialog input");
  await page.locator(".dialog input").fill("notes.txt");
  await page.keyboard.press("Enter");
  await page.locator(".editor-host").click({ button: "right" });
  await expect(page.locator(".ctx-menu .ctx-item", { hasText: "Format Document" })).toBeDisabled();
});
