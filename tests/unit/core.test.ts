import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "../../src/app/commands";
import { statusLetter, isStaged } from "../../src/git/client";
import { ruffSeverity } from "../../src/lsp/ruffClient";
import { outlineSymbols } from "../../src/lsp/outline";

describe("fuzzyMatch", () => {
  it("matches empty query", () => {
    expect(fuzzyMatch("", "anything").hit).toBe(true);
  });
  it("matches subsequences", () => {
    expect(fuzzyMatch("fb", "foo/bar.py").hit).toBe(true);
    expect(fuzzyMatch("fb", "zzz").hit).toBe(false);
  });
  it("prefers boundary matches", () => {
    const a = fuzzyMatch("mp", "main.py");
    const b = fuzzyMatch("mp", "xmpz");
    expect(a.hit && b.hit).toBe(true);
    expect(a.score).toBeGreaterThan(b.score);
  });
});

describe("statusLetter", () => {
  it("maps matrix rows to VS Code-like letters", () => {
    expect(statusLetter(["f.py", 0, 0, 0])).toBe("D"); // deleted in workdir
    expect(statusLetter(["f.py", 0, 2, 0])).toBe("U"); // untracked
    expect(statusLetter(["f.py", 0, 2, 3])).toBe("A"); // added to index
    expect(statusLetter(["f.py", 1, 2, 2])).toBe("M"); // modified
    expect(statusLetter(["f.py", 1, 1, 1])).toBeNull(); // clean
  });
  it("detects staged rows", () => {
    expect(isStaged(["f.py", 1, 1, 2])).toBe(true);
    expect(isStaged(["f.py", 1, 2, 1])).toBe(false);
  });
});

describe("ruffSeverity", () => {
  it("maps codes to severities", () => {
    expect(ruffSeverity("E999")).toBe("error");
    expect(ruffSeverity("F821")).toBe("error");
    expect(ruffSeverity("F401")).toBe("warning");
    expect(ruffSeverity("E501")).toBe("warning");
    expect(ruffSeverity("I001")).toBe("info");
    expect(ruffSeverity(null)).toBe("info");
  });
});

describe("outlineSymbols", () => {
  it("finds classes and functions with 1-based lines", () => {
    const code = '"""doc"""\nimport os\n\n\nclass Foo:\n    def method(self):\n        pass\n\n\nasync def main():\n    pass\n';
    const syms = outlineSymbols("file:///workspace/a.py", code);
    expect(syms.map((s) => s.name)).toEqual(["Foo", "method", "main"]);
    expect(syms[0].kind).toBe(5);
    expect(syms[0].location.range.start.line).toBe(4);
    expect(syms[2].location.range.start.line).toBe(9);
  });
  it("ignores non-definitions", () => {
    expect(outlineSymbols("u", "x = 1\nprint(x)\n")).toEqual([]);
  });
});
