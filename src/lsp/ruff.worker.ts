// Ruff WASM worker: lint diagnostics + formatting, off the UI thread.

import init, { Workspace, PositionEncoding } from "@astral-sh/ruff-wasm-web";
import wasmUrl from "@astral-sh/ruff-wasm-web/ruff_wasm_bg.wasm?url";

export interface RuffSettings {
  lineLength: number;
  indentWidth: number;
  quoteStyle: "double" | "single";
}

let ws: Workspace | null = null;
let wasmBytes = 0;

function buildSettings(s: RuffSettings) {
  return {
    "line-length": s.lineLength,
    "indent-width": s.indentWidth,
    format: {
      "indent-style": "space",
      "quote-style": s.quoteStyle,
      "magic-trailing-comma": "respect",
    },
    lint: {
      // E4/E7/E9: syntax-adjacent errors · F: pyflakes (unused, undefined) ·
      // W: warnings · I: import sorting
      select: ["E4", "E7", "E9", "F", "W", "I"],
      ignore: [],
    },
  };
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data as { id: number; type: string; [k: string]: unknown };
  try {
    if (m.type === "init") {
      const out = await init(wasmUrl);
      wasmBytes = out?.memory?.buffer?.byteLength ?? 0;
      ws?.free();
      ws = new Workspace(buildSettings(m.settings as RuffSettings), PositionEncoding.Utf16);
      (self as unknown as { postMessage(m: unknown): void }).postMessage({ id: m.id, ok: true });
    } else if (m.type === "check") {
      if (!ws) throw new Error("ruff not initialized");
      const diags = ws.check(m.code as string) as unknown[];
      (self as unknown as { postMessage(m: unknown): void }).postMessage({ id: m.id, ok: true, result: diags });
    } else if (m.type === "memory") {
      (self as unknown as { postMessage(m: unknown): void }).postMessage({
        id: m.id, ok: true, result: { wasm: wasmBytes },
      });
    } else if (m.type === "format") {
      if (!ws) throw new Error("ruff not initialized");
      const out = ws.format(m.code as string);
      (self as unknown as { postMessage(m: unknown): void }).postMessage({ id: m.id, ok: true, result: out });
    }
  } catch (err) {
    (self as unknown as { postMessage(m: unknown): void }).postMessage({
      id: m.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
