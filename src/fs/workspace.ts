// OPFS-backed workspace: the single source of truth for project files.
// All paths are workspace-relative POSIX paths, e.g. "main.py", "pkg/util.py".

import type { Shell } from "../app/shell";
import { icons } from "../app/icons";
import { registerCommands, openPalette } from "../app/commands";
import { fileIconSrc } from "./fileIcons";
import { notify } from "../app/toast";
import { inputDialog, confirmDialog } from "../app/dialog";
import { showContextMenu, type MenuItem } from "../app/contextMenu";
import { runCommand } from "../app/commands";
import { zip, unzip } from "fflate";

export type ChangeKind = "write" | "delete" | "rename" | "reset";
export interface WorkspaceEvent {
  kind: ChangeKind;
  path?: string;
}

type Listener = (e: WorkspaceEvent) => void;
const listeners = new Set<Listener>();
export function onWorkspaceChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(e: WorkspaceEvent) {
  for (const l of listeners) {
    try {
      l(e);
    } catch (err) {
      console.error(err);
    }
  }
}

/** Broadcast that the whole tree may have changed (pull, checkout, import). */
export function emitWorkspaceReset(): void {
  emit({ kind: "reset" });
}

let rootDir: FileSystemDirectoryHandle | null = null;
let gitStatusOf: ((path: string) => string | null) | null = null;
export function setGitStatusProvider(fn: ((path: string) => string | null) | null) {
  gitStatusOf = fn;
}

async function root(): Promise<FileSystemDirectoryHandle> {
  if (!rootDir) {
    const opfs = await navigator.storage.getDirectory();
    rootDir = await opfs.getDirectoryHandle("pyttig", { create: true });
  }
  return rootDir;
}

/** The OPFS workspace root handle (transferable to workers, e.g. git). */
export async function getRootHandle(): Promise<FileSystemDirectoryHandle> {
  return root();
}

function split(path: string): string[] {
  return path.split("/").filter((p) => p && p !== "." && p !== "..");
}

/** Resolve parent dir handle + leaf name for a path. Creates parents when asked. */
async function resolveParent(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = split(path);
  const name = parts.pop() ?? "";
  let dir = await root();
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return { dir, name };
}

async function getDir(path: string, create = false): Promise<FileSystemDirectoryHandle> {
  let dir = await root();
  for (const p of split(path)) dir = await dir.getDirectoryHandle(p, { create });
  return dir;
}

export async function wsExists(path: string): Promise<boolean> {
  try {
    const { dir, name } = await resolveParent(path, false);
    if (!name) return true;
    try {
      await dir.getFileHandle(name);
      return true;
    } catch {
      await dir.getDirectoryHandle(name);
      return true;
    }
  } catch {
    return false;
  }
}

export async function wsIsDir(path: string): Promise<boolean> {
  if (!split(path).length) return true;
  try {
    await getDir(path, false);
    return true;
  } catch {
    return false;
  }
}

export async function wsRead(path: string): Promise<string> {
  const { dir, name } = await resolveParent(path, false);
  const fh = await dir.getFileHandle(name);
  const file = await fh.getFile();
  return file.text();
}

export async function wsReadBytes(path: string): Promise<Uint8Array> {
  const { dir, name } = await resolveParent(path, false);
  const fh = await dir.getFileHandle(name);
  const file = await fh.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

export async function wsStat(path: string): Promise<{ size: number; mtime: number }> {
  const { dir, name } = await resolveParent(path, false);
  const fh = await dir.getFileHandle(name);
  const file = await fh.getFile();
  return { size: file.size, mtime: file.lastModified };
}

export async function wsWrite(path: string, content: string | Uint8Array, quiet = false): Promise<void> {
  const { dir, name } = await resolveParent(path, true);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(typeof content === "string" ? content : (content as unknown as ArrayBuffer));
  await w.close();
  if (!quiet) emit({ kind: "write", path });
}

export async function wsMkdir(path: string): Promise<void> {
  await getDir(path, true);
  emit({ kind: "write", path });
}

export async function wsDelete(path: string): Promise<void> {
  const { dir, name } = await resolveParent(path, false);
  await dir.removeEntry(name, { recursive: true });
  emit({ kind: "delete", path });
}

export async function wsRename(oldPath: string, newPath: string): Promise<void> {
  if (oldPath === newPath) return;
  const isDir = await wsIsDir(oldPath);
  if (isDir) {
    await copyDir(oldPath, newPath);
    await wsDelete(oldPath);
  } else {
    const data = await wsReadBytes(oldPath);
    await wsWrite(newPath, data, true);
    await wsDelete(oldPath);
  }
  emit({ kind: "rename", path: newPath });
}

async function copyDir(src: string, dst: string): Promise<void> {
  for (const e of await wsListDir(src)) {
    const s = src ? `${src}/${e.name}` : e.name;
    const d = dst ? `${dst}/${e.name}` : e.name;
    if (e.kind === "dir") await copyDir(s, d);
    else await wsWrite(d, await wsReadBytes(s), true);
  }
}

export interface DirEntry {
  name: string;
  kind: "file" | "dir";
}

/** entries() yields [name, handle]; typed loosely for older TS DOM libs. */
async function listHandles(dir: FileSystemDirectoryHandle): Promise<[string, FileSystemHandle][]> {
  const fn = (dir as unknown as { entries?: unknown }).entries;
  if (typeof fn !== "function") throw new Error("File System entries() API is unavailable in this browser");
  const out: [string, FileSystemHandle][] = [];
  for await (const e of (fn as () => AsyncIterableIterator<[string, FileSystemHandle]>).call(dir)) out.push(e);
  return out;
}

export async function wsListDir(path: string): Promise<DirEntry[]> {
  const dir = path ? await getDir(path, false) : await root();
  const out: DirEntry[] = [];
  for (const [name, handle] of await listHandles(dir)) {
    if (name === ".git") continue; // git internals stay out of the explorer
    out.push({ name, kind: handle.kind === "directory" ? "dir" : "file" });
  }
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  return out;
}

export async function wsListAll(prefix = ""): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dirPath: string) => {
    for (const e of await wsListDir(dirPath)) {
      const p = dirPath ? `${dirPath}/${e.name}` : e.name;
      if (e.kind === "dir") {
        if (p === ".git" || p.startsWith(".git/")) continue;
        await walk(p);
      } else out.push(p);
    }
  };
  await walk(prefix);
  return out.sort();
}

