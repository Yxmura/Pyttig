import { describe, expect, it } from "vitest";
import { chooseCorsProxy } from "../../src/git/client";

const env = { launcher: false, hostedProxy: undefined, origin: "https://pyttig.yamura.dev", basePath: "/" };

describe("chooseCorsProxy", () => {
  it("prefers the launcher proxy when present", () => {
    expect(chooseCorsProxy("auto", { ...env, launcher: true })).toBe("https://pyttig.yamura.dev/__pyttig__/proxy");
  });

  it("uses the hosted serverless proxy on static deployments", () => {
    expect(chooseCorsProxy("auto", { ...env, hostedProxy: "https://pyttig.yamura.dev/api/proxy?" })).toBe(
      "https://pyttig.yamura.dev/api/proxy?",
    );
  });

  it("falls back to the public proxy", () => {
    expect(chooseCorsProxy("auto", env)).toBe("https://cors.isomorphic-git.org");
    expect(chooseCorsProxy("", env)).toBe("https://cors.isomorphic-git.org");
  });

  it("honours explicit settings, including 'none'", () => {
    expect(chooseCorsProxy("https://my.proxy/", { ...env, launcher: true, hostedProxy: "x" })).toBe("https://my.proxy/");
    expect(chooseCorsProxy("none", { ...env, launcher: true })).toBeUndefined();
  });

  it("respects subpath deployments", () => {
    expect(chooseCorsProxy("auto", { ...env, launcher: true, basePath: "/pyttig/" })).toBe(
      "https://pyttig.yamura.dev/pyttig/__pyttig__/proxy",
    );
  });
});
