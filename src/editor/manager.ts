// Editor manager: tabs, one CodeMirror 6 view per open file, breadcrumbs,
// workspace search, autosave, and hooks the LSP bridge plugs into.

import { EditorView, basicSetup } from "codemirror";
import { EditorState, type Extension, Compartment } from "@codemirror/state";
import { python } from "@codemirror/lang-python";
import { indentUnit } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import { catppuccinLatte, catppuccinMocha } from "@catppuccin/codemirror";
import type { Shell } from "../app/shell";
import { icons } from "../app/icons";
import { registerCommands, openPalette } from "../app/commands";
import { loadSettings, onSettingsChange } from "../app/settings";
import { notify } from "../app/toast";
import { inputDialog, confirmDialog } from "../app/dialog";
import { wsRead, wsWrite, wsListAll, onWorkspaceChange } from "../fs/workspace";
import { fileIconSrc } from "../fs/fileIcons";
import { renderWelcome } from "../app/welcome";
import { showContextMenu, type MenuItem } from "../app/contextMenu";
import { jumpToDefinition, findReferences, renameSymbol } from "@codemirror/lsp-client";

export interface TabState {
  path: string;
  view: EditorView;
  dirty: boolean;
  ui: Compartment;
  lsp: Compartment;
  vis: Compartment;
}

const tabs = new Map<string, TabState>();
let activePath: string | null = null;
let shellRef: Shell | null = null;

const HIDDEN_ATTRS = EditorView.editorAttributes.of({ class: "editor-hidden" });
const SHOWN_ATTRS = EditorView.editorAttributes.of({});

/**
 * Show only the given tab.
 * NOTE: CodeMirror rewrites the editor element's `class` itself (dynamic style
 * classes, focus state), so foreign class mutations/inline styles get wiped.
 * The supported way to put a class on the editor DOM is the
 * `EditorView.editorAttributes` facet — reconfigured here per view.
 */
function showOnly(path: string): void {
  for (const [p, t] of tabs) {
    const target = p === path ? SHOWN_ATTRS : HIDDEN_ATTRS;
    t.view.dispatch({ effects: t.vis.reconfigure(target) });
  }
}

/** Hooks implemented by the LSP bridge (M3). Defaults are safe no-ops. */
export const editorHooks: {
  format: (path: string) => Promise<boolean>;
  documentSymbols: (path: string) => Promise<{ name: string; kind: string; line: number }[]>;
} = {
  format: async () => false,
  documentSymbols: async () => [],
};

/** Runs before a file is written (e.g. format-on-save). */
export const beforeSaveHooks: ((path: string) => Promise<void>)[] = [];

let lspProvider: (path: string) => Extension[] = () => [];
/** Called by the LSP bridge once the client is ready. */
export function setLspExtensionProvider(fn: (path: string) => Extension[]): void {
  lspProvider = fn;
  for (const t of tabs.values()) {
    t.view.dispatch({ effects: t.lsp.reconfigure(lspProvider(t.path)) });
  }
}

export function uriFor(path: string): string {
  return `file:///workspace/${path}`;
}
export function pathFor(uri: string): string {
  return uri.replace(/^file:\/\/\/workspace\//, "");
}

function isPython(path: string): boolean {
  return path.endsWith(".py") || path.endsWith(".pyi");
}

/** Font/size tweaks layered on top of the official Catppuccin theme. */
function buildTheme(dark: boolean, fontSize: number) {
  return EditorView.theme(
    {
      "&": {
        fontSize: `${fontSize}px`,
        height: "100%",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-content": { padding: "6px 0 40vh 0" },
      ".cm-diagnostic": { fontFamily: "var(--font-ui)", fontSize: "12px" },
      ".cm-tooltip": { borderRadius: "6px" },
    },
    { dark },
  );
}

function uiExtensions(): Extension[] {
  const s = loadSettings();
  const dark = document.documentElement.dataset.theme !== "light";
  const exts: Extension[] = [
    dark ? catppuccinMocha : catppuccinLatte,
    buildTheme(dark, s.fontSize),
  ];
  if (s.fontFamily) exts.push(EditorView.theme({ ".cm-scroller": { fontFamily: s.fontFamily } }));
  if (s.wordWrap) exts.push(EditorView.lineWrapping);
  return exts;
}

// ---------- editor context menu ----------

function copySelection(view: EditorView): void {
  const sel = view.state.selection.main;
  if (sel.empty) return;
  const text = view.state.sliceDoc(sel.from, sel.to);
  void navigator.clipboard.writeText(text).then(
    () => notify.success("Copied."),
    () => notify.info("Clipboard access was denied."),
  );
}

function cutSelection(view: EditorView): void {
  const sel = view.state.selection.main;
  if (sel.empty) return;
  const text = view.state.sliceDoc(sel.from, sel.to);
  void navigator.clipboard.writeText(text).then(
    () => {
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: "" } });
      view.focus();
    },
    () => notify.info("Clipboard access was denied."),
  );
}

