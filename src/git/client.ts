// Git client: RPC to the isomorphic-git worker, auth + CORS proxy resolution.

import { loadSettings } from "../app/settings";
import { getRootHandle } from "../fs/workspace";
import { handleWorkerError, resolveWorkerSource } from "../app/workerGuard";
import gitWorkerUrl from "./git.worker.ts?worker&url";

export interface GitAuthor {
  name: string;
  email: string;
}
export interface StatusRow {
  path: string;
  head: number;
  workdir: number;
  stage: number;
}
export interface CommitInfo {
  oid: string;
  message: string;
  author: string;
  email: string;
  timestamp: number;
  parents: string[];
}

let worker: Worker | null = null;
let reqId = 1;
const pending = new Map<number, (v: { ok: boolean; result?: unknown; error?: string; code?: string }) => void>();
const progressListeners = new Set<(p: { id: number; phase: string; loaded: number; total: number }) => void>();

export function onGitProgress(fn: (p: { id: number; phase: string; loaded: number; total: number }) => void): () => void {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

/** Fail every queued request so callers see an error instead of hanging. */
function failPending(detail: string): void {
  for (const [, r] of pending) r({ ok: false, error: detail });
  pending.clear();
}

async function ensure(): Promise<Worker> {
  if (worker) return worker;
  const source = await resolveWorkerSource(gitWorkerUrl);
  const w = new Worker(source.url, { type: "module" });
  setTimeout(source.revoke, 5000);
  w.onerror = (e) => {
    const detail = e.message || e.filename || "script failed to load";
    if (worker === w) worker = null; // next attempt starts fresh
    failPending(`git engine failed: ${detail}`);
    handleWorkerError("Git engine", gitWorkerUrl, detail);
  };
  w.onmessageerror = () => {
    if (worker === w) worker = null;
    failPending("git engine message error");
    handleWorkerError("Git engine", gitWorkerUrl, "message serialization error");
  };
  w.onmessage = (e: MessageEvent) => {
    const m = e.data as { id?: number; event?: string; ok?: boolean; result?: unknown; error?: string; code?: string; phase?: string; loaded?: number; total?: number; message?: string };
    if (m.event === "git-progress") {
      for (const l of progressListeners) l({ id: m.id!, phase: m.phase!, loaded: m.loaded ?? 0, total: m.total ?? 0 });
      return;
    }
    // Any other event (e.g. remote text messages) is informational only and
    // must never resolve a pending request.
    if (m.event) {
      if (m.event === "git-worker-unhandled") console.error("git worker:", m.message);
      return;
    }
    if (typeof m.id === "number" && pending.has(m.id)) {
      pending.get(m.id)!({ ok: !!m.ok, result: m.result, error: m.error, code: m.code });
      pending.delete(m.id);
    }
  };
  worker = w;
  const root = await getRootHandle();
  await call("init-worker", { root }, []);
  return w;
}

function call<T>(type: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error("git worker not started"));
      return;
    }
    const id = reqId++;
    pending.set(id, (v) => {
      if (v.ok) resolve(v.result as T);
      else {
        const err = new Error(v.error ?? "git failed") as Error & { code?: string };
        err.code = v.code;
        reject(err);
      }
    });
    worker.postMessage({ id, type, ...payload }, transfer);
  });
}

async function op<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  await ensure();
  return call<T>(type, { dir: getGitRoot(), ...payload });
}

// ---------- project root ----------

const ROOT_KEY = "pyttig.git.root";

/** Workspace-relative directory git operates in ("/" = workspace root). */
export function getGitRoot(): string {
  try {
    return localStorage.getItem(ROOT_KEY) || "/";
  } catch {
    return "/";
  }
}

export function setGitRoot(dir: string): void {
  try {
    if (!dir || dir === "/") localStorage.removeItem(ROOT_KEY);
    else localStorage.setItem(ROOT_KEY, dir.replace(/^\/+|\/+$/g, ""));
  } catch { /* ignore */ }
}

/** Map a git-root-relative path to a workspace-relative path. */
export function toWorkspacePath(p: string): string {
  const r = getGitRoot();
  return r === "/" ? p : `${r}/${p}`;
}

// ---------- auth ----------

const TOK_SESSION = "pyttig.git.token.session";
const TOK_SAVED = "pyttig.git.token";
const AUTHOR_KEY = "pyttig.git.author";

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOK_SESSION) ?? (loadSettings().rememberToken ? localStorage.getItem(TOK_SAVED) : null);
  } catch {
    return null;
  }
}

export function setToken(token: string | null, remember: boolean): void {
  try {
    if (!token) {
      sessionStorage.removeItem(TOK_SESSION);
      localStorage.removeItem(TOK_SAVED);
      return;
    }
    sessionStorage.setItem(TOK_SESSION, token);
    if (remember) localStorage.setItem(TOK_SAVED, token);
    else localStorage.removeItem(TOK_SAVED);
  } catch { /* ignore */ }
}

