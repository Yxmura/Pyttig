// Command registry + command palette + quick open (Ctrl+P file picker).

import { icons, type IconName } from "./icons";

export interface Command {
  id: string;
  title: string;
  category?: string;
  icon?: IconName;
  keybinding?: string;
  when?: () => boolean;
  run: (arg?: unknown) => void | Promise<void>;
}

const commands = new Map<string, Command>();

export function registerCommand(cmd: Command): void {
  commands.set(cmd.id, cmd);
}

export function registerCommands(cmds: Command[]): void {
  for (const c of cmds) registerCommand(c);
}

export function getCommand(id: string): Command | undefined {
  return commands.get(id);
}

export async function runCommand(id: string, arg?: unknown): Promise<void> {
  const cmd = commands.get(id);
  if (!cmd) return;
  try {
    await cmd.run(arg);
  } catch (err) {
    console.error(`Command ${id} failed:`, err);
    const { notify } = await import("./toast");
    notify.error(err instanceof Error ? err.message : String(err));
  }
}

export function listCommands(): Command[] {
  return [...commands.values()].filter((c) => !c.when || c.when()).sort((a, b) => a.title.localeCompare(b.title));
}

export function formatKeybinding(binding: string): string {
  // Normalize "Ctrl+Shift+P" style bindings for display on macOS.
  const isMac = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
  if (!isMac) return binding;
  return binding.replace(/Ctrl\+/g, "⌃").replace(/Shift\+/g, "⇧").replace(/Alt\+/g, "⌥");
}

interface PaletteEntry {
  label: string;
  detail?: string;
  icon?: IconName;
  hint?: string;
  run: () => void;
}

export function fuzzyMatch(query: string, text: string): { hit: boolean; score: number } {
  if (!query) return { hit: true, score: 0 };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -1;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      score += last === i - 1 ? 2 : 1;
      if (i === 0 || t[i - 1] === " " || t[i - 1] === "/" || t[i - 1] === ".") score += 2;
      last = i;
      qi++;
    }
  }
  return qi === q.length ? { hit: true, score } : { hit: false, score: 0 };
}

export function openPalette(entries?: PaletteEntry[], placeholder = "Type a command…"): void {
  closePalette();
  const o = document.createElement("div");
  o.className = "overlay";
  o.id = "palette-overlay";
  const box = document.createElement("div");
  box.className = "palette";
  const input = document.createElement("input");
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  const list = document.createElement("div");
  list.className = "palette-list";
  box.append(input, list);
  o.appendChild(box);
  document.body.appendChild(o);

  let items: PaletteEntry[] = entries ?? listCommands().map((c) => ({
    label: `${c.category ? c.category + ": " : ""}${c.title}`,
    icon: c.icon,
    hint: c.keybinding ? formatKeybinding(c.keybinding) : undefined,
    run: () => runCommand(c.id),
  }));
  let selected = 0;

  const render = () => {
    const q = input.value.trim();
    const scored = items
      .map((e) => ({ e, ...fuzzyMatch(q, e.label) }))
      .filter((s) => s.hit)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60);
    list.innerHTML = "";
    selected = Math.min(selected, Math.max(0, scored.length - 1));
    scored.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = `palette-item${i === selected ? " selected" : ""}`;
      row.innerHTML = `${s.e.icon ? icons[s.e.icon] : ""}<span></span>${s.e.hint ? `<span class="hint"></span>` : ""}`;
      (row.querySelector("span") as HTMLElement).textContent = s.e.label;
      if (s.e.hint) (row.querySelector(".hint") as HTMLElement).textContent = s.e.hint;
      row.onclick = () => {
        closePalette();
        s.e.run();
      };
      row.onmousemove = () => {
        if (selected !== i) {
          selected = i;
          list.querySelectorAll(".palette-item").forEach((r, j) => r.classList.toggle("selected", j === selected));
        }
      };
      list.appendChild(row);
    });
    if (!scored.length) {
      const empty = document.createElement("div");
      empty.className = "empty-note";
      empty.textContent = "No matches.";
      list.appendChild(empty);
    }
  };

  input.oninput = () => {
    selected = 0;
    render();
  };
  input.onkeydown = (e) => {
    const rows = [...list.querySelectorAll(".palette-item")];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selected = Math.min(selected + 1, rows.length - 1);
      rows.forEach((r, j) => r.classList.toggle("selected", j === selected));
      rows[selected]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(selected - 1, 0);
      rows.forEach((r, j) => r.classList.toggle("selected", j === selected));
      rows[selected]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      (rows[selected] as HTMLElement | undefined)?.click();
    } else if (e.key === "Escape") {
      closePalette();
    }
  };
  o.addEventListener("mousedown", (e) => {
    if (e.target === o) closePalette();
  });
  render();
  input.focus();
}

export function closePalette(): void {
  document.getElementById("palette-overlay")?.remove();
}