async function pasteClipboard(view: EditorView): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (text) view.dispatch(view.state.replaceSelection(text));
  } catch {
    notify.info("Press Ctrl+V to paste (clipboard access was denied).");
  }
  view.focus();
}

function editorMenuItems(view: EditorView, path: string): MenuItem[] {
  const hasSelection = !view.state.selection.main.empty;
  const python = path.endsWith(".py") || path.endsWith(".pyi");
  return [
    {
      label: "Undo",
      icon: "undo",
      hint: "Ctrl+Z",
      disabled: undoDepth(view.state) === 0,
      run: () => { undo(view); view.focus(); },
    },
    {
      label: "Redo",
      icon: "redo",
      hint: "Ctrl+Y",
      disabled: redoDepth(view.state) === 0,
      run: () => { redo(view); view.focus(); },
    },
    { separator: true },
    { label: "Cut", icon: "cut", hint: "Ctrl+X", disabled: !hasSelection, run: () => cutSelection(view) },
    { label: "Copy", icon: "copy", hint: "Ctrl+C", disabled: !hasSelection, run: () => copySelection(view) },
    { label: "Paste", icon: "paste", hint: "Ctrl+V", run: () => void pasteClipboard(view) },
    { separator: true },
    {
      label: "Go to Definition",
      hint: "F12 / Ctrl+Click",
      disabled: !python,
      run: () => { jumpToDefinition(view); },
    },
    {
      label: "Find References",
      hint: "Shift+F12",
      disabled: !python,
      run: () => { findReferences(view); },
    },
    {
      label: "Rename Symbol",
      icon: "edit",
      hint: "F2",
      disabled: !python,
      run: () => { renameSymbol(view); },
    },
    { separator: true },
    {
      label: "Format Document",
      icon: "zap",
      hint: "Shift+Alt+F",
      disabled: !python,
      run: () => void runCommand("editor.format"),
    },
    { separator: true },
    {
      label: "Command Palette…",
      icon: "command",
      hint: "Ctrl+Shift+P",
      run: () => void runCommand("palette.open"),
    },
  ];
}

function baseExtensions(path: string): Extension[] {
  const s = loadSettings();
  return [
    basicSetup,
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    ...(isPython(path) ? [python()] : []),
    EditorState.tabSize.of(s.tabSize),
    indentUnit.of(" ".repeat(s.tabSize)),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) markDirty(path);
      if (u.selectionSet || u.docChanged) updateCursorStatus();
    }),
    EditorView.domEventHandlers({
      keydown: (e, view) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void saveFile(path);
          return true;
        }
        return false;
      },
      contextmenu: (e, view) => {
        e.preventDefault();
        showContextMenu(editorMenuItems(view, path), { x: e.clientX, y: e.clientY });
        return true;
      },
      mousedown: (e, view) => {
        // Ctrl/Cmd+Click jumps to the definition — works without F-keys and
        // matches VS Code muscle memory.
        if ((e.ctrlKey || e.metaKey) && e.button === 0 && (path.endsWith(".py") || path.endsWith(".pyi"))) {
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos != null) {
            view.dispatch({ selection: { anchor: pos } });
            jumpToDefinition(view);
            return true;
          }
        }
        return false;
      },
    }),
  ];
}