// ---------- zip export / import ----------

export async function exportZip(): Promise<Uint8Array> {
  const files = await wsListAll();
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f] = await wsReadBytes(f);
  return await new Promise((resolve, reject) => {
    zip(entries, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

export async function importZip(data: Uint8Array): Promise<number> {
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(data, (err, d) => (err ? reject(err) : resolve(d as Record<string, Uint8Array>)));
  });
  let n = 0;
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith("/") || name.includes(".git/") || name === ".git") continue;
    await wsWrite(name, bytes, true);
    n++;
  }
  emit({ kind: "reset" });
  return n;
}

// ---------- first-run seed ----------

const DEMO_MAIN = `"""Pyttig demo: real CPython in your browser. Press F5 to run."""

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import requests

print("Hello from Pyttig!")

# numpy + pandas
rng = np.random.default_rng(7)
df = pd.DataFrame({"x": np.arange(100), "y": rng.normal(0, 1, 100).cumsum()})
print(df.describe().round(2))

# requests (patched to the browser fetch stack)
r = requests.get("https://api.github.com/zen")
print("github zen:", r.text)

# matplotlib — the figure appears in the panel
fig, ax = plt.subplots()
ax.plot(df["x"], df["y"], label="random walk")
ax.set_title("Spicy little random walk")
ax.legend()
plt.show()
`;

// A brand-new workspace starts empty — no sample files, ever.

/** Nuke every file and folder in the workspace (fresh start). */
export async function resetWorkspace(): Promise<void> {
  const rootDirHandle = await root();
  const names: string[] = [];
  for (const [name] of await listHandles(rootDirHandle)) names.push(name);
  for (const name of names) {
    try {
      await rootDirHandle.removeEntry(name, { recursive: true });
    } catch { /* keep going */ }
  }
  emit({ kind: "reset" });
}

// ---------- explorer view ----------

function iconImg(src: string): string {
  return `<img class="ficon" src="${src}" alt="" loading="lazy" draggable="false" />`;
}

