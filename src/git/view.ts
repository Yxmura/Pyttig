// Source Control view — deliberately minimal: clone, pull, fetch, switch branch.
// No commit UI, no staging, no history, no author prompts.

import type { Shell } from "../app/shell";
import { icons } from "../app/icons";
import { registerCommands } from "../app/commands";
import { notify } from "../app/toast";
import { inputDialog, confirmDialog, selectDialog } from "../app/dialog";
import { setGitStatusProvider, onWorkspaceChange, emitWorkspaceReset } from "../fs/workspace";
import {
  gitIsRepo, gitBranches, gitCheckout, gitFetch, gitPull, gitRemotes, gitClone,
  getGitRoot, setGitRoot, onGitProgress, getToken, setToken,
} from "./client";
import { loadSettings } from "../app/settings";

let shellRef: Shell;
let branches: { all: string[]; current: string | null } = { all: [], current: null };
let remotes: { remote: string; url: string }[] = [];
let isRepo = false;
let busy = "";
let lastProgress = "";
const refreshListeners = new Set<() => void>();
const onRefresh = (fn: () => void) => {
  refreshListeners.add(fn);
  return () => refreshListeners.delete(fn);
};
function refreshed() {
  for (const l of refreshListeners) l();
}

async function refreshState(): Promise<void> {
  try {
    isRepo = await gitIsRepo();
  } catch {
    isRepo = false;
    return;
  }
  if (!isRepo) {
    branches = { all: [], current: null };
    remotes = [];
    refreshed();
    return;
  }
  try {
    branches = await gitBranches();
  } catch {
    branches = { all: [], current: null };
  }
  try {
    remotes = await gitRemotes();
  } catch {
    remotes = [];
  }
  refreshed();
}

function repoName(): string {
  const root = getGitRoot();
  return root === "/" ? "workspace" : root;
}

class UserCancelled extends Error {}

async function withAuthRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const code = (err as { code?: string }).code;
    const msg = String((err as Error).message ?? "");
    if (code === "AuthRequired" || code === "AuthFailure" || /401|403/i.test(msg)) {
      const token = await inputDialog({
        title: `${label}: sign in`,
        message: "This repository is private. Paste a GitHub personal access token (Contents: read/write). It stays in this browser.",
        password: true,
        placeholder: "github_pat_…",
      });
      if (!token) throw new UserCancelled();
      setToken(token.trim(), loadSettings().rememberToken);
      return await fn();
    }
    throw err;
  }
}

function isCancel(err: unknown): boolean {
  return err instanceof UserCancelled;
}

// ---------- view ----------

