import { describe, expect, it } from "vitest";
import { looksLikeGame, usesTurtle } from "../../src/runtime/gameDetect";

describe("looksLikeGame", () => {
  it("detects the lesson-style pygame programs", () => {
    expect(looksLikeGame("import pygame\npygame.init()\nscreen = pygame.display.set_mode((200, 50))")).toBe(true);
    expect(looksLikeGame("import pygame\nclock = pygame.time.Clock()\nwhile True:\n    pass")).toBe(true);
    expect(looksLikeGame("from pygame.locals import QUIT\nimport pygame\ndisplay = pygame.display")).toBe(true);
  });

  it("sends turtle programs to the game runtime", () => {
    expect(looksLikeGame("import turtle\nturtle.forward(100)\nturtle.done()")).toBe(true);
    expect(looksLikeGame("from turtle import *\nfor i in range(4): forward(50)")).toBe(true);
  });

  it("leaves headless pygame helpers and other code to the worker", () => {
    expect(looksLikeGame("import pygame\nprint(pygame.version.ver)")).toBe(false);
    expect(looksLikeGame("import pygame\nprint(pygame.Color(1, 2, 3))")).toBe(false);
    expect(looksLikeGame("import numpy as np\nprint(np.zeros(3))")).toBe(false);
    expect(looksLikeGame("print('pygame is mentioned in a string')")).toBe(false);
  });
});

describe("usesTurtle", () => {
  it("follows local imports one level deep", () => {
    const files = [
      { path: "sterren_module.py", content: "import turtle\n\ndef teken_ster(x, y):\n    pass\n" },
      { path: "helper.py", content: "import math\n" },
    ];
    expect(usesTurtle("from sterren_module import *\n", files)).toBe(true);
    expect(usesTurtle("import helper\n", files)).toBe(false);
    expect(usesTurtle("import turtle\n", [])).toBe(true);
  });

  it("matches files in subfolders", () => {
    const files = [{ path: "startcode/schat.py", content: "import turtle\n" }];
    expect(usesTurtle("from schat import Schat\n", files)).toBe(true);
  });
});
