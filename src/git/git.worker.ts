// isomorphic-git worker: real git (clone/pull/push/commit/…) on the OPFS
// workspace, off the UI thread. The FS adapter below implements just enough
// of the Node fs.promises surface for isomorphic-git.

import * as git from "isomorphic-git";
import { Buffer } from "buffer";

// isomorphic-git expects a Node-ish environment; provide Buffer in workers.
(globalThis as unknown as { Buffer?: unknown }).Buffer ??= Buffer;

/** Buffered HTTP client: reads the whole response into memory instead of
 *  streaming it. Works around ReadableStream stalls observed with
 *  fetch() bodies inside workers on some responses. */
async function collectBody(iterable: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (iterable instanceof Uint8Array) return iterable;
  const iter = (iterable as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]
    ? (iterable as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
    : (iterable as Iterable<Uint8Array>)[Symbol.iterator]();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await iter.next();
    if (value) {
      parts.push(value);
      size += value.byteLength;
    }
    if (done) break;
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

const bufferedHttp = {
  async request(req: {
    url: string; method?: string; headers?: Record<string, string>;
    body?: AsyncIterable<Uint8Array>; signal?: AbortSignal;
  }) {
    let body: Uint8Array | undefined;
    if (req.body) body = await collectBody(req.body);
    const res = await fetch(req.url, {
      method: req.method ?? "GET",
      headers: req.headers ?? {},
      body: body as unknown as BodyInit | undefined,
      signal: req.signal ?? null,
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return {
      url: res.url,
      method: req.method ?? "GET",
      statusCode: res.status,
      statusMessage: res.statusText,
      headers,
      body: (async function* () {
        yield buf;
      })(),
    };
  },
};

// ---------- OPFS fs adapter ----------

let ROOT: FileSystemDirectoryHandle | null = null;

/** POSIX-ish normalize relative to the workspace root: strips leading/trailing
 *  slashes and resolves "." / ".." lexically (never above root). */
const norm = (p: string): string => {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
};

function enoent(path: string): Error {
  const e = new Error(`ENOENT: no such file or directory, '${path}'`) as Error & { code: string };
  e.code = "ENOENT";
  return e;
}

async function parentOf(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  try {
    const parts = norm(path).split("/").filter(Boolean);
    const name = parts.pop() ?? "";
    let dir = ROOT!;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    return { dir, name };
  } catch {
    // Normalize raw OPFS DOMExceptions (numeric .code) to string-coded errors
    // so isomorphic-git can reliably detect ENOENT.
    throw enoent(path);
  }
}

function stats(isFile: boolean, size: number, mtimeMs: number) {
  return {
    type: isFile ? "file" : "dir",
    mode: isFile ? 0o100644 : 0o040000,
    ino: Math.floor(Math.random() * 1e9),
    size,
    mtimeMs,
    ctimeMs: mtimeMs,
    uid: 1,
    gid: 1,
    dev: 1,
    isFile: () => isFile,
    isDirectory: () => !isFile,
    isSymbolicLink: () => false,
  };
}

function dlog(...args: unknown[]) {
  if ((globalThis as unknown as { __GIT_DEBUG?: boolean }).__GIT_DEBUG) {
    console.log("[gitfs]", ...args);
  }
}

const promises = {
  async readFile(path: string, options?: { encoding?: string } | string): Promise<Uint8Array | string> {
    const { dir, name } = await parentOf(path, false);
    let fh: FileSystemFileHandle;
    try {
      fh = await dir.getFileHandle(name);
    } catch {
      throw enoent(path);
    }
    const file = await fh.getFile();
    const buf = new Uint8Array(await file.arrayBuffer());
    const enc = typeof options === "string" ? options : options?.encoding;
    if (enc === "utf8" || enc === "utf-8") return new TextDecoder().decode(buf);
    return buf;
  },

  async writeFile(path: string, data: string | Uint8Array, _opts?: unknown): Promise<void> {
    const { dir, name } = await parentOf(path, true);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(typeof data === "string" ? data : (data as unknown as ArrayBuffer));
    } finally {
      await w.close();
    }
  },

  async unlink(path: string): Promise<void> {
    const { dir, name } = await parentOf(path, false);
    try {
      await dir.removeEntry(name);
    } catch {
      throw enoent(path);
    }
  },

  async readdir(path: string): Promise<string[]> {
    let dir = ROOT!;
    const p = norm(path);
    try {
      if (p) {
        for (const seg of p.split("/")) dir = await dir.getDirectoryHandle(seg);
      }
    } catch {
      throw enoent(path);
    }
    const out: string[] = [];
    const entries = (dir as unknown as { entries: () => AsyncIterableIterator<[string, FileSystemHandle]> }).entries;
    for await (const [name] of entries.call(dir)) out.push(name);
    return out;
  },

  async mkdir(path: string): Promise<void> {
    await parentOf(path + "/.keep", true);
  },

  async rmdir(path: string): Promise<void> {
    const { dir, name } = await parentOf(path, false);
    try {
      await dir.removeEntry(name);
    } catch {
      throw enoent(path);
    }
  },

  async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const { dir, name } = await parentOf(path, false);
    try {
      await dir.removeEntry(name, { recursive: !!opts?.recursive });
    } catch {
      if (!opts?.force) throw enoent(path);
    }
  },

  async stat(path: string): Promise<ReturnType<typeof stats>> {
    const p = norm(path);
    if (!p) return stats(false, 0, Date.now());
    const { dir, name } = await parentOf(path, false);
    try {
      const fh = await dir.getFileHandle(name);
      const f = await fh.getFile();
      return stats(true, f.size, f.lastModified);
    } catch { /* not a file */ }
    try {
      await dir.getDirectoryHandle(name);
      return stats(false, 0, Date.now());
    } catch {
      throw enoent(path);
    }
  },

  async lstat(path: string): Promise<ReturnType<typeof stats>> {
    return promises.stat(path);
  },

  async rename(oldPath: string, newPath: string): Promise<void> {
    const o = norm(oldPath);
    const n = norm(newPath);
    const src = await parentOf(o, false);
    const dst = await parentOf(n, true);
    const srcName = o.split("/").pop()!;
    const dstName = n.split("/").pop()!;
    // Prefer atomic move when available.
    try {
      const handle = await (async () => {
        try {
          return await src.dir.getFileHandle(srcName);
        } catch {
          return await src.dir.getDirectoryHandle(srcName);
        }
      })();
      const mover = (handle as unknown as { move?: (d: unknown, n: string) => Promise<void> }).move;
      if (mover) {
        await mover.call(handle, dst.dir, dstName);
        return;
      }
    } catch { /* fall through to copy */ }
    // Copy fallback.
    const isFile = await (async () => {
      try {
        await src.dir.getFileHandle(srcName);
        return true;
      } catch {
        return false;
      }
    })();
    if (isFile) {
      const data = (await promises.readFile(o)) as Uint8Array;
      await promises.writeFile(n, data);
    } else {
      await promises.mkdir(n);
      for (const child of await promises.readdir(o)) {
        await promises.rename(`${o}/${child}`, `${n}/${child}`);
      }
    }
    await promises.rm(o, { recursive: true, force: true });
  },

  async readlink(): Promise<string> {
    throw new Error("symlinks are not supported in the browser workspace");
  },
  async symlink(): Promise<void> {
    throw new Error("symlinks are not supported in the browser workspace");
  },
};

const fs = { promises };

// ---------- worker protocol ----------

type Msg = { id: number; type: string; [k: string]: unknown };
const post = (m: unknown, transfer?: Transferable[]) =>
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(m, transfer);

// Surface background failures (e.g. a dying stream pump) that would
// otherwise stall operations silently.
(self as unknown as { addEventListener(t: string, f: (e: unknown) => void): void }).addEventListener(
  "unhandledrejection",
  (e) => {
    const r = e as { reason?: { stack?: string } | string };
    const msg = typeof r.reason === "string" ? r.reason : r.reason?.stack ?? String(r.reason);
    try {
      post({ event: "git-worker-unhandled", message: String(msg).slice(0, 500) });
    } catch { /* ignore */ }
  },
);

function authCallbacks(auth: { username?: string; password?: string } | null) {
  return {
    onAuth: () => {
      if (auth?.username !== undefined) return { username: auth.username, password: auth.password };
      const e = new Error("Authentication required (no token provided)") as Error & { code: string };
      e.code = "AuthRequired";
      throw e;
    },
    onAuthFailure: () => {
      const e = new Error("Authentication failed (bad token?)") as Error & { code: string };
      e.code = "AuthFailure";
      throw e;
    },
    onAuthSuccess: undefined,
  };
}

function progress(id: number) {
  return (p: { phase: string; loaded?: number; total?: number }) =>
    post({ event: "git-progress", id, phase: p.phase, loaded: p.loaded ?? 0, total: p.total ?? 0 });
}

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    console.log("[gitworker] op:", m.type, "dir:", m.dir);
    if (m.type === "init-worker") {
      ROOT = m.root as FileSystemDirectoryHandle;
      if (!ROOT || typeof (ROOT as unknown as { getDirectoryHandle?: unknown }).getDirectoryHandle !== "function") {
        throw new Error(`git worker init: invalid root handle (${typeof m.root})`);
      }
      // sanity: list root
      await promises.readdir("/");
      post({ id: m.id, ok: true });
      return;
    }
    if (!ROOT) throw new Error("fs not initialized");
    const dir = (m.dir as string) || "/";
    const corsProxy = (m.corsProxy as string) || undefined;
    const auth = (m.auth ?? null) as { username?: string; password?: string } | null;
    let result: unknown = null;

    switch (m.type) {
      case "isRepo":
        try {
          await promises.stat(`${dir}/.git`);
          result = true;
        } catch {
          result = false;
        }
        break;
      case "init":
        await git.init({ fs, dir });
        break;
      case "clone":
        await git.clone({
          fs, http: bufferedHttp, dir: `${dir}/${m.name}`,
          url: m.url as string,
          corsProxy,
          singleBranch: true,
          depth: (m.depth as number) ?? 50,
          ref: (m.ref as string) || undefined,
          ...authCallbacks(auth),
          onProgress: progress(m.id),
          // NOTE: no `id` here — event posts must never look like responses.
          onMessage: (msg) => post({ event: "git-remote-message", message: String(msg) }),
        });
        result = { dir: `${dir}/${m.name}`.replace(/^\/+/, "") };
        break;
      case "status-matrix":
        result = await git.statusMatrix({ fs, dir });
        break;
      case "add":
        await git.add({ fs, dir, filepath: m.filepath as string });
        break;
      case "remove":
        await git.remove({ fs, dir, filepath: m.filepath as string });
        break;
      case "commit":
        result = await git.commit({
          fs, dir,
          message: m.message as string,
          author: m.author as { name: string; email: string },
        });
        break;
      case "log": {
        const commits = await git.log({ fs, dir, ref: (m.ref as string) || "HEAD", depth: (m.depth as number) ?? 30 });
        result = commits.map((c) => ({
          oid: c.oid,
          message: c.commit.message,
          author: c.commit.author.name,
          email: c.commit.author.email,
          timestamp: c.commit.author.timestamp,
          parents: c.commit.parent,
        }));
        break;
      }
      case "branches": {
        const all = await git.listBranches({ fs, dir });
        const cur = await git.currentBranch({ fs, dir, fullname: false }).catch(() => null);
        result = { all, current: cur };
        break;
      }
      case "checkout":
        await git.checkout({
          fs, dir, ref: m.ref as string, force: !!(m.force as boolean),
          filepaths: (m.filepaths as string[]) || undefined,
        });
        break;
      case "reset-index":
        await git.resetIndex({ fs, dir, filepath: m.filepath as string });
        break;
      case "new-branch":
        await git.branch({ fs, dir, ref: m.ref as string, checkout: true });
        break;
      case "fetch":
        await git.fetch({
          fs, http: bufferedHttp, dir, corsProxy,
          ref: (m.ref as string) || undefined,
          singleBranch: true,
          ...authCallbacks(auth),
          onProgress: progress(m.id),
        });
        break;
      case "pull":
        await git.pull({
          fs, http: bufferedHttp, dir, corsProxy,
          ref: (m.ref as string) || undefined,
          singleBranch: true,
          fastForward: (m.fastForward as boolean) ?? true,
          author: (m.author as { name: string; email: string }) ?? { name: "Pyttig", email: "pyttig@local" },
          ...authCallbacks(auth),
          onProgress: progress(m.id),
        });
        break;
      case "push":
        await git.push({
          fs, http: bufferedHttp, dir, corsProxy,
          remote: (m.remote as string) || "origin",
          ref: (m.ref as string) || undefined,
          ...authCallbacks(auth),
          onProgress: progress(m.id),
        });
        break;
      case "remotes": {
        const remotes = await git.listRemotes({ fs, dir });
        result = remotes;
        break;
      }
      case "add-remote":
        await git.addRemote({ fs, dir, remote: m.remote as string, url: m.url as string });
        break;
      case "get-config": {
        const v = await git.getConfig({ fs, dir, path: m.path as string }).catch(() => null);
        result = v;
        break;
      }
      case "set-config":
        await git.setConfig({ fs, dir, path: m.path as string, value: m.value as string });
        break;
      case "read-blob": {
        const { blob } = await git.readBlob({ fs, dir, oid: m.oid as string, filepath: m.filepath as string });
        const bytes = (blob as Uint8Array).buffer as ArrayBuffer;
        post({ id: m.id, ok: true, result: { bytes } }, [bytes]);
        return;
      }
      case "read-tree": {
        const { tree } = await git.readTree({ fs, dir, oid: m.oid as string });
        result = tree.map((e) => ({ path: e.path, type: e.type, oid: e.oid }));
        break;
      }
      case "tree-flat": {
        // Recursive {path, oid} listing of all blobs under a commit/tree oid.
        const out: { path: string; oid: string }[] = [];
        const walk = async (treeOid: string, base: string) => {
          const { tree } = await git.readTree({ fs, dir, oid: treeOid });
          for (const e of tree) {
            const full = base ? `${base}/${e.path}` : e.path;
            if (e.type === "blob") out.push({ path: full, oid: e.oid });
            else if (e.type === "tree") await walk(e.oid, full);
          }
        };
        await walk(m.oid as string, "");
        result = out;
        break;
      }
      case "resolve-ref": {
        result = await git.resolveRef({ fs, dir, ref: m.ref as string }).catch(() => null);
        break;
      }
      default:
        throw new Error(`unknown git op: ${m.type}`);
    }
    post({ id: m.id, ok: true, result });
  } catch (err) {
    const e2 = err as { message?: string; code?: string; data?: unknown };
    post({ id: m.id, ok: false, error: e2?.message ?? String(err), code: e2?.code, data: e2?.data });
  }
};