function renderExplorer(host: HTMLElement, shell: Shell, openFile: (path: string) => void) {
  host.innerHTML = "";
  const toolbar = document.createElement("div");
  toolbar.style.cssText = "display:flex;gap:2px;padding:6px 8px;border-bottom:1px solid var(--border)";
  const mkBtn = (icon: string, title: string, fn: () => void) => {
    const b = document.createElement("button");
    b.className = "icon-btn";
    b.title = title;
    b.innerHTML = icon;
    b.onclick = fn;
    toolbar.appendChild(b);
  };
  mkBtn(icons.filePlus, "New file", () => runCommand("file.new"));
  mkBtn(icons.folderPlus, "New folder", () => runCommand("folder.new"));
  mkBtn(icons.refresh, "Refresh", () => render());
  mkBtn(icons.download, "Download workspace (.zip)", () => runCommand("workspace.exportZip"));
  mkBtn(icons.upload, "Upload files", () => runCommand("workspace.upload"));
  mkBtn(icons.trash, "Reset workspace (delete everything)", () => runCommand("workspace.reset"));
  host.appendChild(toolbar);

  // Right-click anywhere in the explorer (including empty space below the
  // tree) opens the explorer menu; rows get their own richer menu.
  host.addEventListener("contextmenu", (ev) => {
    if ((ev.target as HTMLElement).closest(".tree-row")) return; // rows handle their own
    ev.preventDefault();
    showContextMenu(backgroundMenu(), { x: ev.clientX, y: ev.clientY });
  });
  const tree = document.createElement("div");
  tree.className = "tree";
  host.appendChild(tree);
  treeRenderer = render;

  const selectRow = (p: string) => {
    selectedPath = p;
    for (const el of tree.querySelectorAll(".tree-row")) {
      el.classList.toggle("selected", el.getAttribute("data-path") === p);
    }
  };

  async function render() {
    // Async walks can overlap (mount + workspace events + reveal). Build into
    // a detached element and only commit if this is still the newest render,
    // otherwise rows end up duplicated.
    const gen = ++renderGen;
    const next = document.createElement("div");
    const build = async (dirPath: string, depth: number, container: HTMLElement) => {
      let entries: DirEntry[];
      try {
        entries = await wsListDir(dirPath);
      } catch {
        return;
      }
      for (const e of entries) {
        const p = dirPath ? `${dirPath}/${e.name}` : e.name;
        const row = document.createElement("div");
        row.className = "tree-row";
        row.style.paddingLeft = `${depth * 12 + 6}px`;
        const isDir = e.kind === "dir";
        const open = expanded.has(p);
        row.innerHTML = `<span class="twisty">${isDir ? (open ? icons.chevronDown : icons.chevronRight) : ""}</span>
          ${isDir ? iconImg(fileIconSrc(e.name, "dir", open)) : iconImg(fileIconSrc(e.name))}
          <span class="fname"></span>`;
        (row.querySelector(".fname") as HTMLElement).textContent = e.name;
        const g = !isDir && gitStatusOf ? gitStatusOf(p) : null;
        if (g) {
          const s = document.createElement("span");
          s.className = `fgit t-git ${g}`;
          s.textContent = g;
          row.appendChild(s);
        }
        row.title = p;
        row.dataset.path = p;
        if (selectedPath === p) row.classList.add("selected");
        row.onclick = () => {
          selectRow(p);
          if (isDir) {
            if (open) expanded.delete(p);
            else expanded.add(p);
            render();
          } else openFile(p);
        };
        row.oncontextmenu = (ev) => {
          ev.preventDefault();
          selectRow(p);
          showContextMenu(rowMenu(p, isDir), { x: ev.clientX, y: ev.clientY });
        };
        container.appendChild(row);
        if (isDir && open) {
          const kids = document.createElement("div");
          kids.className = "tree-children";
          container.appendChild(kids);
          await build(p, depth + 1, kids);
        }
      }
    };
    await build("", 0, next);
    if (gen !== renderGen) return; // superseded by a newer render
    tree.innerHTML = "";
    tree.append(...next.children);
    for (const el of tree.querySelectorAll<HTMLElement>(".tree-row")) {
      el.classList.toggle("selected", el.getAttribute("data-path") === selectedPath);
    }
  }

  function rowMenu(path: string, isDir: boolean) {
    const parentDir = path.split("/").slice(0, -1).join("/");
    const items: MenuItem[] = [];
    if (!isDir) {
      items.push({ label: "Open", icon: "file", run: () => openFile(path) });
    }
    items.push(
      { label: "New File…", icon: "filePlus", run: () => runCommand("file.new", isDir ? path : parentDir) },
      { label: "New Folder…", icon: "folderPlus", run: () => runCommand("folder.new", isDir ? path : parentDir) },
      { separator: true },
      {
        label: "Rename…",
        icon: "edit",
        run: async () => {
          const next = await inputDialog({ title: "Rename", value: path });
          if (next && next !== path) await wsRename(path, next);
        },
      },
      {
        label: "Delete",
        icon: "trash",
        danger: true,
        run: async () => {
          if (await confirmDialog("Delete", `Delete "${path}"?`, "Delete", true)) await wsDelete(path);
        },
      },
      { separator: true },
    );
    if (!isDir) {
      items.push({
        label: "Download",
        icon: "download",
        run: async () => {
          const bytes = Uint8Array.from(await wsReadBytes(path));
          const blob = new Blob([bytes.buffer]);
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = path.split("/").pop()!;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        },
      });
    }
    items.push({
      label: "Copy Path",
      icon: "external",
      run: () => {
        void navigator.clipboard.writeText(path).then(
          () => notify.success("Path copied."),
          () => notify.info(path),
        );
      },
    });
    return items;
  }

  function backgroundMenu() {
    return [
      { label: "New File…", icon: "filePlus" as const, run: () => runCommand("file.new") },
      { label: "New Folder…", icon: "folderPlus" as const, run: () => runCommand("folder.new") },
      { separator: true },
      { label: "Upload Files…", icon: "upload" as const, run: () => runCommand("workspace.upload") },
      { label: "Download Workspace (.zip)", icon: "download" as const, run: () => runCommand("workspace.exportZip") },
      { separator: true },
      { label: "Refresh", icon: "refresh" as const, run: () => void render() },
      { separator: true },
      { label: "Reset Workspace…", icon: "trash" as const, danger: true, run: () => runCommand("workspace.reset") },
    ];
  }

  const off = onWorkspaceChange(() => render());
  void render();
  return () => {
    off();
    if (treeRenderer === render) treeRenderer = null;
  };
}

