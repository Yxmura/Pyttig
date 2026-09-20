// Persistent settings store (localStorage). Workspace files live in OPFS.

export interface PyttigSettings {
  theme: "dark" | "light" | "system";
  fontSize: number;
  fontFamily: string;
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: boolean;
  minimap: boolean;
  autoSave: boolean;
  autoSaveDelay: number;
  formatOnSave: boolean;
  lintOnType: boolean;
  ruffEnabled: boolean;
  jediEnabled: boolean;
  typeChecker: "off" | "pyright-worker";
  lineLength: number;
  quoteStyle: "double" | "single";
  runArgs: string;
  keepNamespace: boolean;
  preloadStack: boolean;
  preloadStackDone: boolean;
  idleUnloadMinutes: number;
  corsProxy: string;
  rememberToken: boolean;
  keybindings: Record<string, string>;
}

const DEFAULTS: PyttigSettings = {
  theme: "system",
  fontSize: 13.5,
  fontFamily: "",
  tabSize: 4,
  insertSpaces: true,
  wordWrap: false,
  minimap: false,
  autoSave: true,
  autoSaveDelay: 1200,
  formatOnSave: false,
  lintOnType: true,
  ruffEnabled: true,
  jediEnabled: true,
  typeChecker: "off",
  lineLength: 88,
  quoteStyle: "double",
  runArgs: "",
  keepNamespace: false,
  preloadStack: false, // classroom-friendly: packages install on demand at first run
  preloadStackDone: false,
  idleUnloadMinutes: 15,
  corsProxy: "auto",
  rememberToken: false,
  keybindings: {},
};

const KEY = "pyttig.settings.v1";
const listeners = new Set<(s: PyttigSettings) => void>();

let cache: PyttigSettings | null = null;

export function loadSettings(): PyttigSettings {
  if (cache) return cache;
  let merged: PyttigSettings = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) merged = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* corrupted storage — fall back to defaults */
  }
  cache = merged;
  return merged;
}

export function saveSettings(patch: Partial<PyttigSettings>): PyttigSettings {
  const s = { ...loadSettings(), ...patch };
  cache = s;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full/blocked — run with in-memory settings */
  }
  applyTheme(s);
  for (const l of listeners) l(s);
  return s;
}

export function onSettingsChange(fn: (s: PyttigSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function resetSettings(): PyttigSettings {
  const fresh: PyttigSettings = { ...DEFAULTS };
  cache = fresh;
  try {
    localStorage.removeItem(KEY);
  } catch { /* ignore */ }
  applyTheme(fresh);
  for (const l of listeners) l(fresh);
  return fresh;
}

/** Resolve effective theme (system → matchMedia). */
export function effectiveTheme(s: PyttigSettings = loadSettings()): "dark" | "light" {
  if (s.theme === "dark" || s.theme === "light") return s.theme;
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(s: PyttigSettings = loadSettings()): void {
  document.documentElement.dataset.theme = effectiveTheme(s);
}

export function toggleTheme(): "dark" | "light" {
  const cur = effectiveTheme();
  const next = cur === "dark" ? "light" : "dark";
  saveSettings({ theme: next });
  return next;
}

// Keep in sync with OS changes when theme == system.
if (typeof window !== "undefined" && window.matchMedia) {
  try {
    window
      .matchMedia("(prefers-color-scheme: light)")
      .addEventListener("change", () => applyTheme());
  } catch { /* older browsers */ }
}
