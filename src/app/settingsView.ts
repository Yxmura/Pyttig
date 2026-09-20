// Settings activity view: theme, editor, runtime, git proxy options.

import type { Shell } from "./shell";
import { loadSettings, saveSettings, resetSettings, type PyttigSettings } from "./settings";
import { registerCommands } from "./commands";
import { notify } from "./toast";
import { confirmDialog } from "../app/dialog";

function row(parent: HTMLElement, label: string, desc: string, control: HTMLElement) {
  const r = document.createElement("div");
  r.className = "set-row";
  const l = document.createElement("div");
  l.className = "s-label";
  const b = document.createElement("b");
  b.textContent = label;
  const s = document.createElement("span");
  s.textContent = desc;
  l.append(b, s);
  r.append(l, control);
  parent.appendChild(r);
  return r;
}

function select(value: string, options: string[], onChange: (v: string) => void): HTMLSelectElement {
  const el = document.createElement("select");
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o;
    opt.textContent = o;
    el.appendChild(opt);
  }
  el.value = value;
  el.onchange = () => onChange(el.value);
  return el;
}

function number(value: number, min: number, max: number, onChange: (v: number) => void): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "number";
  el.min = String(min);
  el.max = String(max);
  el.value = String(value);
  el.onchange = () => {
    const v = Math.max(min, Math.min(max, Number(el.value) || value));
    el.value = String(v);
    onChange(v);
  };
  return el;
}

function toggle(value: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const l = document.createElement("label");
  l.className = "switch";
  l.innerHTML = `<input type="checkbox"${value ? " checked" : ""}/><span class="track"></span>`;
  (l.querySelector("input") as HTMLInputElement).onchange = (e) =>
    onChange((e.target as HTMLInputElement).checked);
  return l;
}

export function renderSettingsView(host: HTMLElement) {
  host.innerHTML = "";
  const s = loadSettings();
  const set = (patch: Partial<PyttigSettings>) => {
    saveSettings(patch);
    renderSettingsView(host);
  };

  const section = (title: string) => {
    const h = document.createElement("div");
    h.className = "side-section";
    h.innerHTML = `<h4></h4>`;
    (h.querySelector("h4") as HTMLElement).textContent = title;
    host.appendChild(h);
    return h;
  };

  const app = section("Appearance");
  row(app, "Theme", "Dark, light, or follow the OS.", select(s.theme, ["system", "dark", "light"], (v) => set({ theme: v as PyttigSettings["theme"] })));
  row(app, "Font size", "Editor font size in px.", number(s.fontSize, 10, 24, (v) => set({ fontSize: v })));
  row(app, "Word wrap", "Wrap long lines in the editor.", toggle(s.wordWrap, (v) => set({ wordWrap: v })));

  const ed = section("Editor");
  row(ed, "Tab size", "Spaces per indent level.", number(s.tabSize, 2, 8, (v) => set({ tabSize: v })));
  row(ed, "Auto save", "Save a second after you stop typing.", toggle(s.autoSave, (v) => set({ autoSave: v })));
  row(ed, "Format on save", "Run Ruff format when saving Python files.", toggle(s.formatOnSave, (v) => set({ formatOnSave: v })));
  row(ed, "Line length", "Target line length for Ruff.", number(s.lineLength, 40, 140, (v) => set({ lineLength: v })));
  row(ed, "Quote style", "Preferred quotes for Ruff format.", select(s.quoteStyle, ["double", "single"], (v) => set({ quoteStyle: v as "double" | "single" })));

  const lsp = section("Language intelligence");
  row(lsp, "Real-time lint", "Underline problems as you type (Ruff).", toggle(s.lintOnType, (v) => set({ lintOnType: v })));
  row(lsp, "Ruff", "Fast Python lint + format engine.", toggle(s.ruffEnabled, (v) => set({ ruffEnabled: v })));
  row(lsp, "Jedi", "Completions, hover, go-to-definition (loads Python runtime).", toggle(s.jediEnabled, (v) => set({ jediEnabled: v })));
  row(
    lsp, "Type checker", "Optional deep type checking (heavy, experimental).",
    select(s.typeChecker, ["off", "pyright-worker"], (v) => set({ typeChecker: v as PyttigSettings["typeChecker"] })),
  );

  const run = section("Python runtime");
  row(run, "Preload data stack", "Install numpy/pandas/matplotlib/requests in the background on first start.", toggle(s.preloadStack, (v) => set({ preloadStack: v })));
  row(run, "Keep namespace", "Keep variables between runs (notebook-style).", toggle(s.keepNamespace, (v) => set({ keepNamespace: v })));
  row(run, "Unload when idle", "Free runtime memory after N idle minutes (0 = never).", number(s.idleUnloadMinutes, 0, 120, (v) => set({ idleUnloadMinutes: v })));
  const args = document.createElement("input");
  args.type = "text";
  args.value = s.runArgs;
  args.placeholder = "--foo bar";
  args.style.width = "170px";
  args.onchange = () => saveSettings({ runArgs: args.value });
  row(run, "Run arguments", "Passed as sys.argv when running.", args);
  const pyUrl = document.createElement("input");
  pyUrl.type = "text";
  try {
    pyUrl.value = localStorage.getItem("pyttig.pyodideUrl") ?? "";
  } catch { /* ignore */ }
  pyUrl.placeholder = "CDN default";
  pyUrl.style.width = "170px";
  pyUrl.onchange = () => {
    try {
      if (pyUrl.value.trim()) localStorage.setItem("pyttig.pyodideUrl", pyUrl.value.trim());
      else localStorage.removeItem("pyttig.pyodideUrl");
    } catch { /* ignore */ }
  };
  row(run, "Pyodide URL", "Advanced: custom base URL for Pyodide (launcher --pyodide-dir). Empty = CDN.", pyUrl);

  const git = section("Git");
  const proxy = document.createElement("input");
  proxy.type = "text";
  proxy.value = s.corsProxy;
  proxy.placeholder = "auto";
  proxy.style.width = "170px";
  proxy.onchange = () => saveSettings({ corsProxy: proxy.value.trim() || "auto" });
  row(git, "CORS proxy", "auto = launcher proxy, else public fallback. Needed for GitHub.", proxy);
  row(git, "Remember token", "Store the git token in this browser (off = session only).", toggle(s.rememberToken, (v) => set({ rememberToken: v })));

  const danger = section("Workspace");
  const reset = document.createElement("button");
  reset.className = "btn danger";
  reset.textContent = "Reset all settings";
  reset.onclick = async () => {
    if (await confirmDialog("Reset settings", "Restore all Pyttig settings to defaults?", "Reset", true)) {
      resetSettings();
      renderSettingsView(host);
      notify.success("Settings reset.");
    }
  };
  const wrap = document.createElement("div");
  wrap.style.padding = "10px 14px";
  wrap.appendChild(reset);
  danger.appendChild(wrap);
}

export function initSettingsView(shell: Shell): void {
  shell.registerActivity({
    id: "__settings__", title: "Settings", icon: "gear", order: 1000,
    render: (el) => renderSettingsView(el),
  });
  registerCommands([
    {
      id: "settings.open", title: "Open settings", category: "View", icon: "gear",
      run: () => {
        shell.showActivity("__settings__");
        return Promise.resolve();
      },
    },
  ]);
}
