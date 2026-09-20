import { describe, expect, it } from "vitest";
import { resolvePackageName, isAliased, aliasNote } from "../../src/runtime/packageAliases";

describe("resolvePackageName", () => {
  it("maps import names to what Pyodide ships", () => {
    expect(resolvePackageName("pygame")).toBe("pygame-ce");
    expect(resolvePackageName("PIL")).toBe("pillow");
    expect(resolvePackageName("bs4")).toBe("beautifulsoup4");
    expect(resolvePackageName("sklearn")).toBe("scikit-learn");
    expect(resolvePackageName("cv2")).toBe("opencv-python");
    expect(resolvePackageName("discord")).toBe("discord.py");
  });

  it("keeps real package names and case", () => {
    expect(resolvePackageName("numpy")).toBe("numpy");
    expect(resolvePackageName("Requests")).toBe("Requests");
    expect(resolvePackageName("  pandas  ")).toBe("pandas");
  });

  it("reports whether a rewrite happened", () => {
    expect(isAliased("pygame")).toBe(true);
    expect(isAliased("numpy")).toBe(false);
    expect(aliasNote("PIL")).toBe("PIL → pillow");
    expect(aliasNote("flask")).toBeNull();
  });
});
