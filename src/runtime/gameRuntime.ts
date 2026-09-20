// Main-thread Pyodide runtime for pygame programs.
//
// Pyodide's SDL support only works on the main thread with a real canvas, and
// a game loop must yield to the browser between frames. Everything else in
// Pyttig keeps running in the worker; this module exists only for game code
// (see looksLikeGame) and is torn down with the rest of the runtime.

import gameRunnerSource from "./game_runner.py?raw";
import turtleShimSource from "./turtle_shim.py?raw";
import { extractPipInstalls } from "./pipLines";
import { resolvePyodideUrls } from "./pyodideVersion";
import { terminal } from "./terminal";
import { looksLikeGame, usesTurtle } from "./gameDetect";

interface PyodideLike {
  version: string;
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: string): void;
  };
  globals: { set(key: string, value: unknown): void };
  canvas: { setCanvas2D(el: HTMLCanvasElement): void };
  _api: { _skip_unwind_fatal_error?: boolean };
  loadPackage(
    names: string | string[],
    opts?: { messageCallback?: (s: string) => void; errorCallback?: (s: string) => void },
  ): Promise<unknown>;
  loadPackagesFromImports(
    code: string,
    opts?: { messageCallback?: (s: string) => void; errorCallback?: (s: string) => void },
  ): Promise<unknown>;
  runPythonAsync(code: string, opts?: { globals?: unknown }): Promise<unknown>;
  setStdout(opts: { batched: (s: string) => void }): void;
  setStderr(opts: { batched: (s: string) => void }): void;
}

const WORKSPACE = "/home/pyodide/workspace";

let pyodide: PyodideLike | null = null;
let loading: Promise<PyodideLike> | null = null;
let canvas: HTMLCanvasElement | null = null;
let stopRequested = false;
let running = false;

export function gameCanvas(): HTMLCanvasElement | null {
  return canvas;
}

export function gameRuntimeRunning(): boolean {
  return running;
}

export function stopGame(): void {
  stopRequested = true;
}

export function disposeGameRuntime(): void {
  stopRequested = true;
  running = false;
  pyodide = null;
  loading = null;
  canvas?.remove();
  canvas = null;
  (window as unknown as { __pyttigGameStop?: () => boolean }).__pyttigGameStop = () => true;
}

function dim(line: string): string {
  return `\x1b[90m${line}\x1b[0m\r\n`;
}

async function ensureRuntime(onNote: (line: string) => void): Promise<PyodideLike> {
  if (pyodide) return pyodide;
  if (loading) return loading;
  loading = (async () => {
    const urls = resolvePyodideUrls();
    const mod = (await import(/* @vite-ignore */ urls.module)) as {
      loadPyodide(opts: { indexURL: string }): Promise<PyodideLike>;
    };
    const py = await mod.loadPyodide({ indexURL: urls.index });
    // Required for SDL packages (Pyodide docs: "Using SDL-based packages").
    py._api._skip_unwind_fatal_error = true;
    py.setStdout({ batched: (s) => terminal.write(dim(s)) });
    py.setStderr({ batched: (s) => terminal.write(dim(s)) });
    py.FS.writeFile("/tmp/pyttig_game_runner.py", gameRunnerSource);
    py.FS.writeFile("/tmp/pyttig_turtle.py", turtleShimSource);
    pyodide = py;
    onNote(`game runtime ready · Pyodide ${py.version}`);
    return py;
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** The canvas lives in the Game panel; the panel hands it back when re-drawn. */
function ensureCanvas(host: HTMLElement): HTMLCanvasElement {
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "canvas";
    canvas.className = "game-canvas";
    canvas.tabIndex = 0;
  }
  if (canvas.parentElement !== host) host.appendChild(canvas);
  return canvas;
}

export interface GameRunOptions {
  code: string;
  filename: string;
  files: { path: string; content: string }[];
  onNote: (line: string) => void;
}

/** Run a pygame program on the main thread. Resolves when it ends. */
export async function runGame(opts: GameRunOptions): Promise<void> {
  stopRequested = false;
  (window as unknown as { __pyttigGameStop?: () => boolean }).__pyttigGameStop = () => stopRequested;
  const host = document.getElementById("game-host");
  if (!host) throw new Error("game panel is not visible");
  const py = await ensureRuntime(opts.onNote);

  py.FS.mkdirTree(WORKSPACE);
  for (const f of opts.files) {
    const full = `${WORKSPACE}/${f.path}`;
    py.FS.mkdirTree(full.split("/").slice(0, -1).join("/"));
    py.FS.writeFile(full, f.content);
  }

  const turtleProgram = usesTurtle(opts.code, opts.files);
  const pip = extractPipInstalls(opts.code);
  // turtle programs don't import pygame, but the shim draws with it.
  const scanCode = turtleProgram ? `import pygame\n${opts.code}` : opts.code;
  try {
    await py.loadPackagesFromImports(scanCode, {
      messageCallback: opts.onNote,
      errorCallback: opts.onNote,
    });
  } catch {
    /* local modules and unknown imports are fine — same as the worker */
  }
  if (pip.packages.length) {
    opts.onNote(`pip install ${pip.packages.join(" ")}`);
    await py.loadPackage("micropip");
    await py.runPythonAsync(
      `import micropip\nawait micropip.install(${JSON.stringify(pip.packages)})`,
    );
  }

  const el = ensureCanvas(host);
  py.canvas.setCanvas2D(el);
  el.focus();

  running = true;
  try {
    const runner = [
      "import sys, os, importlib",
      "if '/tmp' not in sys.path: sys.path.insert(0, '/tmp')",
      "os.chdir('/home/pyodide/workspace')",
      "gr = sys.modules.get('pyttig_game_runner') or importlib.import_module('pyttig_game_runner')",
      "__pyttig_frame = gr.__pyttig_frame",
      `__pyttig_code = gr.prepare(${JSON.stringify(pip.code)}, ${JSON.stringify(opts.filename)}, turtle=${turtleProgram ? "True" : "False"})`,
      "globals().setdefault('__name__', '__main__')",
      "await gr.run_program(__pyttig_code, globals())",
    ].join("\n");
    await py.runPythonAsync(runner);
  } finally {
    running = false;
  }
}