// Explorer state lives at module scope so it survives view switches, and so
// other features (e.g. "reveal after clone") can expand and select entries.
const expanded = new Set<string>([""]);
let selectedPath: string | null = null;
let treeRenderer: (() => Promise<void>) | null = null;
let renderGen = 0;

/** Expand the path's parents, select it and re-render the explorer. */
export async function revealInExplorer(path: string): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  parts.pop(); // select the entry itself, expand its parents
  let acc = "";
  expanded.add("");
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    expanded.add(acc);
  }
  selectedPath = path;
  await treeRenderer?.();
}

// ---------- module init ----------

export async function initWorkspace(shell: Shell): Promise<void> {
  const openFile = (path: string) => runCommand("file.open", path);
  shell.registerActivity({
    id: "explorer", title: "Explorer", icon: "files", order: 1,
    render: (el) => renderExplorer(el, shell, openFile),
  });

  shell.setStatus({
    id: "files", side: "left", order: 10, icon: "files",
    text: () => "Explorer",
    tooltip: () => "Files live in your browser (OPFS)",
    onClick: () => shell.showActivity("explorer"),
  });

  registerCommands([
    {
      id: "file.new", title: "New file", category: "File", icon: "filePlus",
      run: async (dirArg) => {
        const dir = typeof dirArg === "string" ? dirArg : "";
        const name = await inputDialog({ title: "New file", message: dir ? `In "${dir || "/"}".` : undefined, value: dir ? `${dir}/` : "", placeholder: "name.py" });
        if (!name) return;
        if (await wsExists(name)) {
          notify.warn(`"${name}" already exists.`);
          return;
        }
        await wsWrite(name, "");
        await runCommand("file.open", name);
      },
    },
    {
      id: "folder.new", title: "New folder", category: "File", icon: "folderPlus",
      run: async (dirArg) => {
        const dir = typeof dirArg === "string" ? dirArg.replace(/\/+$/, "") : "";
        const name = await inputDialog({
          title: "New folder",
          message: dir ? `In "${dir || "/"}".` : undefined,
          value: dir ? `${dir}/` : "",
          placeholder: "folder name",
        });
        if (name) await wsMkdir(name);
      },
    },
    {
      id: "files.quickOpen", title: "Quick open file…", category: "File", keybinding: "Ctrl+P",
      run: async () => {
        const files = await wsListAll();
        openPalette(
          files.map((f) => ({ label: f, icon: "file", run: () => runCommand("file.open", f) })),
          "Type a file name…",
        );
      },
    },
    {
      id: "workspace.exportZip", title: "Download workspace as .zip", category: "File", icon: "download",
      run: async () => {
        const data = await exportZip();
        const bytes = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
        const blob = new Blob([bytes], { type: "application/zip" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "pyttig-workspace.zip";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        notify.success("Workspace downloaded.");
      },
    },
    {
      id: "workspace.reset", title: "Reset workspace (delete everything)", category: "File", icon: "trash",
      run: async () => {
        const ok = await confirmDialog(
          "Reset workspace",
          "Delete every file and folder in this workspace? This cannot be undone. Cloned repositories and local files are removed as well.",
          "Delete everything",
          true,
        );
        if (!ok) return;
        await resetWorkspace();
        const { setGitRoot } = await import("../git/client");
        setGitRoot("/");
        notify.success("Workspace reset.");
      },
    },
    {
      id: "workspace.upload", title: "Upload files…", category: "File", icon: "upload",
      run: () => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.onchange = async () => {
          const list = [...(input.files ?? [])];
          for (const f of list) {
            const buf = new Uint8Array(await f.arrayBuffer());
            if (f.name.endsWith(".zip")) {
              const n = await importZip(buf);
              notify.success(`Imported ${n} files from ${f.name}.`);
            } else {
              await wsWrite(f.name, buf);
            }
          }
        };
        input.click();
      },
    },
    {
      id: "demo.run", title: "Open and run the demo", category: "Pyttig",
      run: async () => {
        if (!(await wsExists("main.py"))) await wsWrite("main.py", DEMO_MAIN, true);
        await runCommand("file.open", "main.py");
        await runCommand("python.run");
      },
    },
  ]);
}
