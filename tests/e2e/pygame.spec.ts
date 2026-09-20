import { test, expect } from "@playwright/test";

// pygame programs run on a main-thread runtime with a real canvas: Pyodide's
// SDL support needs the main thread, and the game loop is rewritten to yield
// between frames (a plain `while True:` + clock.tick(60) would freeze the tab).

const GAME = `
import pygame, sys

pygame.init()
screen = pygame.display.set_mode((160, 120))
clock = pygame.time.Clock()

frames = 0
while True:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            sys.exit()
    screen.fill((12, 24, 36))
    pygame.draw.circle(screen, (220, 80, 60), (80, 60), 24)
    pygame.display.update()
    clock.tick(60)
    frames += 1
    if frames >= 5:
        break

print("game frames", frames)
`;

async function createFile(page: import("@playwright/test").Page, name: string, content: string) {
  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".palette input");
  await page.locator(".palette input").fill("New file");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".dialog input");
  await page.locator(".dialog input").fill(name);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".editor-host .cm-content", { timeout: 15000 });
  await page.locator(".editor-host").click();
  await page.evaluate((text) => {
    const el = document.querySelector(".editor-host .cm-content");
    if (!el) throw new Error("editor not found");
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, content);
  await expect(page.locator(".editor-host .cm-content")).toContainText("pygame");
  await page.waitForTimeout(1600); // autosave
}

function canvasHasPixels(page: import("@playwright/test").Page, minRed = 1) {
  return page.evaluate((wanted) => {
    const c = document.querySelector("#game-host canvas") as HTMLCanvasElement | null;
    if (!c || !c.width) return false;
    const d = c.getContext("2d")?.getImageData(0, 0, c.width, c.height).data;
    if (!d) return false;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 150 && d[i + 1] < 120 && d[i + 2] < 120) red++;
    }
    return red >= wanted;
  }, minRed);
}

test("pygame programs open a real window", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
      localStorage.setItem("pyttig.ui.panelH", "620");
    } catch { /* ignore */ }
  });
  await page.goto("/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });

  await createFile(page, "game.py", GAME);
  await page.keyboard.press("Control+Enter");

  // the Game panel takes over the bottom panel and holds a canvas
  await expect(page.locator("#game-host canvas")).toBeVisible({ timeout: 60000 });
  await expect
    .poll(() => canvasHasPixels(page), { timeout: 60000, intervals: [300] })
    .toBe(true);

  // the program finished and said so (canvas stays with the last frame)
  await page.locator('.panel-tab:has-text("Terminal")').click();
  await expect(page.locator("#panel-body")).toContainText("game frames 5", { timeout: 30000 });
  await expect(page.locator("#panel-body")).toContainText("[done]");
  await expect(page.locator("#panel-body")).not.toContainText("Traceback");

  // switching panels must bring the canvas back with it
  await page.locator('.panel-tab:has-text("Game")').click();
  await expect(page.locator("#game-host canvas")).toBeVisible();
});

test("a looping game stays responsive and can be stopped", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
      localStorage.setItem("pyttig.ui.panelH", "620");
    } catch { /* ignore */ }
  });
  await page.goto("/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });

  const looping = `
import pygame, sys

pygame.init()
screen = pygame.display.set_mode((200, 140))
clock = pygame.time.Clock()

while True:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            pygame.quit()
            sys.exit()
        if event.type == pygame.KEYDOWN:
            print("key:", pygame.key.name(event.key))
    screen.fill((18, 28, 38))
    pygame.draw.rect(screen, (220, 80, 60), (20, 20, 60, 40))
    pygame.display.update()
    clock.tick(60)
`;
  await createFile(page, "loop_game.py", looping);
  await page.keyboard.press("Control+Enter");

  await expect(page.locator("#game-host canvas")).toBeVisible({ timeout: 60000 });
  await expect
    .poll(() => canvasHasPixels(page), { timeout: 60000, intervals: [300] })
    .toBe(true);

  // the browser must still be usable while the game runs
  await expect(page.locator(".editor-host")).toBeVisible();
  expect(await page.evaluate(() => 1 + 1)).toBe(2);

  // keyboard events reach the canvas-backed SDL window
  await page.locator("#game-host canvas").click();
  await page.keyboard.press("a");
  await page.locator('.panel-tab:has-text("Terminal")').click();
  await expect(page.locator("#panel-body")).toContainText("key: a", { timeout: 20000 });

  // Stop ends the loop without reloading the page (terminal focused on purpose:
  // the shortcut must work there too)
  await page.keyboard.press("Shift+F5");
  await expect(page.locator("#panel-body")).toContainText("[stopped]", { timeout: 20000 });
  expect(await page.evaluate(() => 1 + 1)).toBe(2);
});
