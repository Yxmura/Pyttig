// Pyttig bootstrap. Wires shell + core commands; feature modules self-register.

// Bundled fonts (no network, no install).
import "@fontsource-variable/inter";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/geist-mono/600.css";
import "./styles/base.css";
import { createShell, type Shell } from "./app/shell";
import { registerCommands, openPalette, runCommand } from "./app/commands";
import { initKeymap } from "./app/keymap";
import { applyTheme, toggleTheme, effectiveTheme } from "./app/settings";
import { icons } from "./app/icons";
import { renderWelcome } from "./app/welcome";
import { notify } from "./app/toast";

export let shell: Shell;

function setThemeIcon() {
  const btn = document.getElementById("tb-theme");
  if (btn) btn.innerHTML = effectiveTheme() === "dark" ? icons.sun : icons.moon;
}

/**
 * Boot steps must never block the start screen: each one is timed, isolated,
 * and failures are reported instead of breaking the app. A hung network call
 * or worker can cost a little time, never a blank window.
 */
async function step(name: string, fn: () => Promise<unknown> | unknown): Promise<boolean> {
  const t0 = performance.now();
  try {
    await fn();
    console.debug(`[boot] ${name}: ${Math.round(performance.now() - t0)}ms`);
    return true;
  } catch (err) {
    console.error(`[boot] ${name} failed after ${Math.round(performance.now() - t0)}ms:`, err);
    return false;
  }
}

async function boot() {
  applyTheme();
  const root = document.getElementById("app")!;
  shell = createShell(root);
  shell.setWorkspaceName("workspace");

  registerCommands([
    { id: "palette.open", title: "Show all commands", category: "View", icon: "command", keybinding: "Ctrl+Shift+P", run: () => openPalette() },
    { id: "view.toggleSidebar", title: "Toggle sidebar", category: "View", keybinding: "Ctrl+B", run: () => shell.toggleSidebar() },
    { id: "view.togglePanel", title: "Toggle panel", category: "View", keybinding: "Ctrl+`", run: () => shell.togglePanel() },
    {
      id: "view.toggleTheme", title: "Toggle dark/light theme", category: "View", keybinding: "Ctrl+K Ctrl+T",
      run: () => { toggleTheme(); setThemeIcon(); },
    },
  ]);

  setThemeIcon();
  (document.getElementById("tb-theme") as HTMLButtonElement).onclick = () => runCommand("view.toggleTheme");
  (document.getElementById("tb-palette") as HTMLButtonElement).onclick = () => runCommand("palette.open");
  shell.runBtn.onclick = () => runCommand("python.run");
  shell.stopBtn.onclick = () => runCommand("python.stop");

  // Status bar basics; feature modules add their own items.
  shell.setStatus({
    id: "pyttig", side: "right", order: 100, icon: "zap",
    text: () => "Pyttig",
    tooltip: () => "Pyttig — spicy Python IDE",
  });
  shell.setStatus({
    id: "launcher", side: "right", order: 90, icon: "cpu",
    text: () => (window as unknown as { __pyttigLauncher?: boolean }).__pyttigLauncher ? "local" : "browser",
    tooltip: () => "Runtime host: local launcher or plain browser",
  });

  initKeymap();

  // The start screen goes up immediately — before any subsystem loads.
  renderWelcome(shell.editorHost);

  // Feature modules (each registers its own views/commands/panels).
  const failed: string[] = [];
  const steps: [string, () => Promise<unknown>][] = [
    ["workspace", () => import("./fs/workspace").then((m) => m.initWorkspace(shell))],
    ["editor", () => import("./editor/manager").then((m) => m.initEditor(shell))],
    ["runtime", () => import("./runtime/client").then((m) => m.initRuntime(shell))],
    ["packages", () => import("./runtime/packages").then((m) => m.initPackages(shell))],
    ["lsp", () => import("./lsp/bridge").then((m) => m.initLsp(shell))],
    ["git", () => import("./git/view").then((m) => m.initGit(shell))],
    ["settings", () => import("./app/settingsView").then((m) => m.initSettingsView(shell))],
    [
      "memory",
      async () => {
        const [{ onRuntimeChange, pythonMemory }, { ruffMemory }, { initMemory }] = await Promise.all([
          import("./runtime/client"),
          import("./lsp/ruffClient"),
          import("./app/memory"),
        ]);
        initMemory(shell, {
          collect: async () => {
            const [py, ruff] = await Promise.all([pythonMemory(), ruffMemory()]);
            const app = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize;
            return { app, python: py?.wasm, ruff: ruff?.wasm };
          },
          subscribeRuntime: onRuntimeChange,
        });
      },
    ],
  ];
  for (const [name, fn] of steps) {
    if (!(await step(name, fn))) failed.push(name);
  }

  // Welcome is idempotent; this covers the (unlikely) case a step removed it.
  if (!shell.tabsEl.children.length) renderWelcome(shell.editorHost);

  if (failed.length) {
    notify.warn(`Some features failed to start (${failed.join(", ")}). A hard refresh (Ctrl+Shift+R) usually fixes it.`, {
      timeout: 15000,
    });
  }

  // Tell the inline boot-guard in index.html that we made it.
  (window as unknown as { __pyttigBooted?: boolean }).__pyttigBooted = true;
}

document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", boot) : void boot();
