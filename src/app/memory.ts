// Status bar memory readout.
//
// The browser gives us no cross-context total (measureUserAgentSpecificMemory
// is gated and unreliable), so we report what is actually meaningful and
// matchable:
//   · Python  — Pyodide's WASM linear memory (the big one; grows with data)
//   · Ruff    — the Ruff WASM worker's linear memory
//   · App     — main-thread JS heap (Chromium only)
// Worker JS heaps aren't exposed by any browser, so they're not listed.

import type { Shell } from "./shell";

export interface MemParts {
  app?: number;
  python?: number;
  ruff?: number;
  git?: number;
}

export interface Collectors {
  collect: () => Promise<MemParts>;
  subscribeRuntime?: (fn: () => void) => () => void;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 10 * 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function totalOf(parts: MemParts): number {
  return (parts.app ?? 0) + (parts.python ?? 0) + (parts.ruff ?? 0) + (parts.git ?? 0);
}

let parts: MemParts = {};
let measured = false;
let busy = false;
let shellRef: Shell | null = null;
let collect: (() => Promise<MemParts>) | null = null;

async function measure(): Promise<void> {
  if (busy || !collect) return;
  busy = true;
  try {
    const next = await collect();
    parts = next;
    measured = true;
  } catch {
    /* keep the previous reading */
  } finally {
    busy = false;
    shellRef?.refreshBadges();
  }
}

export function initMemory(shell: Shell, opts: Collectors): void {
  shellRef = shell;
  collect = opts.collect;

  shell.setStatus({
    id: "memory",
    side: "right",
    order: 50,
    icon: "cpu",
    text: () => (measured ? formatBytes(totalOf(parts)) : "—"),
    tooltip: () => {
      if (!measured) return "Memory: click to measure";
      const lines = [
        `Python ${formatBytes(parts.python)}`,
        `Ruff ${formatBytes(parts.ruff)}`,
        `App ${formatBytes(parts.app)}`,
      ];
      if (parts.git) lines.push(`Git ${formatBytes(parts.git)}`);
      return [
        "Memory (WASM runtimes + JS heap)",
        lines.join(" · "),
        `Total ${formatBytes(totalOf(parts))}. Click to re-measure`,
      ].join("\n");
    },
    onClick: () => void measure(),
  });

  // Readings are cheap (no forced GC), so a short first check and a steady
  // 15s cadence keep the number live without cost.
  window.setTimeout(() => void measure(), 1500);
  window.setInterval(() => void measure(), 15000);
  opts.subscribeRuntime?.(() => {
    window.setTimeout(() => {
      if (!busy) void measure();
    }, 3000);
  });
}
