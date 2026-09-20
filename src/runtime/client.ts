// Python runtime client: owns the Pyodide worker, run/stop lifecycle,
// stdin, plots, packages, preload, idle unload. The LSP bridge (M3) calls lspRequest().

import type { Shell } from "../app/shell";
import { icons } from "../app/icons";
import { registerCommands, runCommand } from "../app/commands";
import { loadSettings, saveSettings, onSettingsChange } from "../app/settings";
import { notify } from "../app/toast";
import { getActivePath, getActiveCode, getEditorSelection, openFile } from "../editor/manager";
import { wsListAll, wsRead, wsWrite, emitWorkspaceReset } from "../fs/workspace";
import { terminal } from "./terminal";
import { handleWorkerError, resolveWorkerSource } from "../app/workerGuard";
import pythonWorkerUrl from "./python.worker.ts?worker&url";
import { PYODIDE_VERSION, resolvePyodideUrls } from "./pyodideVersion";

type Resolver = (v: { ok: boolean; result?: unknown; error?: string }) => void;

let shell: Shell;
let worker: Worker | null = null;
let reqId = 1;
const pending = new Map<number, Resolver>();
let runSeq = 0;
let activeRun = 0;
let state: "idle" | "loading" | "ready" | "running" = "idle";
let pyVersion = "";
let sabIsolated = false;
let interruptBuf: Uint8Array | null = null;
let stdinBuf: Uint8Array | null = null;
let stdinMeta: Int32Array | null = null;
let idleTimer = 0;
let initPromise: Promise<void> | null = null;
let currentWorkerSource = pythonWorkerUrl;
let currentWorkerRevoke: () => void = () => {};
let preloadStarted = false;
let preloadGen = 0;

const listeners = new Set<() => void>();
export function onRuntimeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function changed() {
  for (const l of listeners) {
    try {
      l();
    } catch (err) {
      console.error(err);
    }
  }
}

export function runtimeState() {
  return { state, pyVersion, sabIsolated, running: state === "running" };
}

function setState(s: typeof state) {
  state = s;
  shell?.setRunning(s === "running");
  shell?.refreshBadges();
  changed();
}

/** Detect the stdlib launcher (serves COOP/COEP + git proxy). */
/** Fetch that can never hang boot: resolves to null on error or timeout. */
async function fetchWithTimeout(url: string, ms: number): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { cache: "no-store", signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

async function detectBackends(): Promise<{ launcher: boolean; hostedProxy: boolean }> {
  // The launcher announces itself in the served HTML — no probing needed.
  if (document.querySelector('meta[name="pyttig-launcher"]')) {
    (window as unknown as { __pyttigLauncher?: boolean }).__pyttigLauncher = true;
    return { launcher: true, hostedProxy: false };
  }

  // Hosted deployments (e.g. Vercel) can ship the serverless git proxy at
  // /api/proxy — a 400-with-JSON answer means it exists. Timeout-bounded so a
  // hung endpoint can never hold up startup.
  const prefix = location.pathname.replace(/[^/]*$/, "");
  const proxy = await fetchWithTimeout(`${prefix}api/proxy`, 1500);
  let hostedProxy = false;
  if (proxy && proxy.status !== 404 && (proxy.headers.get("content-type") ?? "").includes("application/json")) {
    (window as unknown as { __pyttigProxy?: string }).__pyttigProxy = `${location.origin}${prefix}api/proxy?`;
    hostedProxy = true;
  }
  return { launcher: false, hostedProxy };
}

function spawnWorker(): Worker {
  // Loaded via the Vite-emitted worker URL; a MIME-broken host is worked
  // around by resolveWorkerSource (blob-based fallback).
  const w = new Worker(currentWorkerSource, { type: "module" });
  setTimeout(currentWorkerRevoke, 5000);
  w.onmessage = onWorkerMessage;
  const failed = (detail: string) => {
    for (const [, r] of pending) r({ ok: false, error: `python runtime failed: ${detail}` });
    pending.clear();
    if (worker === w) teardownWorker(); // don't kill a newer worker
    handleWorkerError("Python runtime", pythonWorkerUrl, detail);
  };
  w.onerror = (e) => failed(e.message || e.filename || "script failed to load");
  w.onmessageerror = () => failed("message serialization error");
  return w;
}

function request<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error("runtime not started"));
      return;
    }
    const id = reqId++;
    pending.set(id, (v) => (v.ok ? resolve(v.result as T) : reject(new Error(v.error ?? "failed"))));
    worker.postMessage({ id, type, ...payload });
  });
}

