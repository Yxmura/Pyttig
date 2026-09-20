import { test, expect } from "@playwright/test";

// Each test loads a main-thread Pyodide with pygame, so run them one at a
// time instead of competing for memory and CPU.
test.describe.configure({ mode: "serial" });

// turtle needs Tkinter, which cannot exist in a browser, so Pyttig ships a
// pygame-based turtle that draws on the game canvas. These tests cover the
// shapes real lessons use: module-level drawing, fills, a local module that
// imports turtle, done()/mainloop() and key handlers.

async function writeFile(page: import("@playwright/test").Page, name: string, content: string) {
  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".palette input");
  await page.locator(".palette input").fill("New file");
  await page.waitForSelector(".palette-item");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".dialog input");
  await page.locator(".dialog input").fill(name);
  await page.keyboard.press("Enter");
  // Wait for the new tab before typing: the editor host exists already, so
  // pasting too early lands in the previous file.
  await expect(page.locator(".tab.active")).toContainText(name, { timeout: 15000 });
  await page.locator(".editor-host:visible").click();
  await page.evaluate((text) => {
    // several editors can live in the DOM; the hidden ones carry .editor-hidden
    const all = [...document.querySelectorAll(".editor-host .cm-content")];
    const el = all.find((e) => !e.closest(".editor-hidden")) ?? all[0];
    if (!el) throw new Error("editor not found");
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, content);
  const marker = content.split("\n").find((l) => l.trim().length > 4) ?? name;
  await expect(page.locator(".editor-host .cm-content:visible")).toContainText(marker.trim().slice(0, 24));
  await page.waitForTimeout(1600); // autosave
}

function canvasInk(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const c = document.querySelector("#game-host canvas") as HTMLCanvasElement | null;
    if (!c || !c.width) return -1;
    const d = c.getContext("2d")?.getImageData(0, 0, c.width, c.height).data;
    if (!d) return -1;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) ink++;
    }
    return ink;
  });
}

test("turtle draws on the game canvas and done() keeps it open", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
      localStorage.setItem("pyttig.ui.panelH", "620");
    } catch { /* ignore */ }
  });
  await page.goto("/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });

  await writeFile(
    page,
    "vierkant.py",
    `import turtle

turtle.speed(0)
for _ in range(4):
    turtle.forward(120)
    turtle.left(90)

turtle.done()
`,
  );
  await page.keyboard.press("Control+Enter");

  await expect(page.locator("#game-host canvas")).toBeVisible({ timeout: 90000 });
  await expect.poll(() => canvasInk(page), { timeout: 60000, intervals: [300] }).toBeGreaterThan(200);
  expect(await page.evaluate(() => 1 + 1)).toBe(2); // responsive while waiting in done()

  // Stop ends done() without a reload
  await page.keyboard.press("Shift+F5");
  await page.locator('.panel-tab:has-text("Terminal")').click();
  await expect(page.locator("#panel-body")).toContainText("[stopped]", { timeout: 20000 });
});

test("a lesson module that imports turtle is detected through the import", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
      localStorage.setItem("pyttig.ui.panelH", "620");
    } catch { /* ignore */ }
  });
  await page.goto("/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });

  await writeFile(
    page,
    "sterren_module.py",
    `import turtle

def teken_ster(x, y, kleur="yellow"):
    turtle.penup()
    turtle.goto(x, y)
    turtle.pendown()
    turtle.fillcolor(kleur)
    turtle.begin_fill()
    for _ in range(5):
        turtle.forward(60)
        turtle.right(144)
    turtle.end_fill()
`,
  );
  await writeFile(
    page,
    "sterrenhemel.py",
    `from sterren_module import *

turtle.speed(0)
teken_ster(-80, 40)
teken_ster(80, -40, "skyblue")
turtle.hideturtle()
turtle.done()
`,
  );
  await page.keyboard.press("Control+Enter");

  await expect(page.locator("#game-host canvas")).toBeVisible({ timeout: 90000 });
  await expect.poll(() => canvasInk(page), { timeout: 60000, intervals: [300] }).toBeGreaterThan(500);
  await expect(page.locator("#panel-body")).not.toContainText("tkinter");
});

test("key handlers work while the turtle window is open", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pyttig.settings.v1", JSON.stringify({ preloadStack: false }));
      localStorage.setItem("pyttig.ui.panelH", "620");
    } catch { /* ignore */ }
  });
  await page.goto("/");
  await expect(page.locator(".welcome-hero")).toBeVisible({ timeout: 15000 });

  await writeFile(
    page,
    "schat.py",
    `import turtle

scherm = turtle.Screen()
scherm.title("Schattenjacht")
scherm.bgcolor("skyblue")
speler = turtle.Turtle()
speler.shape("turtle")
speler.penup()

def beweeg(richting, graden):
    speler.setheading(graden)
    speler.forward(20)
    print("beweeg:", richting)

scherm.listen()
scherm.onkey(lambda: beweeg("links", 180), "Left")
scherm.onkey(lambda: beweeg("rechts", 0), "Right")

scherm.mainloop()
`,
  );
  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#game-host canvas")).toBeVisible({ timeout: 90000 });

  // the canvas must be focused for SDL-style key events
  await page.locator("#game-host canvas").click();
  await page.keyboard.press("ArrowLeft");
  await page.locator('.panel-tab:has-text("Terminal")').click();
  await expect(page.locator("#panel-body")).toContainText("beweeg: links", { timeout: 20000 });

  await page.keyboard.press("Shift+F5");
  await expect(page.locator("#panel-body")).toContainText("[stopped]", { timeout: 20000 });
});