export async function openFile(path: string, line?: number, col?: number): Promise<void> {
  const shell = shellRef!;
  if (!tabs.has(path)) {
    let text = "";
    try {
      text = await wsRead(path);
    } catch {
      notify.error(`Cannot open "${path}".`);
      return;
    }
    const ui = new Compartment();
    const lsp = new Compartment();
    const vis = new Compartment();
    const view = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          baseExtensions(path),
          ui.of(uiExtensions()),
          lsp.of(lspProvider(path)),
          vis.of(SHOWN_ATTRS),
        ],
      }),
      parent: shell.editorHost,
    });
    tabs.set(path, { path, view, dirty: false, ui, lsp, vis });
    showOnly(path);
  }
  activePath = path;
  showOnly(path);
  renderTabs();
  renderCrumbs();
  if (line !== undefined) {
    const t = tabs.get(path)!;
    try {
      const cmLine = t.view.state.doc.line(Math.max(1, Math.min(line, t.view.state.doc.lines)));
      const pos = cmLine.from + Math.max(0, Math.min(col ?? 0, cmLine.length));
      t.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    } catch { /* out of range */ }
  }
  tabs.get(path)?.view.focus();
  (document.querySelector(".welcome") as HTMLElement | null)?.remove();
}

export function getActivePath(): string | null {
  return activePath;
}
export function getActiveCode(): string {
  if (!activePath) return "";
  return tabs.get(activePath)?.view.state.doc.toString() ?? "";
}

/** Current (possibly dirty) buffer text for any open tab. */
export function getTabText(path: string): string | null {
  return tabs.get(path)?.view.state.doc.toString() ?? null;
}

/** Replace the entire buffer of an open tab (used by format/rename). */
export function replaceDocText(path: string, text: string): boolean {
  const t = tabs.get(path);
  if (!t) return false;
  if (t.view.state.doc.toString() === text) return false;
  t.view.dispatch({ changes: { from: 0, to: t.view.state.doc.length, insert: text } });
  return true;
}

/** Selected text, or the current line when the selection is empty. */
export function getEditorSelection(): string | null {
  if (!activePath) return null;
  const t = tabs.get(activePath);
  if (!t) return null;
  const sel = t.view.state.selection.main;
  if (!sel.empty) return t.view.state.doc.sliceString(sel.from, sel.to);
  const line = t.view.state.doc.lineAt(sel.head);
  return line.text;
}

export async function saveFile(path: string): Promise<void> {
  const t = tabs.get(path);
  if (!t || !t.dirty) return;
  for (const h of beforeSaveHooks) {
    try {
      await h(path);
    } catch (err) {
      console.error("beforeSave hook failed:", err);
    }
  }
  await wsWrite(path, t.view.state.doc.toString());
  t.dirty = false;
  renderTabs();
}

export async function saveAll(): Promise<void> {
  for (const p of tabs.keys()) await saveFile(p);
}

export async function closeTab(path: string, force = false): Promise<void> {  const t = tabs.get(path);
  if (!t) return;
  if (t.dirty && !force) {
    const choice = await confirmDialog("Unsaved changes", `"${path}" has unsaved changes. Close without saving?`, "Close", true);
    if (!choice) return;
  }
  t.view.destroy();
  tabs.delete(path);
  if (activePath === path) {
    activePath = [...tabs.keys()].pop() ?? null;
    if (activePath) showOnly(activePath);
  }
  renderTabs();
  renderCrumbs();
}

function markDirty(path: string) {
  const t = tabs.get(path);
  if (!t) return;
  if (!t.dirty) {
    t.dirty = true;
    renderTabs();
  }
  scheduleAutosave(path);
}

const autosaveTimers = new Map<string, number>();
function scheduleAutosave(path: string) {
  const s = loadSettings();
  if (!s.autoSave) return;
  window.clearTimeout(autosaveTimers.get(path));
  autosaveTimers.set(
    path,
    window.setTimeout(() => void saveFile(path), s.autoSaveDelay),
  );
}

function gitLetter(): string {
  return "";
}

