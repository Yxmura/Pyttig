// Ruff client: lazy worker, settings-driven workspace, typed diagnostics.

import type { Diagnostic as RuffDiagnostic } from "@astral-sh/ruff-wasm-web/ruff_wasm";
import { loadSettings } from "../app/settings";
import { handleWorkerError, resolveWorkerSource } from "../app/workerGuard";
import ruffWorkerUrl from "./ruff.worker.ts?worker&url";

export type { RuffDiagnostic };

let worker: Worker | null = null;
let reqId = 1;
const pending = new Map<number, (v: { ok: boolean; result?: unknown; error?: string }) => void>();
let settingsKey = "";

function spawn(source: { url: string; revoke: () => void }): Worker {
  const w = new Worker(source.url, { type: "module" });
  setTimeout(source.revoke, 5000);
  w.onmessage = (e: MessageEvent) => {
    const m = e.data as { id: number; ok: boolean; result?: unknown; error?: string };
    pending.get(m.id)?.({ ok: m.ok, result: m.result, error: m.error });
    pending.delete(m.id);
  };
  w.onerror = (e) => {
    const detail = e.message || e.filename || "script failed to load";
    for (const [, r] of pending) r({ ok: false, error: detail });
    pending.clear();
    if (worker === w) worker = null;
    handleWorkerError("Ruff", ruffWorkerUrl, detail);
  };
  w.onmessageerror = () => {
    for (const [, r] of pending) r({ ok: false, error: "message error" });
    pending.clear();
    if (worker === w) worker = null;
    handleWorkerError("Ruff", ruffWorkerUrl, "message serialization error");
  };
  return w;
}

function key(): string {
  const s = loadSettings();
  return `${s.lineLength}|${s.tabSize}|${s.quoteStyle}`;
}

async function ensure(): Promise<Worker | null> {
  if (!loadSettings().ruffEnabled) return null;
  const k = key();
  if (!worker || settingsKey !== k) {
    worker?.terminate();
    pending.clear();
    worker = spawn(await resolveWorkerSource(ruffWorkerUrl));
    settingsKey = k;
    const s = loadSettings();
    await call("init", {
      settings: { lineLength: s.lineLength, indentWidth: s.tabSize, quoteStyle: s.quoteStyle },
    });
  }
  return worker;
}

function call(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error("ruff unavailable"));
      return;
    }
    const id = reqId++;
    pending.set(id, (v) => (v.ok ? resolve(v.result) : reject(new Error(v.error ?? "ruff failed"))));
    worker.postMessage({ id, type, ...payload });
  });
}

export async function ruffCheck(code: string): Promise<RuffDiagnostic[]> {
  const w = await ensure();
  if (!w) return [];
  try {
    return (await call("check", { code })) as RuffDiagnostic[];
  } catch {
    return [];
  }
}

export async function ruffFormat(code: string): Promise<string | null> {
  const w = await ensure();
  if (!w) return null;
  try {
    return (await call("format", { code })) as string;
  } catch {
    return null;
  }
}

/** WASM memory of the Ruff worker (null when it isn't running). */
export async function ruffMemory(): Promise<{ wasm: number } | null> {
  if (!worker) return null;
  try {
    return (await call("memory")) as { wasm: number };
  } catch {
    return null;
  }
}

export function ruffSeverity(code: string | null): "error" | "warning" | "info" | "hint" {
  if (!code) return "info";
  if (code === "E999" || code.startsWith("E9") || code.startsWith("F82") || code.startsWith("F83")) return "error";
  if (code.startsWith("F") || code.startsWith("E")) return "warning";
  return "info";
}