/**
 * Start (or reuse) the Pyodide worker.
 * The in-flight init promise is shared so concurrent callers (e.g. several
 * LSP requests racing on first keystroke) can never talk to a worker whose
 * interpreter isn't loaded yet.
 */
async function ensureWorker(): Promise<void> {
  if (initPromise) return initPromise;
  const source = await resolveWorkerSource(pythonWorkerUrl);
  currentWorkerSource = source.url;
  currentWorkerRevoke = source.revoke;
  initPromise = (async () => {
    if (worker) worker.terminate();
    pending.clear();
    setState("loading");
    worker = spawnWorker();
    sabIsolated = !!window.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";
    let interruptBuffer: SharedArrayBuffer | undefined;
    let stdinBuffer: SharedArrayBuffer | undefined;
    let stdinMetaBuf: SharedArrayBuffer | undefined;
    if (sabIsolated) {
      interruptBuffer = new SharedArrayBuffer(1);
      interruptBuf = new Uint8Array(interruptBuffer);
      stdinBuffer = new SharedArrayBuffer(64 * 1024);
      stdinBuf = new Uint8Array(stdinBuffer);
      stdinMetaBuf = new SharedArrayBuffer(8);
      stdinMeta = new Int32Array(stdinMetaBuf);
    } else {
      interruptBuf = null;
      stdinBuf = null;
      stdinMeta = null;
    }
    const r = await request<{ version: string; isolated: boolean }>("init", {
      indexURL: resolvePyodideUrls().index,
      moduleURL: resolvePyodideUrls().module,
      isolated: sabIsolated,
      interruptBuffer,
      stdinBuffer,
      stdinMeta: stdinMetaBuf,
    });
    pyVersion = r.version;
    setState("ready");
    shell.refreshBadges();
  })();
  initPromise.catch(() => {
    // Reset so a later attempt can start fresh.
    initPromise = null;
    setState("idle");
  });
  return initPromise;
}

/** Tear the worker down and clear the init guard (idle unload, stop, restart). */
function teardownWorker(): void {
  worker?.terminate();
  worker = null;
  initPromise = null;
  pyVersion = "";
  setState("idle");
}

function onWorkerMessage(e: MessageEvent) {
  const m = e.data as Record<string, unknown>;
  if (m.type === "run-done" && typeof m.runId === "number") {
    handleRunDone(m);
    return;
  }
  if (typeof m.id === "number" && pending.has(m.id)) {
    const r = pending.get(m.id)!;
    pending.delete(m.id);
    r({ ok: m.ok as boolean, result: m.result, error: m.error as string | undefined });
    return;
  }
  const ev = m.event as string | undefined;
  if (!ev) return;
  switch (ev) {
    case "stdout":
      terminal.write(String(m.data ?? ""));
      break;
    case "stderr":
      terminal.write(String(m.data ?? ""));
      break;
    case "input-request":
      void handleStdinRequest(Number(m.runId));
      break;
    case "missing-module":
      onMissingModule(String(m.name ?? ""));
      break;
    case "pkg-status":
      changed();
      break;
  }
}

async function handleStdinRequest(runId: number) {
  if (runId !== activeRun) return;
  if (sabIsolated && stdinBuf && stdinMeta) {
    const line = await terminal.readLine();
    if (runId !== activeRun) return;
    if (line === null) {
      // Ctrl+C → keyboard interrupt inside input().
      if (interruptBuf) interruptBuf[0] = 2;
      Atomics.store(stdinMeta, 1, 0);
      Atomics.store(stdinMeta, 0, 1);
      Atomics.notify(stdinMeta, 0);
      return;
    }
    const bytes = new TextEncoder().encode(line + "\n");
    const n = Math.min(bytes.length, stdinBuf.length);
    stdinBuf.set(bytes.slice(0, n));
    Atomics.store(stdinMeta, 1, n);
    Atomics.store(stdinMeta, 0, 1);
    Atomics.notify(stdinMeta, 0);
  } else {
    // No SharedArrayBuffer: stdin came from the prefilled box (or EOF).
    // Nothing to do — the worker consumes stdinLines synchronously.
  }
}

function onMissingModule(name: string) {
  notify.warn(`Module "${name}" is not installed.`, {
    actions: [
      {
        label: `Install ${name}`,
        primary: true,
        run: () => {
          void ensurePackages([name]).then((r) => {
            if (!r.failed.length) {
              notify.success(`Installed ${name}.`, {
                actions: [{ label: "Run again", run: () => runCommand("python.run") }],
              });
            } else notify.error(`Could not install ${name}.`);
          });
        },
      },
    ],
  });
}