function renderTabs() {
  const shell = shellRef!;
  shell.tabsEl.innerHTML = "";
  for (const [path, t] of tabs) {
    const el = document.createElement("div");
    el.className = `tab${path === activePath ? " active" : ""}${t.dirty ? " dirty" : ""}`;
    const name = path.split("/").pop() ?? path;
    el.innerHTML = `<span class="t-label"></span><span class="t-dot"></span><button class="t-close" title="Close">${icons.x}</button>`;
    (el.querySelector(".t-label") as HTMLElement).textContent = name;
    el.title = path;
    el.onclick = () => void openFile(path);
    (el.querySelector(".t-close") as HTMLButtonElement).onclick = (e) => {
      e.stopPropagation();
      void closeTab(path);
    };
    shell.tabsEl.appendChild(el);
  }
  // Self-healing: whenever there is nothing open, the start screen must be
  // there — no matter which path removed the last tab (close, reset, external
  // delete) or when the app booted.
  if (!tabs.size && shellRef) {
    const host = shellRef.editorHost;
    if (!host.querySelector(".cm-editor")) renderWelcome(host);
  }
  void gitLetter;
}

function renderCrumbs() {
  const shell = shellRef!;
  shell.crumbsEl.innerHTML = "";
  if (!activePath) return;
  const parts = activePath.split("/");
  parts.forEach((p, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "›";
      shell.crumbsEl.appendChild(sep);
    }
    const c = document.createElement("span");
    c.className = "crumb";
    c.textContent = p;
    shell.crumbsEl.appendChild(c);
  });
}

function updateCursorStatus() {
  const shell = shellRef;
  if (!shell || !activePath) return;
  const t = tabs.get(activePath);
  if (!t) return;
  const pos = t.view.state.selection.main.head;
  const line = t.view.state.doc.lineAt(pos);
  shell.setStatus({
    id: "cursor", side: "right", order: 10,
    text: () => `Ln ${line.number}, Col ${pos - line.from + 1}`,
  });
  shell.setStatus({
    id: "indent", side: "right", order: 20,
    text: () => `Spaces: ${loadSettings().tabSize}`,
    tooltip: () => "Indentation (change in Settings)",
  });
  shell.setStatus({
    id: "lang", side: "right", order: 30,
    text: () => (isPython(activePath!) ? "Python" : "Text"),
  });
}

// ---------- workspace search ----------

