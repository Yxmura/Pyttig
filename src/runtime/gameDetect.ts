// Pure helper (no browser imports) so it stays unit-testable.

/** Heuristic: does this file want a pygame window? Headless pygame helpers
 *  (colors, version checks) stay in the worker; anything that initialises
 *  pygame or touches the display gets the main-thread game runtime. */
export function looksLikeGame(code: string): boolean {
  if (!/\bpygame\b/.test(code)) return false;
  return /pygame\s*\.\s*(display|init)|set_mode|Clock\s*\(/.test(code);
}
