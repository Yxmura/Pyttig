import { describe, expect, it } from "vitest";
import { formatBytes, totalOf } from "../../src/app/memory";

describe("formatBytes", () => {
  it("formats MB and GB", () => {
    expect(formatBytes(64 * 1024 ** 2)).toBe("64 MB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
    expect(formatBytes(12 * 1024 ** 2)).toBe("12 MB");
    expect(formatBytes(4.2 * 1024 ** 2)).toBe("4.2 MB");
    expect(formatBytes(0)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("totalOf", () => {
  it("sums the parts", () => {
    expect(totalOf({ app: 40, python: 120, ruff: 20 })).toBe(180);
    expect(totalOf({ python: 120 })).toBe(120);
    expect(totalOf({})).toBe(0);
  });
});