export function getAuthor(): GitAuthor | null {
  try {
    const raw = localStorage.getItem(AUTHOR_KEY);
    return raw ? (JSON.parse(raw) as GitAuthor) : null;
  } catch {
    return null;
  }
}

export function setAuthor(a: GitAuthor): void {
  try {
    localStorage.setItem(AUTHOR_KEY, JSON.stringify(a));
  } catch { /* ignore */ }
}

function authParam(): { username?: string; password?: string } | null {
  const t = getToken();
  if (!t) return null;
  // GitHub: any username + PAT as password. Support "user:token" too.
  if (t.includes(":")) {
    const [username, ...rest] = t.split(":");
    return { username, password: rest.join(":") };
  }
  return { username: t, password: t };
}

// ---------- CORS proxy ----------

export interface ProxyEnv {
  launcher: boolean;
  hostedProxy?: string;
  origin: string;
  basePath: string;
}

/** Pure resolver — unit tested. "auto" prefers launcher → hosted proxy → public. */
export function chooseCorsProxy(setting: string, env: ProxyEnv): string | undefined {
  const s = setting.trim();
  if (s === "none") return undefined;
  if (s && s !== "auto") return s;
  if (env.launcher) return `${env.origin}${env.basePath}__pyttig__/proxy`;
  if (env.hostedProxy) return env.hostedProxy;
  return "https://cors.isomorphic-git.org";
}

export function resolveCorsProxy(): string | undefined {
  const w = window as unknown as { __pyttigLauncher?: boolean; __pyttigProxy?: string };
  return chooseCorsProxy(loadSettings().corsProxy, {
    launcher: !!w.__pyttigLauncher,
    hostedProxy: w.__pyttigProxy,
    origin: location.origin,
    basePath: location.pathname.replace(/[^/]*$/, ""),
  });
}

function netParams(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { corsProxy: resolveCorsProxy(), auth: authParam(), ...extra };
}

// ---------- ops ----------

export const gitIsRepo = () => op<boolean>("isRepo");
export const gitInit = () => op("init");
export const gitStatusMatrix = () => op<[string, number, number, number][]>("status-matrix");
export const gitAdd = (filepath: string) => op("add", { filepath });
export const gitRemove = (filepath: string) => op("remove", { filepath });
export const gitCommit = (message: string, author: GitAuthor) => op<string>("commit", { message, author });
export const gitLog = (ref = "HEAD", depth = 30) => op<CommitInfo[]>("log", { ref, depth });
export const gitBranches = () => op<{ all: string[]; current: string | null }>("branches");
export const gitCheckout = (ref: string, force = false, filepaths?: string[]) =>
  op("checkout", { ref, force, filepaths });
export const gitResetIndex = (filepath: string) => op("reset-index", { filepath });
export const gitNewBranch = (ref: string) => op("new-branch", { ref });
export const gitFetch = (ref?: string) => op("fetch", netParams({ ref }));
export const gitPull = (author: GitAuthor, ref?: string) => op("pull", netParams({ author, ref, fastForward: false }));
export const gitPush = (remote = "origin", ref?: string) => op("push", netParams({ remote, ref }));
export const gitRemotes = () => op<{ remote: string; url: string }[]>("remotes");
export const gitAddRemote = (remote: string, url: string) => op("add-remote", { remote, url });
export const gitGetConfig = (path: string) => op<string | null>("get-config", { path });
export const gitSetConfig = (path: string, value: string) => op("set-config", { path, value });
export const gitResolveRef = (ref: string) => op<string | null>("resolve-ref", { ref });

export async function gitClone(url: string, name: string, ref?: string): Promise<string> {
  const r = await op<{ dir: string }>("clone", netParams({ url, name, ref, depth: 50 }));
  return r.dir;
}

export async function gitReadBlobText(oid: string, filepath: string): Promise<string | null> {
  try {
    const r = await op<{ bytes: ArrayBuffer }>("read-blob", { oid, filepath });
    return new TextDecoder().decode(r.bytes);
  } catch {
    return null;
  }
}

export async function gitReadTree(oid: string): Promise<{ path: string; type: string; oid: string }[]> {
  return op("read-tree", { oid });
}

export async function gitTreeFlat(oid: string): Promise<{ path: string; oid: string }[]> {
  return op("tree-flat", { oid });
}

/** Map a statusMatrix row to a display letter. */
export function statusLetter(row: [string, number, number, number]): string | null {
  const [, head, workdir, stage] = row;
  if (workdir === 0) return "D";
  if (head === 0 && stage === 0) return "U";
  if (head === 0) return "A";
  if (workdir === 2 || stage === 2 || stage === 3) return "M";
  return null;
}

export function isStaged(row: [string, number, number, number]): boolean {
  return row[3] === 2 || row[3] === 3;
}