function renderSearchView(host: HTMLElement) {
  host.innerHTML = "";
  const box = document.createElement("div");
  box.className = "search-box";
  box.innerHTML = `<input id="s-q" placeholder="Search" aria-label="Search"/><input id="s-rep" placeholder="Replace" aria-label="Replace"/>`;
  const opts = document.createElement("div");
  opts.className = "search-opts";
  const toggles: { id: string; title: string; label: string; on: boolean }[] = [
    { id: "re", title: "Use regular expression", label: ".*", on: false },
    { id: "case", title: "Match case", label: "Aa", on: false },
    { id: "word", title: "Match whole word", label: "\\b", on: false },
  ];
  for (const t of toggles) {
    const b = document.createElement("button");
    b.className = "icon-btn";
    b.title = t.title;
    b.style.fontSize = "11px";
    b.style.fontFamily = "var(--font-mono)";
    b.textContent = t.label;
    b.onclick = () => {
      t.on = !t.on;
      b.classList.toggle("active", t.on);
      void run();
    };
    (t as unknown as { btn: HTMLButtonElement }).btn = b;
    opts.appendChild(b);
  }
  const go = document.createElement("button");
  go.className = "btn primary";
  go.textContent = "Search";
  go.style.marginTop = "4px";
  go.onclick = () => void run();
  const repAll = document.createElement("button");
  repAll.className = "btn";
  repAll.textContent = "Replace all";
  repAll.style.marginTop = "4px";
  repAll.onclick = () => void replaceAll();
  box.append(opts, go, repAll);
  host.appendChild(box);
  const results = document.createElement("div");
  results.style.overflow = "auto";
  results.style.flex = "1";
  host.appendChild(results);

  let lastHits: { path: string; line: number; text: string }[] = [];

  function buildRe(q: string): RegExp | null {
    const useRe = toggles[0].on;
    const matchCase = toggles[1].on;
    const whole = toggles[2].on;
    try {
      let src = useRe ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (whole) src = `\\b${src}\\b`;
      return new RegExp(src, matchCase ? "g" : "gi");
    } catch {
      return null;
    }
  }

  async function run() {
    const q = (box.querySelector("#s-q") as HTMLInputElement).value;
    results.innerHTML = "";
    lastHits = [];
    if (!q) return;
    const re = buildRe(q);
    if (!re) {
      results.innerHTML = `<div class="empty-note">Invalid regular expression.</div>`;
      return;
    }
    const files = await wsListAll();
    let total = 0;
    for (const f of files) {
      if (!/\.(py|pyi|txt|md|json|toml|yaml|yml|ini|cfg|js|ts|css|html)$/.test(f)) continue;
      let text: string;
      try {
        text = await wsRead(f);
      } catch {
        continue;
      }
      const lines = text.split("\n");
      const hits: { line: number; text: string }[] = [];
      lines.forEach((ln, i) => {
        re.lastIndex = 0;
        if (re.test(ln)) hits.push({ line: i + 1, text: ln });
      });
      if (!hits.length) continue;
      const fh = document.createElement("div");
      fh.className = "hit-file";
      const fIcon = document.createElement("img");
      fIcon.className = "ficon";
      fIcon.src = fileIconSrc(f.split("/").pop() ?? f);
      fIcon.alt = "";
      const fName = document.createElement("span");
      fName.textContent = f;
      fh.append(fIcon, fName);
      fh.onclick = () => void openFile(f);
      results.appendChild(fh);
      for (const h of hits) {
        lastHits.push({ path: f, line: h.line, text: h.text });
        const row = document.createElement("div");
        row.className = "hit-line";
        const idx = h.text.toLowerCase().indexOf(q.toLowerCase());
        if (!toggles[0].on && idx >= 0) {
          const a = document.createElement("span");
          a.textContent = h.text.slice(0, idx);
          const b = document.createElement("b");
          b.textContent = h.text.slice(idx, idx + q.length);
          const c = document.createElement("span");
          c.textContent = h.text.slice(idx + q.length);
          row.append(a, b, c);
        } else row.textContent = `${h.line}: ${h.text}`;
        const line = h.line;
        row.onclick = () => void openFile(f, line, 0);
        row.title = `${f}:${line}`;
        results.appendChild(row);
        if (++total > 500) break;
      }
      if (total > 500) break;
    }
    const summary = document.createElement("div");
    summary.className = "empty-note";
    summary.textContent = total ? `${total} matches.` : "No matches.";
    results.prepend(summary);
  }

  async function replaceAll() {
    const q = (box.querySelector("#s-q") as HTMLInputElement).value;
    const rep = (box.querySelector("#s-rep") as HTMLInputElement).value;
    if (!q || !lastHits.length) return;
    if (!(await confirmDialog("Replace all", `Replace in ${lastHits.length} places?`, "Replace all"))) return;
    const re = buildRe(q);
    if (!re) return;
    const byFile = new Map<string, string[]>();
    for (const h of lastHits) {
      if (!byFile.has(h.path)) {
        try {
          byFile.set(h.path, (await wsRead(h.path)).split("\n"));
        } catch {
          continue;
        }
      }
    }
    for (const [f, lines] of byFile) {
      await wsWrite(f, lines.map((ln) => ln.replace(re, rep)).join("\n"));
      const t = tabs.get(f);
      if (t && !t.dirty) {
        // reload clean tab
        const text = await wsRead(f);
        t.view.dispatch({ changes: { from: 0, to: t.view.state.doc.length, insert: text } });
        t.dirty = false;
        renderTabs();
      }
    }
    notify.success("Replaced.");
    void run();
  }

  (box.querySelector("#s-q") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter") void run();
  });
}

// ---------- init ----------

