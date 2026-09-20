// Pure helpers (no browser imports) so they stay unit-testable.

export interface SourceFile {
  path: string;
  content: string;
}

const TURTLE_IMPORT = /^\s*(?:import|from)\s+turtle\b/m;
const LOCAL_IMPORT = /^\s*(?:from|import)\s+([A-Za-z_][\w]*)/gm;

/** Does this code import turtle, directly or through a workspace module? */
export function usesTurtle(code: string, files: SourceFile[] = []): boolean {
  if (TURTLE_IMPORT.test(code)) return true;
  const names = new Set<string>();
  for (const m of code.matchAll(LOCAL_IMPORT)) names.add(m[1]);
  for (const name of names) {
    const local = files.find((f) => f.path === `${name}.py` || f.path.endsWith(`/${name}.py`));
    if (local && TURTLE_IMPORT.test(local.content)) return true;
  }
  return false;
}

/** Heuristic: does this file want a game/drawing window? Headless pygame
 *  helpers (colors, version checks) stay in the worker; anything that
 *  initialises pygame or touches the display gets the main-thread runtime. */
export function looksLikeGame(code: string, files: SourceFile[] = []): boolean {
  // turtle always means a drawing window (and needs the pygame-based shim,
  // since Tkinter cannot exist in a browser).
  if (usesTurtle(code, files)) return true;
  if (!/\bpygame\b/.test(code)) return false;
  return /pygame\s*\.\s*(display|init)|set_mode|Clock\s*\(/.test(code);
}
