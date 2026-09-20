import { describe, expect, it } from "vitest";
import { looksLikeGame } from "../../src/runtime/gameDetect";

describe("looksLikeGame", () => {
  it("detects the lesson-style pygame programs", () => {
    expect(looksLikeGame("import pygame\npygame.init()\nscreen = pygame.display.set_mode((200, 50))")).toBe(true);
    expect(looksLikeGame("import pygame\nclock = pygame.time.Clock()\nwhile True:\n    pass")).toBe(true);
    expect(looksLikeGame("from pygame.locals import QUIT\nimport pygame\ndisplay = pygame.display")).toBe(true);
  });

  it("leaves headless pygame helpers and other code to the worker", () => {
    expect(looksLikeGame("import pygame\nprint(pygame.version.ver)")).toBe(false);
    expect(looksLikeGame("import pygame\nprint(pygame.Color(1, 2, 3))")).toBe(false);
    expect(looksLikeGame("import numpy as np\nprint(np.zeros(3))")).toBe(false);
    expect(looksLikeGame("print('pygame is mentioned in a string')")).toBe(false);
  });
});
