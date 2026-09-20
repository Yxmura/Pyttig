// Pyodide module worker: executes user code AND serves Jedi LSP requests.
// One shared interpreter keeps memory low. Long runs block LSP (documented;
// Ruff diagnostics stay live in their own worker).

import jediServerSource from "../lsp/jedi_server.py?raw";
import { PYODIDE_VERSION, pyodideModuleUrl } from "./pyodideVersion";
import { extractPipInstalls } from "./pipLines";

interface RunFile {
  path: string;
  content: string; // text; binary files are skipped by the client
}

type InMsg =
  | { id: number; type: "init"; indexURL: string; moduleURL?: string; isolated: boolean; interruptBuffer?: SharedArrayBuffer; stdinBuffer?: SharedArrayBuffer; stdinMeta?: SharedArrayBuffer }
  | { id: number; type: "run"; runId: number; code: string; filename: string; args: string[]; files: RunFile[]; keepNs: boolean; stdinLines: string[] }
  | { id: number; type: "lsp"; op: string; params: Record<string, unknown> }
  | { id: number; type: "ensure-packages"; names: string[] }
  | { id: number; type: "list-packages" }
  | { id: number; type: "uninstall"; names: string[] }
  | { id: number; type: "reset" }
  | { id: number; type: "sync-files"; files: { path: string; content: string }[] }
  | { id: number; type: "ping" }
  | { id: number; type: "memory" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pyodide = any;
let pyodide: Pyodide | null = null;
let runGlobals: unknown = null;
let jediReady = false;
let currentRunId = -1;
let stdinQueue: string[] = [];
let sabIn: { buf: Uint8Array; meta: Int32Array } | null = null;
let outBuffer = "";
let errBuffer = "";

const post = (msg: unknown, transfer?: Transferable[]) =>
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(msg as never, transfer);

function emitOut() {
  if (outBuffer) {
    post({ event: "stdout", runId: currentRunId, data: outBuffer });
    outBuffer = "";
  }
  if (errBuffer) {
    post({ event: "stderr", runId: currentRunId, data: errBuffer });
    errBuffer = "";
  }
}

function pipeStdout(s: string): void {
  // Pyodide strips trailing newlines from batches — restore the line break.
  outBuffer += s + "\n";
  if (outBuffer.length > 4096) emitOut();
}

function pipeStderr(s: string): void {
  errBuffer += s + "\n";
  if (errBuffer.length > 4096) emitOut();
}

/** Loader chatter ("Loading numpy" / "Loaded numpy", pip noise) rendered dim. */
function sysOut(line: string): void {
  outBuffer += `\x1b[90m${line}\x1b[0m\n`;
  if (outBuffer.length > 4096) emitOut();
}

/**
 * Pyodide swaps its global stdout/stderr callbacks while a package load is in
 * flight, so two concurrent loads steal each other's messages (and can leak
 * unformatted lines into the terminal). Serialize every load through this chain.
 */
let loadChain: Promise<unknown> = Promise.resolve();
function withLoadLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = loadChain.then(fn, fn);
  loadChain = run.catch(() => undefined);
  return run;
}

/** Load micropip if needed (quietly). Required before any micropip.install. */
async function ensureMicropip(): Promise<void> {
  if (!pyodide) throw new Error("Python runtime is not ready yet");
  await withLoadLock(() =>
    pyodide.loadPackage("micropip", {
      messageCallback: () => {},
      errorCallback: () => {},
    }),
  );
}

/** Capture stdout+stderr of a Python snippet and re-emit it dimmed.
 *  Used for pip/loader noise; callers hold the load lock, so temporarily
 *  swapping the global handlers is safe. */
async function runPythonDimmed(code: string): Promise<void> {
  let captured = "";
  let prevOutRestore: (() => void) | null = null;
  try {
    const prevOut = { batched: (s: string) => pipeStdout(s) };
    const prevErr = { batched: (s: string) => pipeStderr(s) };
    pyodide.setStdout({ batched: (s: string) => { captured += s + "\n"; } });
    pyodide.setStderr({ batched: (s: string) => { captured += s + "\n"; } });
    prevOutRestore = () => {
      pyodide.setStdout(prevOut);
      pyodide.setStderr(prevErr);
    };
    await pyodide.runPythonAsync(code);
  } finally {
    prevOutRestore?.();
  }
  for (const line of captured.split("\n")) {
    if (line.trim()) sysOut(line);
  }
}

