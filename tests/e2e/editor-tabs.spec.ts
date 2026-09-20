import { test, expect } from "@playwright/test";

// Regression: opening multiple files must show exactly ONE editor (the active
// tab). CodeMirror rewrites the editor element's class itself, so hiding must
// go through the editorAttributes facet — not inline styles/foreign classes.
test("switching between files shows exactly one editor", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
    } catch { /* ignore */ }
  });

  await page.goto("/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });

  const createFile = async (name: string, content?: string) => {
    await page.keyboard.press("Control+Shift+p");
    await page.waitForSelector(".palette input");
    await page.locator(".palette input").fill("New file");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".dialog input");
    await page.locator(".dialog input").fill(name);
    await page.keyboard.press("Enter");
    await expect(page.locator(".tab.active")).toContainText(name);
    if (content) {
      await page.locator(".editor-host").click();
      await page.keyboard.type(content, { delay: 2 });
      await page.waitForTimeout(1600); // autosave
    }
  };

  const open = async (name: string) => {
    await page.keyboard.press("Control+p");
    await page.locator(".palette input").fill(name);
    await page.locator(".palette-item").first().click();
    await page.waitForTimeout(500);
  };

  // Clean slate: the workspace starts empty (no starter files).
  const treeRows = await page.locator(".tree-row").count();
  expect(treeRows).toBe(0);

  await createFile("main.py", "print('main')\n");
  await createFile("notes.md", "# Notes\n");

  const assertSingle = async (active: string) => {
    const state = await page.evaluate(() => {
      const host = document.getElementById("editor-host")!;
      const hostTop = host.getBoundingClientRect().top;
      const editors = [...host.querySelectorAll<HTMLElement>(".cm-editor")];
      const visible = editors.filter((e) => getComputedStyle(e).display !== "none");
      return {
        active: document.querySelector(".tab.active .t-label")?.textContent ?? null,
        visible: visible.length,
        misplaced: visible.filter((e) => Math.abs(e.getBoundingClientRect().top - hostTop) > 2).length,
      };
    });
    expect(state.active).toBe(active);
    expect(state.visible).toBe(1);
    expect(state.misplaced).toBe(0);
  };

  await assertSingle("notes.md");

  // Back to the first file via the explorer, then via the tab strip.
  await page.locator(".tree-row", { hasText: "main.py" }).click();
  await page.waitForTimeout(500);
  await assertSingle("main.py");

  await page.locator(".tab", { hasText: "notes.md" }).click();
  await page.waitForTimeout(500);
  await assertSingle("notes.md");

  // Content of the active file is what's rendered.
  await expect(page.locator(".editor-host .cm-editor:visible .cm-content")).toContainText("Notes");
});
