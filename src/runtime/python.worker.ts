// Pyodide module worker: executes user code AND serves Jedi LSP requests.
// One shared interpreter keeps memory low. Long runs block LSP (documented;
// Ruff diagnostics stay live in their own worker).

import jediServerSource from "../lsp/jedi_server.py?raw";
import sdistBuildSource from "./sdist_build.py?raw";
import { PYODIDE_VERSION, pyodideModuleUrl } from "./pyodideVersion";
import { extractPipInstalls } from "./pipLines";
import { resolvePackageName } from "./packageAliases";

interface RunFile {
  path: string;
  content: string; // text; binary files are skipped by the client
}

type InMsg =
  | { id: number; type: "init"; indexURL: string; moduleURL?: string; isolated: boolean; interruptBuffer?: SharedArrayBuffer; stdinBuffer?: SharedArrayBuffer; stdinMeta?: SharedArrayBuffer }
  | { id: number; type: "run"; runId: number; code: string; filename: string; args: string[]; files: RunFile[]; keepNs: boolean; stdinLines: string[] }
  | { id: number; type: "lsp"; op: string; params: Record<string, unknown> }
  | { id: number; type: "ensure-packages"; names: string[]; quiet?: boolean }
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
async function runPythonDimmed(code: string): Promise<unknown> {
  let captured = "";
  let prevOutRestore: (() => void) | null = null;
  let result: unknown;
  try {
    const prevOut = { batched: (s: string) => pipeStdout(s) };
    const prevErr = { batched: (s: string) => pipeStderr(s) };
    pyodide.setStdout({ batched: (s: string) => { captured += s + "\n"; } });
    pyodide.setStderr({ batched: (s: string) => { captured += s + "\n"; } });
    prevOutRestore = () => {
      pyodide.setStdout(prevOut);
      pyodide.setStderr(prevErr);
    };
    result = await pyodide.runPythonAsync(code);
  } finally {
    prevOutRestore?.();
  }
  for (const line of captured.split("\n")) {
    if (line.trim()) sysOut(line);
  }
  return result;
}

/** Install one package: Pyodide distribution → PyPI wheel → built sdist.
 *  Never call this while holding the load lock (it takes it per step). */
async function installOne(name: string, note: (s: string) => void, depth = 0): Promise<void> {
  if (!pyodide) throw new Error("Python runtime is not ready yet");
  // `pip install pygame` / `PIL` / `bs4` should install what the module needs.
  const dist = resolvePackageName(name);
  try {
    await withLoadLock(() => pyodide!.loadPackage([dist], { messageCallback: note, errorCallback: note }));
    return;
  } catch {
    /* not in the Pyodide distribution */
  }
  let fromWheel = false;
  try {
    await withLoadLock(() =>
      runPythonDimmed(`import micropip\nawait micropip.install(${JSON.stringify(dist)})`),
    );
    fromWheel = true;
  } catch {
    /* no wheel for this platform */
  }
  if (!fromWheel) await installFromSdist(dist, note, depth);
  await healMissingDependency(dist, note, depth);
}

/** Some packages install without everything they import (incomplete metadata
 *  upstream, or a sparse Pyodide lock). Import it once and fill the gaps. */
async function healMissingDependency(dist: string, note: (s: string) => void, depth: number): Promise<void> {
  if (depth > 2) return;
  const code = [
    "import sys, importlib",
    "if '/tmp' not in sys.path: sys.path.insert(0, '/tmp')",
    "mod = sys.modules.get('pyttig_sdist_build') or importlib.import_module('pyttig_sdist_build')",
    `mod.missing_dependency(${JSON.stringify(dist)})`,
  ].join("\n");
  let missing = "";
  try {
    missing = String(await runPythonDimmed(code));
  } catch {
    return; // importing it raised something odd; not a missing-dependency case
  }
  if (!missing || missing === dist || missing.includes(".")) return;
  sysOut(`  also needs ${missing}`);
  await installOne(missing, note, depth + 1);
}

/** Build a package's sdist here (pure-Python only) and install the result.
 *  Dependencies micropip can't find are resolved through installOne, so a
 *  built wheel can still pull e.g. aiohttp from the Pyodide distribution. */
async function installFromSdist(name: string, note: (s: string) => void, depth: number): Promise<void> {
  if (!pyodide) throw new Error("Python runtime is not ready yet");
  if (depth > 4) throw new Error(`dependency chain too deep at ${name}`);
  const outDir = "/tmp/pyttig-wheels";
  const build = [
    "import sys, importlib",
    "if '/tmp' not in sys.path: sys.path.insert(0, '/tmp')",
    "mod = sys.modules.get('pyttig_sdist_build') or importlib.import_module('pyttig_sdist_build')",
    `await mod.build_wheel_from_sdist(${JSON.stringify(name)}, ${JSON.stringify(outDir)})`,
  ].join("\n");
  const wheelPath = String(await runPythonDimmed(build));
  const url = `file://${wheelPath}`;
  // Resolve the wheel's own dependencies first (micropip would only look at
  // PyPI; our chain also knows the Pyodide distribution and can build sdists).
  const depsRaw = String(
    await runPythonDimmed(
      `import sys, importlib, json\nif '/tmp' not in sys.path: sys.path.insert(0, '/tmp')\nmod = sys.modules.get('pyttig_sdist_build') or importlib.import_module('pyttig_sdist_build')\njson.dumps(mod.dependencies_of(${JSON.stringify(wheelPath)}))`,
    ),
  );
  for (const dep of JSON.parse(depsRaw || "[]") as string[]) {
    if (dep.toLowerCase() === name.toLowerCase()) continue;
    sysOut(`  needs ${dep}`);
    await installOne(dep, note, depth + 1);
  }
  await runPythonDimmed(`import micropip\nawait micropip.install(${JSON.stringify(url)}, deps=False)`);
}