function renderGitView(host: HTMLElement) {
  host.innerHTML = "";
  const draw = () => {
    host.innerHTML = "";

    if (!isRepo) {
      const wrap = document.createElement("div");
      wrap.className = "git-empty";
      wrap.innerHTML = `
        <p class="git-empty-title">No repository yet</p>
        <p class="git-empty-note">Clone a repository to get started.</p>
        <button class="btn primary" data-clone>${icons.download}<span>Clone repository…</span></button>
        <button class="btn" data-folder>${icons.folderOpen}<span>Use existing folder…</span></button>`;
      (wrap.querySelector("[data-clone]") as HTMLButtonElement).onclick = () => void doClone();
      (wrap.querySelector("[data-folder]") as HTMLButtonElement).onclick = () => void pickFolder();
      host.appendChild(wrap);
      return;
    }

    // Repository header
    const head = document.createElement("div");
    head.className = "git-head";
    head.innerHTML = `<div class="repo-name"></div>`;
    (head.querySelector(".repo-name") as HTMLElement).textContent = repoName();

    const branchBtn = document.createElement("button");
    branchBtn.className = "git-branch";
    branchBtn.innerHTML = `<span class="ico">${icons.branch}</span><span class="b"></span><span class="chev">${icons.chevronDown}</span>`;
    (branchBtn.querySelector(".b") as HTMLElement).textContent = branches.current ?? "no branch";
    branchBtn.title = "Switch branch";
    branchBtn.onclick = () => void doSwitchBranch();
    head.appendChild(branchBtn);
    host.appendChild(head);

    // Actions
    const actions = document.createElement("div");
    actions.className = "git-actions";
    const pull = document.createElement("button");
    pull.className = "btn primary";
    pull.innerHTML = `${icons.arrowDown}<span>Pull</span>`;
    pull.title = "Fetch and merge the latest changes from the remote";
    pull.disabled = !!busy;
    pull.onclick = () => void doPull();
    const fetchBtn = document.createElement("button");
    fetchBtn.className = "btn";
    fetchBtn.innerHTML = `<span>Fetch</span>`;
    fetchBtn.title = "Check the remote without applying changes";
    fetchBtn.disabled = !!busy;
    fetchBtn.onclick = () => void doFetch();
    actions.append(pull, fetchBtn);
    host.appendChild(actions);

    if (busy) {
      const status = document.createElement("div");
      status.className = "git-status";
      status.textContent = lastProgress ? `${busy} · ${lastProgress}` : `${busy}…`;
      host.appendChild(status);
      const bar = document.createElement("div");
      bar.className = "progress indet";
      bar.innerHTML = "<div></div>";
      host.appendChild(bar);
    }

    // Remote
    const remote = remotes[0];
    if (remote) {
      const sec = document.createElement("div");
      sec.className = "side-section";
      sec.innerHTML = `<h4>Remote</h4>`;
      const url = document.createElement("div");
      url.className = "git-remote";
      url.textContent = remote.url.replace(/^https?:\/\//, "");
      url.title = `Click to copy: ${remote.url}`;
      url.onclick = () => {
        void navigator.clipboard.writeText(remote.url).then(
          () => notify.success("Remote URL copied."),
          () => notify.info(remote.url),
        );
      };
      sec.appendChild(url);
      host.appendChild(sec);
    }

    // Footer
    const foot = document.createElement("div");
    foot.className = "git-foot";
    const folder = document.createElement("button");
    folder.className = "row-btn";
    folder.innerHTML = `${icons.folderOpen}<span>Change folder…</span>`;
    folder.onclick = () => void pickFolder();
    foot.appendChild(folder);
    host.appendChild(foot);
  };
  const off = onRefresh(draw);
  draw();
  return off;
}

// ---------- actions ----------

async function doClone() {
  shellRef.showActivity("git");
  const url = await inputDialog({
    title: "Clone repository",
    message: "HTTPS URL of the repository.",
    placeholder: "https://github.com/user/repo.git",
  });
  if (!url) return;
  const m = /\/([^/]+?)(\.git)?\/?$/.exec(url.trim());
  const name = await inputDialog({ title: "Clone into folder", value: m?.[1] ?? "repo" });
  if (!name) return;
  busy = `Cloning ${name}`;
  refreshed();
  try {
    const dir = await withAuthRetry("Clone", () => gitClone(url.trim(), name.trim()));
    notify.success(`Cloned into "${dir}".`);
    emitWorkspaceReset();
    if (await confirmDialog("Clone complete", `Use "${dir}" as the git project?`, "Use as project")) {
      setGitRoot(dir);
    }
    await offerRequirements(dir);
    // Land in the Explorer so the cloned files are visible straight away.
    shellRef.showActivity("explorer");
    const { revealInExplorer } = await import("../fs/workspace");
    await revealInExplorer(dir);
  } catch (err) {
    if (!isCancel(err)) {
      try {
        const { wsDelete, wsExists } = await import("../fs/workspace");
        if (await wsExists(name.trim())) await wsDelete(name.trim());
      } catch { /* ignore */ }
      notify.error(`Clone failed: ${err instanceof Error ? err.message : err}`);
    }
  } finally {
    busy = "";
    lastProgress = "";
    await refreshState();
    shellRef.refreshBadges();
  }
}

/** Exercise repos often ship a requirements.txt — offer one-click install. */
async function offerRequirements(dir: string): Promise<void> {
  try {
    const [{ wsExists, wsRead }, { parseRequirements, REQUIREMENTS_FILE }, { ensurePackages }] = await Promise.all([
      import("../fs/workspace"),
      import("../runtime/requirements"),
      import("../runtime/client"),
    ]);
    const path = `${dir}/${REQUIREMENTS_FILE}`.replace(/^\/+/, "");
    if (!(await wsExists(path))) return;
    const names = parseRequirements(await wsRead(path));
    if (!names.length) return;
    const ok = await confirmDialog(
      "Install dependencies",
      `${REQUIREMENTS_FILE} found: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}. Install now?`,
      "Install",
    );
    if (!ok) return;
    shellRef.showActivity("packages");
    notify.info(`Installing ${names.length} package(s)…`, { timeout: 6000 });
    const r = await ensurePackages(names);
    if (r.failed.length) {
      notify.warn(`Installed ${r.installed.length}; skipped: ${r.failed.join(", ")}`, { timeout: 15000 });
    } else {
      notify.success(`Installed ${r.installed.length} package(s). You are ready to run.`);
    }
  } catch {
    /* best effort — never block the clone flow */
  }
}

async function doPull() {
  busy = "Pulling";
  refreshed();
  try {
    await withAuthRetry("Pull", () =>
      gitPull({ name: "Pyttig", email: "pyttig@local" }),
    );
    notify.success("Pulled.");
    emitWorkspaceReset();
  } catch (err) {
    if (isCancel(err)) return;
    const msg = err instanceof Error ? err.message : String(err);
    if (/conflict/i.test(msg)) {
      notify.warn("Merge conflicts. Resolve the markers in the editor.", { timeout: 10000 });
    } else {
      notify.error(`Pull failed: ${msg}`);
    }
  } finally {
    busy = "";
    lastProgress = "";
    await refreshState();
    shellRef.refreshBadges();
  }
}

async function doFetch() {
  busy = "Fetching";
  refreshed();
  try {
    await withAuthRetry("Fetch", () => gitFetch());
    notify.success("Fetched.");
  } catch (err) {
    if (isCancel(err)) return;
    notify.error(`Fetch failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    busy = "";
    lastProgress = "";
    await refreshState();
    shellRef.refreshBadges();
  }
}

async function doSwitchBranch() {
  await refreshState();
  const cur = branches.current;
  if (!branches.all.length) {
    notify.info("No branches found.");
    return;
  }
  const choice = await selectDialog({
    title: "Switch branch",
    items: branches.all.map((b) => ({ label: `${b === cur ? "● " : "   "}${b}`, value: b })),
  });
  if (!choice || choice === cur) return;
  try {
    await gitCheckout(choice);
    notify.success(`Switched to ${choice}.`);
    emitWorkspaceReset();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/conflict/i.test(msg)) {
      if (await confirmDialog("Checkout conflicts", "Your local changes conflict. Discard them and switch?", "Discard & switch", true)) {
        await gitCheckout(choice, true);
        emitWorkspaceReset();
      }
    } else {
      notify.error(`Checkout failed: ${msg}`);
    }
  }
  await refreshState();
  shellRef.refreshBadges();
}

async function pickFolder() {
  const { wsListDir } = await import("../fs/workspace");
  const dirs = (await wsListDir("")).filter((d) => d.kind === "dir").map((d) => d.name);
  const choice = await selectDialog({
    title: "Git project folder",
    message: "Git commands run in this folder.",
    items: [{ label: "/ (workspace root)", value: "/" }, ...dirs.map((d) => ({ label: d, value: d }))],
  });
  if (choice === null) return;
  setGitRoot(choice);
  notify.success(choice === "/" ? "Git project: workspace root." : `Git project: ${choice}.`);
  await refreshState();
  shellRef.refreshBadges();
}

// ---------- init ----------

export async function initGit(sh: Shell): Promise<void> {
  shellRef = sh;
  setGitStatusProvider(null);

  sh.registerActivity({
    id: "git", title: "Source Control", icon: "git", order: 3,
    render: renderGitView,
  });

  sh.setStatus({
    id: "git", side: "left", order: 5, icon: "branch",
    text: () => {
      if (!isRepo) return "No repository";
      const root = getGitRoot();
      const where = root === "/" ? "" : ` · ${root}`;
      return `${branches.current ?? "…"}${where}`;
    },
    tooltip: () => `Git project: ${getGitRoot()}`,
    onClick: () => sh.setActivity("git"),
  });

  registerCommands([
    { id: "git.clone", title: "Clone repository…", category: "Git", icon: "download", run: () => doClone() },
    { id: "git.pull", title: "Pull latest changes", category: "Git", icon: "arrowDown", run: () => doPull() },
    { id: "git.fetch", title: "Fetch from remote", category: "Git", run: () => doFetch() },
    { id: "git.branch", title: "Switch branch…", category: "Git", icon: "branch", run: () => doSwitchBranch() },
    { id: "git.setRoot", title: "Change git project folder…", category: "Git", run: () => pickFolder() },
  ]);

  onGitProgress((p) => {
    lastProgress = p.total ? `${p.phase} ${p.loaded}/${p.total}` : p.phase;
    refreshed();
  });
  onWorkspaceChange(() => {
    void refreshState().then(() => sh.refreshBadges());
  });

  // Fire-and-forget: a slow worker must never hold up app startup.
  void refreshState().then(() => sh.refreshBadges());
}