export async function initEditor(shell: Shell): Promise<void> {
  shellRef = shell;
  shell.registerActivity({
    id: "search", title: "Search", icon: "search", order: 2,
    render: (el) => renderSearchView(el),
  });

  registerCommands([
    {
      id: "file.open", title: "Open file", category: "File",
      run: (p) => {
        if (typeof p === "string") return openFile(p);
        // no arg → quick open
        return runCommand("files.quickOpen");
      },
    },
    { id: "file.save", title: "Save file", category: "File", keybinding: "Ctrl+S", run: () => activePath ? saveFile(activePath) : Promise.resolve() },
    { id: "file.saveAll", title: "Save all files", category: "File", run: () => saveAll() },
    {
      id: "tab.close", title: "Close tab", category: "View", keybinding: "Ctrl+W",
      run: () => (activePath ? closeTab(activePath) : Promise.resolve()),
    },
    {
      id: "tab.next", title: "Next tab", category: "View", keybinding: "Ctrl+Tab",
      run: () => {
        const keys = [...tabs.keys()];
        if (keys.length < 2 || !activePath) return Promise.resolve();
        const next = keys[(keys.indexOf(activePath) + 1) % keys.length];
        return openFile(next);
      },
    },
    {
      id: "editor.gotoDefinition", title: "Go to definition", category: "Editor", keybinding: "F12",
      run: () => {
        const t = activePath ? tabs.get(activePath) : null;
        if (t) jumpToDefinition(t.view);
      },
    },
    {
      id: "editor.references", title: "Find references", category: "Editor", keybinding: "Shift+F12",
      run: () => {
        const t = activePath ? tabs.get(activePath) : null;
        if (t) findReferences(t.view);
      },
    },
    {
      id: "editor.rename", title: "Rename symbol", category: "Editor", icon: "edit", keybinding: "F2",
      run: () => {
        const t = activePath ? tabs.get(activePath) : null;
        if (t) renameSymbol(t.view);
      },
    },
    {
      id: "editor.gotoLine", title: "Go to line…", category: "Editor", keybinding: "Ctrl+G",
      run: async () => {
        if (!activePath) return;
        const v = await inputDialog({ title: "Go to line", placeholder: "line[:column]" });
        if (!v) return;
        const [l, c] = v.split(":").map(Number);
        if (l) await openFile(activePath, l, (c || 1) - 1);
      },
    },
    {
      id: "editor.symbols", title: "Go to symbol…", category: "Editor", keybinding: "Ctrl+Shift+O",
      run: async () => {
        if (!activePath) return;
        const syms = await editorHooks.documentSymbols(activePath);
        if (!syms.length) {
          notify.info("No symbols found.");
          return;
        }
        openPalette(syms.map((s) => ({ label: `${s.name}  ·  ${s.kind}`, run: () => openFile(activePath!, s.line, 0) })), "Type a symbol…");
      },
    },
    {
      id: "files.search", title: "Search in files", category: "File", keybinding: "Ctrl+Shift+F",
      run: () => {
        shell.showActivity("search");
        return Promise.resolve();
      },
    },
  ]);

  // Re-apply UI extensions when settings/theme change.
  onSettingsChange(() => {
    for (const t of tabs.values()) t.view.dispatch({ effects: t.ui.reconfigure(uiExtensions()) });
  });
  new MutationObserver(() => {
    for (const t of tabs.values()) t.view.dispatch({ effects: t.ui.reconfigure(uiExtensions()) });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // External file changes (git checkout, zip import): reload clean tabs.
  onWorkspaceChange(async (e) => {
    if (e.kind === "reset") {
      for (const [p, t] of tabs) {
        try {
          const text = await wsRead(p);
          t.view.dispatch({ changes: { from: 0, to: t.view.state.doc.length, insert: text } });
          t.dirty = false;
        } catch {
          await closeTab(p, true);
        }
      }
      renderTabs();
      return;
    }
    if (e.kind === "write" && e.path) {
      const t = tabs.get(e.path);
      if (t && !t.dirty) {
        try {
          const text = await wsRead(e.path);
          if (text !== t.view.state.doc.toString()) {
            t.view.dispatch({ changes: { from: 0, to: t.view.state.doc.length, insert: text } });
          }
        } catch { /* deleted externally */ }
      }
    }
    if (e.kind === "delete" && e.path && tabs.has(e.path)) {
      notify.warn(`"${e.path}" was deleted.`, {
        actions: [{ label: "Close tab", run: () => closeTab(e.path!, true) }],
      });
    }
  });

  updateCursorStatus();
}

// Needed for `runCommand` indirection inside this module.
import { runCommand } from "../app/commands";
