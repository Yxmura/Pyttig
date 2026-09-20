import { describe, expect, it } from "vitest";
import { parseRequirements } from "../../src/runtime/requirements";

describe("parseRequirements", () => {
  it("handles the usual shapes", () => {
    const text = [
      "# exercises deps",
      "",
      "cowsay",
      "requests==2.33.1",
      "beautifulsoup4>=4.12",
      "pandas ; python_version >= '3.9'",
      "rich  # console output",
      "-r other.txt",
      "--index-url https://example.com/simple",
      "pytest",
      "cowsay",
    ].join("\n");
    expect(parseRequirements(text)).toEqual([
      "cowsay",
      "requests",
      "beautifulsoup4",
      "pandas",
      "rich",
      "pytest",
    ]);
  });

  it("tolerates junk and empty files", () => {
    expect(parseRequirements("")).toEqual([]);
    expect(parseRequirements("\n\n   \n# only comments\n")).toEqual([]);
    expect(parseRequirements("   ???   ")).toEqual([]);
  });

  it("keeps names with dots, dashes and underscores", () => {
    expect(parseRequirements("ruamel.yaml\npython-dateutil\npillow_heif")).toEqual([
      "ruamel.yaml",
      "python-dateutil",
      "pillow_heif",
    ]);
  });
});