function makeStdinReader() {
  let byteBuf: number[] = [];
  const feedLine = (line: string) => {
    const bytes = new TextEncoder().encode(line + "\n");
    // Echo what the user typed so the terminal shows it.
    outBuffer += line + "\n";
    for (const b of bytes) byteBuf.push(b);
  };
  return (): number | null => {
    for (;;) {
      if (byteBuf.length) return byteBuf.shift()!;
      if (stdinQueue.length) {
        feedLine(stdinQueue.shift()!);
        continue;
      }
      if (sabIn) {
        post({ event: "input-request", runId: currentRunId });
        Atomics.store(sabIn.meta, 0, 0);
        Atomics.wait(sabIn.meta, 0, 0);
        const n = Atomics.load(sabIn.meta, 1);
        if (n > 0) {
          const bytes = sabIn.buf.slice(0, n);
          const text = new TextDecoder().decode(bytes).replace(/\r?\n$/, "");
          emitOut();
          feedLine(text);
          continue;
        }
        return null; // aborted → EOF
      }
      return null; // EOF
    }
  };
}

async function doInit(m: Extract<InMsg, { type: "init" }>) {
  const moduleUrl = m.moduleURL || pyodideModuleUrl(PYODIDE_VERSION);
  const mod = await import(/* @vite-ignore */ moduleUrl);
  pyodide = await mod.loadPyodide({
    indexURL: m.indexURL,
    stdout: (s: string) => {
      outBuffer += s + "\n";
    },
    stderr: (s: string) => {
      errBuffer += s + "\n";
    },
  });
  pyodide.setStdout({ batched: (s: string) => pipeStdout(s) });
  pyodide.setStderr({ batched: (s: string) => pipeStderr(s) });
  pyodide.setStdin({ stdin: makeStdinReader(), isatty: false, error: false });
  if (m.isolated && m.interruptBuffer) {
    pyodide.setInterruptBuffer(new Uint8Array(m.interruptBuffer));
  }
  if (m.isolated && m.stdinBuffer && m.stdinMeta) {
    sabIn = { buf: new Uint8Array(m.stdinBuffer), meta: new Int32Array(m.stdinMeta) };
  }
  // Networking patch so `requests` / urllib work in the browser.
  try {
    await withLoadLock(() =>
      pyodide.loadPackage("pyodide-http", {
        messageCallback: () => {},
        errorCallback: () => {},
      }),
    );
    await pyodide.runPythonAsync("import pyodide_http\npyodide_http.patch_all()");
  } catch {
    /* offline or older dist — pyfetch still available */
  }
  // Deterministic plots: Agg backend, we capture figures ourselves.
  try {
    await pyodide.runPythonAsync("import matplotlib\nmatplotlib.use('Agg')");
  } catch {
    /* matplotlib not installed — fine */
  }
  const version: string = await pyodide.runPythonAsync(
    "import sys\nsys.version.split()[0]",
  );
  return { version, isolated: m.isolated, sabStdin: !!sabIn };
}

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!pyodide) return out;
  const FS = pyodide.FS;
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = FS.readdir(d).filter((e: string) => e !== "." && e !== "..");
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${d}/${e}`;
      try {
        const st = FS.stat(p);
        if (FS.isDir(st.mode)) walk(p);
        else out.set(p, `${st.size}:${Number(st.mtime)}`);
      } catch {
        /* ignore */
      }
    }
  };
  walk(dir);
  return out;
}

async function doRun(m: Extract<InMsg, { type: "run" }>) {
  if (!pyodide) throw new Error("Python runtime is not ready yet");
  currentRunId = m.runId;
  stdinQueue = [...m.stdinLines];
  const WS = "/home/pyodide/workspace";
  pyodide.FS.mkdirTree(WS);
  // Mirror workspace text files so imports and open() work.
  for (const f of m.files) {
    const full = `${WS}/${f.path}`;
    const parts = full.split("/").slice(0, -1).join("/");
    pyodide.FS.mkdirTree(parts);
    pyodide.FS.writeFile(full, f.content);
  }
  const before = snapshot(WS);
  // Colab-style `!pip install x` lines are stripped and installed with
  // micropip (there is no real pip in the browser).
  const pip = extractPipInstalls(m.code);
  if (pip.packages.length) {
    sysOut(`pip install ${pip.packages.join(" ")}`);
    try {
      await ensureMicropip();
      await withLoadLock(() =>
        runPythonDimmed(
          `import micropip as __pyttig_micropip\nawait __pyttig_micropip.install(${JSON.stringify(pip.packages)})`,
        ),
      );
      sysOut("ok");
    } catch (err) {
      sysOut(`pip install failed: ${err instanceof Error ? err.message : err}`);
    }
    outBuffer += "\n";
  }

  // Best-effort auto-install of third-party imports from the Pyodide dist.
  // Pyodide's chatter is dimmed and kept apart from program output.
  let loadLines = 0;
  const loader = (s: string) => {
    loadLines++;
    sysOut(String(s));
  };
  try {
    await withLoadLock(() =>
      pyodide.loadPackagesFromImports(pip.code, {
        messageCallback: loader,
        errorCallback: loader,
      }),
    );
  } catch {
    /* unknown/local imports are fine */
  }
  if (loadLines) outBuffer += "\n";

  try {
    await pyodide.runPythonAsync("import sys, os\nos.chdir('/home/pyodide/workspace')");
    // sys.argv via source (module proxies have no .set()).
    const argvSrc = `import sys as __pyttig_sys\n__pyttig_sys.argv = [${[m.filename, ...m.args].map((a) => JSON.stringify(a)).join(", ")}]`;
    await pyodide.runPythonAsync(argvSrc);
    if (!m.keepNs || !runGlobals) {
      try {
        (runGlobals as { destroy?: () => void } | null)?.destroy?.();
      } catch { /* ignore */ }
      runGlobals = pyodide.globals.get("dict")();
    }
    const res = await pyodide.runPythonAsync(pip.code, { filename: m.filename, globals: runGlobals });
    res?.destroy?.();
  } catch (err) {
    emitOut();
    const msg = err instanceof Error ? err.message : String(err);
    // Pyodide prefixes "PythonError: " — strip it, the traceback body is what matters.
    const clean = msg.replace(/^PythonError:\s*/, "");
    post({ event: "stderr", runId: currentRunId, data: clean + (clean.endsWith("\n") ? "" : "\n") });
    // Detect missing modules to offer one-click install.
    const missing = /ModuleNotFoundError: No module named '([^']+)'/.exec(clean)?.[1];
    if (missing) post({ event: "missing-module", runId: currentRunId, name: missing.split(".")[0] });
  } finally {
    emitOut();
  }

  // Capture matplotlib figures.
  const plots: { name: string; png: ArrayBuffer }[] = [];
  try {
    await pyodide.runPythonAsync(`
