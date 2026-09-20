import { describe, expect, it } from "vitest";
import { extractPipInstalls } from "../../src/runtime/pipLines";

describe("extractPipInstalls", () => {
  it("extracts packages and neutralises the lines", () => {
    const { packages, code } = extractPipInstalls(
      ["!pip install cowsay", "import cowsay", "%pip install requests==2.33.1 rich", "print('hi')"].join("\n"),
    );
    expect(packages).toEqual(["cowsay", "requests==2.33.1", "rich"]);
    expect(code.split("\n")[0]).toBe("# !pip install cowsay");
    expect(code.split("\n")[2]).toBe("# %pip install requests==2.33.1 rich");
    // line count is unchanged so tracebacks still point at the right lines
    expect(code.split("\n")).toHaveLength(4);
  });

  it("skips flags and dedupes", () => {
    const { packages } = extractPipInstalls("!pip install -q --no-cache cowsay cowsay\n!pip install -U rich");
    expect(packages).toEqual(["cowsay", "rich"]);
  });

  it("ignores other pip subcommands and plain code", () => {
    const src = ["!pip uninstall cowsay", "!pip list", "x = 1", "# !pip install nope"].join("\n");
    expect(extractPipInstalls(src)).toEqual({ packages: [], code: src });
  });

  it("tolerates spacing variants", () => {
    expect(extractPipInstalls("!  pip   install   pandas").packages).toEqual(["pandas"]);
  });
});