/** Install a package micropip has no wheel for by building its sdist here.
 *  Works for pure-Python packages; compiler-dependent builds fail clearly. */
async function installFromSdistOnly(name: string): Promise<void> {
  await installFromSdist(name, () => {}, 0);
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
  pyodide.FS.writeFile("/tmp/pyttig_sdist_build.py", sdistBuildSource);
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
  // Don't start while a package install (e.g. the boot-time restore) is in
  // flight, or `import x` would fail spuriously.
  await pkgWork;
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
      for (const spec of pip.packages) await installOne(spec, (s) => sysOut(String(s)));
      sysOut("ok");
      post({ event: "pkg-installed", names: pip.packages });
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
    // Make the file behave like a script run from the workspace: libraries
    // (Flask, argparse, pathlib, __main__ guards) read these.
    const globals = runGlobals as {
      set(k: string, v: unknown): void;
      destroy?: () => void;
    };
    globals.set("__name__", "__main__");
    globals.set("__file__", `${WS}/${m.filename}`);
    globals.set("__package__", null);
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

async function doEnsurePackages(names: string[], quiet = false) {
  if (!pyodide) throw new Error("Python runtime is not ready yet");
  const note = quiet ? () => {} : (s: string) => sysOut(String(s));
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
          messageCallback: note,
          errorCallback: note,
        }),
      );
      return { installed: need, failed: [] as string[], errors: {} as Record<string, string> };
    } catch {
      /* fall through to per-package micropip */
    }
  }
  const installed: string[] = [];
  const failed: string[] = [];
  const errors: Record<string, string> = {};
  await ensureMicropip();
  for (const n of need) {
    post({ event: "pkg-status", name: n, state: "installing" });
    try {
      await installOne(n, note);
      installed.push(n);
      post({ event: "pkg-status", name: n, state: "done" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push(n);
      errors[n] = explainInstallError(msg);
      // Full detail in the panel; the toast gets the short version.
      for (const line of msg.split("\n").slice(-5)) if (line.trim()) sysOut(line);
      post({ event: "pkg-status", name: n, state: "error", error: errors[n] });
    }
  }
  return { installed, failed, errors };
}

/** Turn micropip's terse failures into something a student can act on. */
function explainInstallError(msg: string): string {
  const flat = msg.replace(/\s+/g, " ").trim();
  if (
    /C compiler|clang|emcc|cc1plus|gcc|cargo|maturin|meson|ninja|Python\.h|arrayobject\.h|unable to execute|no such file or directory: 'cc'/i.test(flat)
  ) {
    return "needs compiled code and has no browser build";
  }
  // Prefer the exception line at the end of a traceback over the whole dump.
  const lines = msg.split("\n").map((l) => l.trim()).filter(Boolean);
  const reversed = [...lines].reverse();
  const exc =
    reversed.find((l) => /^[A-Za-z_][\w.]*(Error|Exception): /.test(l)) ??
    reversed.find((l) => /^[A-Za-z_][\w.]*: /.test(l) && !/^See: /.test(l));
  const short = exc ?? flat;
  if (/Couldn't find a pure Python 3 wheel|No wheel|not found in PyPI/i.test(short)) {
    return "no wheel for the browser — it would need compiling C code, which browsers can't do";
  }
  if (/no source distribution|is not on PyPI/i.test(short)) {
    return "not available for the browser (no wheel, no source package on PyPI)";
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(short)) {
    return "download failed (check your connection)";
  }
  return short.slice(0, 200);
}

/** In-flight package work that a run must not overtake. */
let pkgWork: Promise<unknown> = Promise.resolve();

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
        const p = doEnsurePackages(m.names, m.quiet);
        pkgWork = Promise.allSettled([pkgWork, p]);
        const r = await p;
        post({ id: m.id, ok: true, result: r });
        break;
      }
      case "list-packages": {
        await ensureMicropip();
        const proxy = await pyodide.runPythonAsync(
          "import micropip, json\njson.dumps([{'name': v.name, 'version': v.version, 'source': str(getattr(v, 'source', ''))} for v in micropip.list().values()])",
        );
        const mp = JSON.parse(proxy as string) as { name: string; version: string; source: string }[];
        const seen = new Set(mp.map((p) => p.name.toLowerCase()));
        const internal = new Set(["micropip", "jedi", "parso", "pyodide-http", "packaging", "pyodide-py"]);
        for (const [name, version] of Object.entries(pyodide.loadedPackages ?? {})) {
          const key = name.toLowerCase();
          if (seen.has(key) || internal.has(key)) continue;
          mp.push({ name, version: String(version), source: "pyodide" });
        }
        mp.sort((a, b) => a.name.localeCompare(b.name));
        post({ id: m.id, ok: true, result: mp });
        break;
      }
      case "uninstall": {
        await ensureMicropip();
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