import io, os
__pyttig_plots = []
try:
    import matplotlib.pyplot as plt
    os.makedirs('/tmp/pyttig_plots', exist_ok=True)
    for __n in plt.get_fignums():
        __fig = plt.figure(__n)
        __p = '/tmp/pyttig_plots/fig-%d.png' % __n
        __fig.savefig(__p, format='png', dpi=110, bbox_inches='tight')
        __pyttig_plots.append(__p)
    plt.close('all')
except Exception:
    pass
`);
    const names: string[] = pyodide.runPython("__pyttig_plots").toJs();
    for (const p of names) {
      const bytes = pyodide.FS.readFile(p);
      plots.push({ name: p.split("/").pop() ?? "figure.png", png: bytes.buffer as ArrayBuffer });
    }
  } catch {
    /* ignore */
  }

  // Write-back: files created/modified by the program.
  const after = snapshot(WS);
  const changed: { path: string; content: ArrayBuffer }[] = [];
  let total = 0;
  for (const [full, sig] of after) {
    if (before.get(full) === sig) continue;
    const rel = full.slice(WS.length + 1);
    try {
      const st = pyodide.FS.stat(full);
      if (st.size > 5 * 1024 * 1024) continue;
      if (total > 10 * 1024 * 1024) break;
      const bytes = pyodide.FS.readFile(full);
      total += bytes.length;
      changed.push({ path: rel, content: bytes.buffer as ArrayBuffer });
    } catch {
      /* ignore */
    }
  }
  const transfers: ArrayBuffer[] = plots.map((p) => p.png).concat(changed.map((c) => c.content));
  post({ id: m.id, ok: true, result: { plots, changed }, runId: currentRunId, type: "run-done" }, transfers);
}

async function ensureJedi() {
  if (jediReady) return;
  if (!pyodide) throw new Error("Python runtime is not ready yet");
  await withLoadLock(() =>
    pyodide.loadPackage(["jedi", "parso"], {
      messageCallback: () => {},
      errorCallback: () => {},
    }),
  );
  await pyodide.runPythonAsync(jediServerSource + "\n__pyttig_lsp_ready = True");
  await pyodide.runPythonAsync("handle('init', {})");
  jediReady = true;
}

async function doLsp(m: Extract<InMsg, { type: "lsp" }>) {
  await ensureJedi();
  // Pass params through JSON to avoid proxy pitfalls with big code strings.
  const paramsJson = JSON.stringify(m.params);
  pyodide.globals.set("__pyttig_params", paramsJson);
  const proxy = await pyodide.runPythonAsync(
    `import json as __json\n__r = handle(${JSON.stringify(m.op)}, __json.loads(__pyttig_params))\n__r`,
  );
  let result: unknown;
  try {
    result = proxy?.toJs?.({ dict_converter: Object.fromEntries }) ?? proxy;
  } finally {
    proxy?.destroy?.();
  }
  return result;
}

async function doEnsurePackages(names: string[]) {
  if (!pyodide) throw new Error("Python runtime is not ready yet");
  const need: string[] = [];
  try {
    const loaded: string[] = pyodide.runPython("list(__import__('sys').modules)").toJs();
    for (const n of names) if (!loaded.includes(n)) need.push(n);
  } catch {
    need.push(...names);
  }
  // 1) Try the Pyodide distribution (fast, includes C extensions).
  if (need.length) {
    try {
      await withLoadLock(() =>
        pyodide.loadPackage(need, {
          messageCallback: (s: string) => sysOut(String(s)),
          errorCallback: (s: string) => sysOut(String(s)),
        }),
      );
      return { installed: need, failed: [] as string[] };
    } catch {
      /* fall through to per-package micropip */
    }
  }
  const installed: string[] = [];
  const failed: string[] = [];
  await ensureMicropip();
  for (const n of need) {
    post({ event: "pkg-status", name: n, state: "installing" });
    try {
      await withLoadLock(() =>
        runPythonDimmed(`import micropip\nawait micropip.install(${JSON.stringify(n)})`),
      );
      installed.push(n);
      post({ event: "pkg-status", name: n, state: "done" });
    } catch (err) {
      failed.push(n);
      post({ event: "pkg-status", name: n, state: "error", error: String(err) });
    }
  }
  return { installed, failed };
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case "init": {
        const r = await doInit(m);
        post({ id: m.id, ok: true, result: r });
        break;
      }
      case "run": {
        // run posts its own completion (with transfers).
        await doRun(m);
        break;
      }
      case "lsp": {
        const r = await doLsp(m);
        post({ id: m.id, ok: true, result: r });
        break;
      }
      case "ensure-packages": {
        const r = await doEnsurePackages(m.names);
        post({ id: m.id, ok: true, result: r });
        break;
      }
      case "list-packages": {
        await withLoadLock(() =>
          pyodide.loadPackage("micropip", {
            messageCallback: () => {},
            errorCallback: () => {},
          }),
        );
        const proxy = await pyodide.runPythonAsync(
          "import micropip, json\njson.dumps([{k: {'name': v.name, 'version': v.version, 'source': str(getattr(v, 'source', ''))}} for k, v in micropip.list().items()])",
        );
        post({ id: m.id, ok: true, result: JSON.parse(proxy as string) });
        break;
      }
      case "uninstall": {
        await withLoadLock(() =>
          pyodide.loadPackage("micropip", {
            messageCallback: () => {},
            errorCallback: () => {},
          }),
        );
        await pyodide.runPythonAsync(
          `import micropip\nmicropip.uninstall(${JSON.stringify(m.names)})`,
        );
        post({ id: m.id, ok: true, result: { removed: m.names } });
        break;
      }
      case "reset": {
        try {
          (runGlobals as { destroy?: () => void } | null)?.destroy?.();
        } catch { /* ignore */ }
        runGlobals = null;
        post({ id: m.id, ok: true, result: {} });
        break;
      }
      case "sync-files": {
        // Mirror .py sources so Jedi can resolve cross-file imports/definitions.
        const WS = "/home/pyodide/workspace";
        pyodide.FS.mkdirTree(WS);
        for (const f of m.files) {
          try {
            const full = `${WS}/${f.path}`;
            pyodide.FS.mkdirTree(full.split("/").slice(0, -1).join("/"));
            pyodide.FS.writeFile(full, f.content);
          } catch { /* ignore */ }
        }
        post({ id: m.id, ok: true, result: { files: m.files.length } });
        break;
      }
      case "memory": {
        // WASM linear memory of the CPython runtime — the number that matters.
        let wasm = 0;
        try {
          const mod = (pyodide as { _module?: { HEAPU8?: { length: number } } } | null)?._module;
          wasm = mod?.HEAPU8?.length ?? 0;
        } catch { /* ignore */ }
        post({ id: m.id, ok: true, result: { wasm, loaded: !!pyodide } });
        break;
      }
      case "ping": {
        post({ id: m.id, ok: !!pyodide });
        break;
      }
    }
  } catch (err) {
    emitOut();
    post({ id: (m as { id?: number }).id ?? -1, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
