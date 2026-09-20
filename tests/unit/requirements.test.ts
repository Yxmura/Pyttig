import { describe, expect, it } from "vitest";
import { parseRequirements, splitRequirements } from "../../src/runtime/requirements";

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

describe("splitRequirements", () => {
  it("drops notebook plumbing from Colab-frozen files", () => {
    const { install, skipped } = splitRequirements([
      "jupyter", "ipykernel", "pexpect", "ptyprocess", "appnope", "matplotlib-inline",
      "pygame", "requests", "numpy", "soupsieve",
    ]);
    expect(install).toEqual(["pygame", "requests", "numpy"]);
    expect(skipped).toContain("jupyter");
    expect(skipped).toContain("pexpect");
  });

  it("keeps everything when nothing is notebook-only", () => {
    const { install, skipped } = splitRequirements(["pandas", "flask"]);
    expect(install).toEqual(["pandas", "flask"]);
    expect(skipped).toEqual([]);
  });
});