async function mirrorFiles(): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  for (const f of await wsListAll()) {
    try {
      const st = await wsStatSafe(f);
      if (st && st.size > 4 * 1024 * 1024) continue;
      out.push({ path: f, content: await wsRead(f) });
    } catch {
      /* binary/unreadable — skip for mirroring */
    }
  }
  return out;
}

async function wsStatSafe(path: string) {
  try {
    const { wsStat } = await import("../fs/workspace");
    return await wsStat(path);
  } catch {
    return null;
  }
}

// ---------- run ----------

export async function runFile(): Promise<void> {
  const path = getActivePath();
  if (!path) {
    notify.info("Open a Python file first.");
    return;
  }
  if (!path.endsWith(".py")) {
    notify.warn("The active file is not a Python file.");
    return;
  }
  await runCommand("file.save");
  cancelPreload();
  await ensureWorker();
  if (state === "running") {
    notify.warn("A program is already running. Stop it first (Shift+F5).");
    return;
  }
  const code = getActiveCode();
  const s = loadSettings();
  const args = s.runArgs.trim() ? s.runArgs.trim().split(/\s+/) : [];
  const stdinLines: string[] = [];
  shell.setPanel("terminal");
  terminal.write(`\x1b[2m— run ${path} · Python ${pyVersion || PYODIDE_VERSION} —\x1b[0m\r\n`);
  setState("running");
  pokeIdle();
  const runId = ++runSeq;
  activeRun = runId;
  const files = await mirrorFiles();
  worker!.postMessage({
    id: reqId++,
    type: "run",
    runId,
    code,
    filename: path.split("/").pop() ?? path,
    args,
    files,
    keepNs: s.keepNamespace,
    stdinLines,
  });
  // Completion arrives as a run-done message (handled there).
}

function handleRunDone(m: Record<string, unknown>) {
  const runId = Number(m.runId);
  if (runId !== activeRun) return;
  setState("ready");
  terminal.write(`\x1b[2m— done —\x1b[0m\r\n`);
  const result = (m.result ?? {}) as {
    plots?: { name: string; png: ArrayBuffer }[];
    changed?: { path: string; content: ArrayBuffer }[];
  };
  if (result.plots?.length) {
    for (const p of result.plots) addPlot(p.name, p.png);
    shell.setPanel("plots");
    notify.success(`${result.plots.length} figure${result.plots.length > 1 ? "s" : ""} captured.`);
  }
  if (result.changed?.length) {
    void (async () => {
      for (const c of result.changed!) {
        await wsWrite(c.path, new Uint8Array(c.content), true);
      }
      emitWorkspaceReset();
    })();
  }
  pokeIdle();
}

export async function runSelection(): Promise<void> {
  const path = getActivePath();
  if (!path) {
    notify.info("Open a Python file first.");
    return;
  }
  const snippet = getEditorSelection() ?? getActiveCode();
  if (!snippet.trim()) {
    notify.info("Nothing to run.");
    return;
  }
  await cancelPreload();
  await ensureWorker();
  if (state === "running") {
    notify.warn("A program is already running. Stop it first (Shift+F5).");
    return;
  }
  shell.setPanel("terminal");
  terminal.write(`\x1b[2m— run selection · Python ${pyVersion || PYODIDE_VERSION} —\x1b[0m\r\n`);
  setState("running");
  pokeIdle();
  const runId = ++runSeq;
  activeRun = runId;
  worker!.postMessage({
    id: reqId++,
    type: "run",
    runId,
    code: snippet,
    filename: (path.split("/").pop() ?? path) + " <selection>",
    args: [],
    files: await mirrorFiles(),
    keepNs: true,
    stdinLines: [],
  });
}

export async function stopRun(): Promise<void> {
  if (state !== "running") return;
  if (sabIsolated && interruptBuf) {
    interruptBuf[0] = 2;
    // Also unblock a pending stdin wait.
    try {
      if (stdinMeta) {
        Atomics.store(stdinMeta, 1, 0);
        Atomics.store(stdinMeta, 0, 1);
        Atomics.notify(stdinMeta, 0);
      }
    } catch { /* ignore */ }
    terminal.cancelInput();
  } else {
    // No SharedArrayBuffer: cannot interrupt WebAssembly — restart the worker.
    terminal.write("\x1b[33mRestarting runtime (interrupts need the launcher)…\x1b[0m\r\n");
    activeRun = -1;
    for (const [, r] of pending) r({ ok: false, error: "stopped" });
    pending.clear();
    teardownWorker();
  }
}

