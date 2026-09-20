// Global VS Code-like keybindings. Editor-local bindings live with the editor manager.

import { openPalette, runCommand } from "./commands";
import { loadSettings } from "./settings";

export interface KeyBinding {
  id: string;
  binding: string;
}

const DEFAULTS: KeyBinding[] = [
  { id: "palette.open", binding: "Ctrl+Shift+P" },
  { id: "palette.open", binding: "F1" },
  { id: "files.quickOpen", binding: "Ctrl+P" },
  { id: "file.save", binding: "Ctrl+S" },
  { id: "file.saveAll", binding: "Ctrl+K S" },
  { id: "view.toggleSidebar", binding: "Ctrl+B" },
  { id: "view.togglePanel", binding: "Ctrl+`" },
  { id: "view.toggleTheme", binding: "Ctrl+K Ctrl+T" },
  { id: "python.run", binding: "F5" },
  // Chromebooks have no function keys — give running a keyboard shortcut too.
  { id: "python.run", binding: "Ctrl+Enter" },
  { id: "python.stop", binding: "Shift+F5" },
  { id: "python.runSelection", binding: "F9" },
  { id: "editor.format", binding: "Shift+Alt+F" },
  { id: "editor.gotoDefinition", binding: "F12" },
  { id: "editor.rename", binding: "F2" },
  { id: "editor.gotoLine", binding: "Ctrl+G" },
  { id: "editor.symbols", binding: "Ctrl+Shift+O" },
  { id: "files.search", binding: "Ctrl+Shift+F" },
  { id: "tab.close", binding: "Ctrl+W" },
  { id: "tab.next", binding: "Ctrl+Tab" },
];

function normalize(e: KeyboardEvent): string | null {
  // Ignore pure modifiers and typing in inputs (except a few global ones).
  const tag = (e.target as HTMLElement)?.tagName;
  const inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  parts.push(key === " " ? "Space" : key);
  const combo = parts.join("+");
  if (inField) {
    // Allow only a safe subset while typing.
    const allowed = new Set(["Ctrl+S", "Ctrl+P", "Escape"]);
    if (!allowed.has(combo)) return null;
  }
  return combo;
}

function chordKey(e: KeyboardEvent): string | null {
  // Second stroke of Ctrl+K chords is captured by a one-shot listener.
  return normalize(e);
}

export function initKeymap(): void {
  let pendingChord = false;

  window.addEventListener("keydown", (e) => {
    const combo = pendingChord ? chordKey(e) : normalize(e);
    if (!combo) return;

    const settings = loadSettings();
    const custom: KeyBinding[] = Object.entries(settings.keybindings).map(([id, binding]) => ({ id, binding }));
    const all = [...custom, ...DEFAULTS];

    if (!pendingChord && combo === "Ctrl+K") {
      pendingChord = true;
      e.preventDefault();
      window.setTimeout(() => (pendingChord = false), 1200);
      return;
    }
    const full = pendingChord ? `Ctrl+K ${combo.replace(/^Ctrl\+/, "")}` : combo;
    pendingChord = false;

    const match = all.find((b) => b.binding === full);
    if (!match) {
      if (combo === "Escape") {
        // Escape closes palette/overlays handled by their own listeners.
      }
      return;
    }
    // Don't hijack F5/Ctrl+R browser reload semantics beyond our command.
    e.preventDefault();
    e.stopPropagation();
    void runCommand(match.id);
  }, true);
}

/** Open the command palette pre-filled for ">" commands. */
export function wirePaletteShortcut(): void {
  // handled via commands registered in main.ts
  void openPalette;
}