export async function restartRuntime(): Promise<void> {
  if (state === "running") await stopRun();
  teardownWorker();
  await ensureWorker();
  notify.success(`Python ${pyVersion} ready.`);
}

// ---------- idle unload ----------

function pokeIdle() {
  window.clearTimeout(idleTimer);
  const mins = loadSettings().idleUnloadMinutes;
  if (!mins || mins <= 0) return;
  idleTimer = window.setTimeout(() => {
    if (state === "ready" && worker) {
      teardownWorker();
      notify.info("Python runtime unloaded after idle (memory freed). It restarts on next run.");
    }
  }, mins * 60 * 1000);
}

// ---------- packages ----------

export interface PkgInfo {
  name: string;
  version: string;
  source: string;
}

export async function ensurePackages(names: string[]): Promise<{ installed: string[]; failed: string[] }> {
  await ensureWorker();
  pokeIdle();
  shell.setPanel("packages");
  const r = await request<{ installed: string[]; failed: string[] }>("ensure-packages", { names });
  changed();
  return r;
}

export async function listPackages(): Promise<PkgInfo[]> {
  await ensureWorker();
  const r = await request<Record<string, PkgInfo> | PkgInfo[]>("list-packages");
  const arr = Array.isArray(r) ? r : Object.values(r ?? {});
  return arr.map((p) => ({ name: p.name, version: p.version, source: p.source ?? "" }));
}

export async function uninstallPackages(names: string[]): Promise<void> {
  await ensureWorker();
  await request("uninstall", { names });
  changed();
}

export async function resetNamespace(): Promise<void> {
  if (!worker) return;
  await request("reset");
  notify.success("Runtime namespace cleared.");
}

/** Mirror saved Python sources into the worker FS for Jedi cross-file analysis. */
export async function syncWorkspaceToWorker(paths?: string[]): Promise<void> {
  if (!worker) return; // don't boot the runtime just to mirror files
  await ensureWorker();
  const all = paths ?? (await wsListAll()).filter((f) => f.endsWith(".py") || f.endsWith(".pyi"));
  const files: { path: string; content: string }[] = [];
  for (const f of all) {
    if (!(f.endsWith(".py") || f.endsWith(".pyi"))) continue;
    try {
      files.push({ path: f, content: await wsRead(f) });
    } catch { /* skip */ }
  }
  await request("sync-files", { files }).catch(() => undefined);
}

/** WASM memory of the CPython runtime (null when the worker isn't running). */
export async function pythonMemory(): Promise<{ wasm: number } | null> {
  if (!worker) return null;
  try {
    return await request<{ wasm: number }>("memory");
  } catch {
    return null;
  }
}

/** Generic LSP call for the bridge (M3). Ensures the worker (and Jedi) first. */
export async function lspRequest(op: string, params: Record<string, unknown>): Promise<unknown> {
  await ensureWorker();
  pokeIdle();
  return request("lsp", { op, params });
}

// ---------- stdin box (fallback when not cross-origin isolated) ----------

// ---------- plots ----------

interface Plot {
  name: string;
  url: string;
}
const plots: Plot[] = [];
const plotListeners = new Set<() => void>();
export function onPlotsChange(fn: () => void): () => void {
  plotListeners.add(fn);
  return () => plotListeners.delete(fn);
}
function addPlot(name: string, png: ArrayBuffer) {
  const blob = new Blob([png], { type: "image/png" });
  plots.unshift({ name, url: URL.createObjectURL(blob) });
  for (const l of plotListeners) l();
}
export function getPlots(): Plot[] {
  return plots;
}

// ---------- views ----------

function renderTerminalPanel(host: HTMLElement) {
  terminal.attach(host);
  terminal.fitView();
}

function renderPlotsPanel(host: HTMLElement) {
  host.innerHTML = "";
  const draw = () => {
    host.innerHTML = "";
    const list = getPlots();
    if (!list.length) {
      host.innerHTML = `<div class="empty-note">No figures yet. Run code that calls <kbd>plt.show()</kbd> and figures appear here.</div>`;
      return;
    }
    for (const p of list) {
      const card = document.createElement("div");
      card.className = "plot-card";
      card.innerHTML = `<img /><div class="plot-head"><span></span><button class="btn">Save</button></div>`;
      (card.querySelector("img") as HTMLImageElement).src = p.url;
      (card.querySelector("span") as HTMLElement).textContent = p.name;
      (card.querySelector("button") as HTMLButtonElement).onclick = async () => {
        const res = await fetch(p.url);
        const buf = new Uint8Array(await res.arrayBuffer());
        await wsWrite(p.name, buf);
        notify.success(`Saved ${p.name} to workspace.`);
      };
      host.appendChild(card);
    }
  };
  const off = onPlotsChange(draw);
  draw();
  return off;
}

// ---------- data stack preload ----------

const CORE_STACK = ["numpy", "pandas", "matplotlib", "requests", "beautifulsoup4", "Pillow", "pyyaml", "rich", "tqdm", "python-dateutil", "sympy"];

async function maybePreload() {
  const s = loadSettings();
  if (!s.preloadStack || s.preloadStackDone || preloadStarted) return;
  preloadStarted = true;
  const gen = ++preloadGen;
  try {
    notify.info("Installing the data-science stack in the background (numpy, pandas, matplotlib, requests…)…", { timeout: 8000 });
    const r = await ensurePackages(CORE_STACK);
    if (gen !== preloadGen) return; // cancelled by a user run
    saveSettings({ preloadStackDone: true });
    if (r.failed.length) notify.warn(`Stack installed with skips: ${r.failed.join(", ")}. Install them later from Packages.`);
    else notify.success("Data-science stack ready.");
  } catch (err) {
    if (gen !== preloadGen) return;
    notify.warn(`Background stack install paused: ${err instanceof Error ? err.message : err}. It will retry on first run.`);
    preloadStarted = false;
  }
}

/** A user run always wins over the background preload: drop it and start fresh. */
async function cancelPreload(): Promise<void> {
  if (!preloadStarted || loadSettings().preloadStackDone) return;
  preloadGen++;
  preloadStarted = false;
  for (const [, r] of pending) r({ ok: false, error: "cancelled" });
  pending.clear();
  teardownWorker();
}

// ---------- init ----------

export async function initRuntime(sh: Shell): Promise<void> {
  shell = sh;
  terminal.onOpenFile((path, line) => {
    // Tracebacks reference the bare filename; resolve against workspace.
    void openFile(path.replace(/^\/home\/pyodide\/workspace\//, ""), line, 0);
  });

  sh.registerPanel({ id: "terminal", title: "Terminal", order: 1, render: renderTerminalPanel });
  sh.registerPanel({ id: "plots", title: "Plots", order: 3, render: renderPlotsPanel });

  sh.setStatus({
    id: "python", side: "left", order: 20, icon: "zap",
    text: () => (state === "loading" ? "Python: loading…" : state === "running" ? "Python: running" : pyVersion ? `Python ${pyVersion}` : "Python: idle"),
    tooltip: () => `Pyodide ${PYODIDE_VERSION} in a Web Worker. Click to ${state === "ready" ? "restart" : "start"} the runtime.`,
    cls: () => (state === "running" ? "accent" : state === "ready" ? "ok" : ""),
    onClick: () => (state === "ready" ? runCommand("python.restart") : ensureWorker().catch((e) => notify.error(String(e)))),
  });

  registerCommands([
    { id: "python.run", title: "Run Python file", category: "Run", icon: "play", keybinding: "F5", run: () => runFile() },
    { id: "python.stop", title: "Stop", category: "Run", icon: "stop", keybinding: "Shift+F5", run: () => stopRun() },
    { id: "python.runSelection", title: "Run selection", category: "Run", keybinding: "F9", run: () => runSelection() },
    { id: "python.restart", title: "Restart runtime", category: "Run", icon: "refresh", run: () => restartRuntime() },
    { id: "python.clearNamespace", title: "Clear runtime namespace", category: "Run", run: () => resetNamespace() },
    { id: "packages.open", title: "Open packages", category: "Run", icon: "package", run: () => Promise.resolve() },
  ]);

  const { launcher } = await detectBackends();
  if (!window.crossOriginIsolated && !launcher) {
    notify.info(
      "This host doesn't send cross-origin isolation headers, so stop/interactive input are limited. " +
        "See README → Deploying for the two headers to add (or run `python pyttig.py`).",
      { timeout: 12000 },
    );
  }
  // Background preload shortly after boot — the editor stays usable meanwhile.
  window.setTimeout(() => void maybePreload(), 2500);

  // Keep panels fresh and re-theme the terminal when the app theme changes.
  onRuntimeChange(() => shell.refreshBadges());
  onSettingsChange(() => terminal.resyncTheme());
}
