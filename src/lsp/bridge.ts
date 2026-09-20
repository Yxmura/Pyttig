// Pyttig language bridge: a genuine LSP server living in-process.
// The CodeMirror LSP client talks pure JSON-RPC to it; intelligence comes
// from Jedi (in the Pyodide worker) and Ruff (WASM worker).

import { LSPClient, languageServerExtensions, type Transport } from "@codemirror/lsp-client";
import type { Shell } from "../app/shell";
import { registerCommands } from "../app/commands";
import { loadSettings } from "../app/settings";
import { notify } from "../app/toast";
import {
  uriFor, pathFor, setLspExtensionProvider, openFile,
  getTabText, replaceDocText, editorHooks, beforeSaveHooks,
} from "../editor/manager";
import { wsWrite, onWorkspaceChange } from "../fs/workspace";
import { lspRequest, syncWorkspaceToWorker } from "../runtime/client";
import { ruffCheck, ruffFormat, ruffSeverity, type RuffDiagnostic } from "./ruffClient";
import { outlineSymbols } from "./outline";

interface LspPos {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPos;
  end: LspPos;
}
interface Problem {
  uri: string;
  severity: 1 | 2 | 3 | 4;
  code: string;
  message: string;
  range: LspRange;
  fix?: { title: string; edits: { range: LspRange; newText: string }[] };
}

interface Doc {
  uri: string;
  version: number;
  text: string;
}

const docs = new Map<string, Doc>();
const problems = new Map<string, Problem[]>();
const diagTimers = new Map<string, number>();
let shellRef: Shell;
let client: LSPClient;
let transport: BridgeTransport;
let wsSynced = false;

const JEDI_ROOT = "/home/pyodide/workspace";
const jediPath = (rel: string) => `${JEDI_ROOT}/${rel}`;
const relOfJediPath = (p: string) => (p.startsWith(JEDI_ROOT + "/") ? p.slice(JEDI_ROOT.length + 1) : null);

// ---------- transport ----------

class BridgeTransport implements Transport {
  private handlers = new Set<(value: string) => void>();
  send(message: string): void {
    let msg: { id?: number | string; method?: string; params?: unknown };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    void handleMessage(msg);
  }
  subscribe(handler: (value: string) => void): void {
    this.handlers.add(handler);
  }
  unsubscribe(handler: (value: string) => void): void {
    this.handlers.delete(handler);
  }
  emit(obj: unknown): void {
    const s = JSON.stringify(obj);
    for (const h of this.handlers) {
      try {
        h(s);
      } catch (err) {
        console.error(err);
      }
    }
  }
}

function respond(id: number | string | undefined, result: unknown) {
  if (id === undefined) return;
  transport.emit({ jsonrpc: "2.0", id, result });
}
function fail(id: number | string | undefined, message: string) {
  if (id === undefined) return;
  transport.emit({ jsonrpc: "2.0", id, error: { code: -32603, message } });
}

// ---------- jedi plumbing ----------

async function jedi(op: string, uri: string, pos: LspPos, extra: Record<string, unknown> = {}): Promise<unknown> {
  const doc = docs.get(uri);
  const rel = pathFor(uri);
  if (!doc) throw new Error("document not open");
  if (!wsSynced) {
    wsSynced = true;
    await syncWorkspaceToWorker().catch(() => undefined);
  }
  return lspRequest(op, {
    code: doc.text,
    path: jediPath(rel),
    line: pos.line + 1,
    column: pos.character,
    ...extra,
  });
}

function lspPos(line1: number, col: number): LspPos {
  return { line: Math.max(0, line1 - 1), character: Math.max(0, col) };
}

interface JediTarget {
  path: string | null;
  line: number;
  column: number;
  name: string;
  type: string;
}

function targetToLocation(t: JediTarget): { uri: string; range: LspRange } | null {
  if (!t.path) return null;
  const rel = relOfJediPath(t.path);
  if (!rel) return null; // stdlib / site-packages — not openable
  const p = lspPos(t.line, t.column);
  return { uri: uriFor(rel), range: { start: p, end: p } };
}

// ---------- request handlers ----------

const KIND: Record<string, number> = {
  function: 3, method: 2, class: 7, module: 9, keyword: 14,
  param: 6, statement: 6, property: 10, instance: 6, path: 17, constant: 21,
};

async function handleMessage(msg: { id?: number | string; method?: string; params?: unknown }) {
  const { id, method, params } = msg;
  const p = (params ?? {}) as Record<string, unknown>;
  try {
    switch (method) {
      case "initialize": {
        respond(id, {
          capabilities: {
            textDocumentSync: 1,
            completionProvider: { triggerCharacters: ["."], resolveProvider: false },
            hoverProvider: true,
            signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
            definitionProvider: true,
            referencesProvider: true,
            renameProvider: true,
            documentSymbolProvider: true,
            documentFormattingProvider: true,
            codeActionProvider: true,
          },
          serverInfo: { name: "pyttig-lsp", version: "0.1.0" },
        });
        break;
      }
      case "initialized":
      case "exit":
      case "$/cancelRequest":
        break;
      case "shutdown":
        respond(id, null);
        break;
      case "textDocument/didOpen": {
        const td = (p as { textDocument: { uri: string; version: number; text: string } }).textDocument;
        docs.set(td.uri, { uri: td.uri, version: td.version, text: td.text });
        scheduleDiagnostics(td.uri);
        break;
      }
      case "textDocument/didChange": {
        const td = (p as { textDocument: { uri: string; version: number } }).textDocument;
        const changes = (p as { contentChanges: { text: string }[] }).contentChanges;
        const doc = docs.get(td.uri);
        if (doc && changes.length) {
          doc.text = changes[changes.length - 1].text;
          doc.version = td.version;
          scheduleDiagnostics(td.uri);
        }
        break;
      }
      case "textDocument/didClose": {
        const td = (p as { textDocument: { uri: string } }).textDocument;
        docs.delete(td.uri);
        publish(td.uri, []);
        break;
      }
      case "textDocument/completion": {
        const cp = p as { textDocument: { uri: string }; position: LspPos };
        const r = (await jedi("complete", cp.textDocument.uri, cp.position)) as {
          ok: boolean; items?: { name: string; type: string; doc: string; signature: string }[];
        };
        respond(id, {
          isIncomplete: false,
          items: (r.ok ? r.items ?? [] : []).map((c, i) => ({
            label: c.name,
            kind: KIND[c.type] ?? 6,
            detail: c.signature || c.type,
            documentation: c.doc ? { kind: "markdown", value: c.doc } : undefined,
            sortText: String(i).padStart(4, "0"),
          })),
        });
        break;
      }
      case "completionItem/resolve":
        respond(id, p);
        break;
      case "textDocument/hover": {
        const hp = p as { textDocument: { uri: string }; position: LspPos };
        const r = (await jedi("hover", hp.textDocument.uri, hp.position)) as {
          ok: boolean; value?: { markdown: string } | null;
        };
        respond(id, r.ok && r.value ? { contents: { kind: "markdown", value: r.value.markdown } } : null);
        break;
      }
      case "textDocument/signatureHelp": {
        const sp = p as { textDocument: { uri: string }; position: LspPos };
        const r = (await jedi("signature", sp.textDocument.uri, sp.position)) as {
          ok: boolean; signatures?: { label: string; doc: string; params: string[]; index: number }[];
        };
        const list = (r.ok ? r.signatures ?? [] : []).map((s) => ({
          label: s.label,
          documentation: s.doc ? { kind: "markdown", value: s.doc } : undefined,
          parameters: s.params.map((x) => ({ label: x })),
        }));
        respond(id, {
          signatures: list,
          activeSignature: 0,
          activeParameter: Math.max(0, (r.ok ? r.signatures?.[0]?.index : 0) ?? 0),
        });
        break;
      }
      case "textDocument/definition": {
        const dp = p as { textDocument: { uri: string }; position: LspPos };
        const r = (await jedi("goto", dp.textDocument.uri, dp.position)) as { ok: boolean; targets?: JediTarget[] };
        respond(id, (r.ok ? r.targets ?? [] : []).map(targetToLocation).filter(Boolean));
        break;
      }
      case "textDocument/references": {
        const rp = p as { textDocument: { uri: string }; position: LspPos };
        const r = (await jedi("references", rp.textDocument.uri, rp.position)) as { ok: boolean; targets?: JediTarget[] };
        respond(id, (r.ok ? r.targets ?? [] : []).map(targetToLocation).filter(Boolean));
        break;
      }
      case "textDocument/rename": {
        const np = p as { textDocument: { uri: string }; position: LspPos; newName: string };
        const r = (await jedi("rename", np.textDocument.uri, np.position, { new_name: np.newName })) as {
          ok: boolean; changed?: Record<string, string>; error?: string;
        };
        if (!r.ok) {
          notify.warn(`Rename failed: ${r.error ?? "unknown error"}`);
          respond(id, null);
          break;
        }
        const changes: Record<string, { range: LspRange; newText: string }[]> = {};
        for (const [full, code] of Object.entries(r.changed ?? {})) {
          const rel = relOfJediPath(full);
          if (!rel) continue;
          const uri = uriFor(rel);
          if (docs.has(uri)) {
            changes[uri] = [{ range: fullRange(uri), newText: code }];
          } else {
            await wsWrite(rel, code); // closed file: apply directly
          }
        }
        respond(id, { changes });
        break;
      }
      case "textDocument/documentSymbol": {
        const ds = p as { textDocument: { uri: string } };
        const text = docs.get(ds.textDocument.uri)?.text ?? "";
        respond(id, outlineSymbols(ds.textDocument.uri, text));
        break;
      }
      case "textDocument/formatting": {
        const fp = p as { textDocument: { uri: string } };
        const text = docs.get(fp.textDocument.uri)?.text ?? "";
        const out = await ruffFormat(text);
        respond(id, out && out !== text ? [{ range: fullRange(fp.textDocument.uri), newText: out }] : null);
        break;
      }
      case "textDocument/codeAction": {
        const ca = p as {
          textDocument: { uri: string };
          context: { diagnostics: { code?: string; message: string; range: LspRange; data?: { fix?: { title: string; edits: { range: LspRange; newText: string }[] } } }[] };
        };
        const actions = [];
        for (const d of ca.context.diagnostics) {
          const fix = d.data?.fix;
          if (!fix?.edits?.length) continue;
          actions.push({
            title: `${fix.title} (${d.code ?? "ruff"})`,
            kind: "quickfix",
            diagnostics: [d],
            edit: { changes: { [ca.textDocument.uri]: fix.edits.map((e) => ({ range: e.range, newText: e.newText })) } },
          });
        }
        respond(id, actions);
        break;
      }
      default:
        if (id !== undefined) fail(id, `unsupported: ${method}`);
    }
  } catch (err) {
    fail(id, err instanceof Error ? err.message : String(err));
  }
}

function fullRange(uri: string): LspRange {
  const text = docs.get(uri)?.text ?? "";
  const lines = text.split("\n");
  const last = lines.length - 1;
  return { start: { line: 0, character: 0 }, end: { line: last, character: lines[last].length } };
}

// ---------- diagnostics ----------

function scheduleDiagnostics(uri: string) {
  window.clearTimeout(diagTimers.get(uri));
  diagTimers.set(
    uri,
    window.setTimeout(() => void runDiagnostics(uri), 350),
  );
}

async function runDiagnostics(uri: string) {
  const doc = docs.get(uri);
  if (!doc) return;
  const s = loadSettings();
  if (!s.ruffEnabled) {
    publish(uri, []);
    return;
  }
  if (!uri.endsWith(".py") && !uri.endsWith(".pyi")) return;
  let diags: RuffDiagnostic[] = [];
  try {
    diags = await ruffCheck(doc.text);
  } catch {
    return;
  }
  const out: Problem[] = diags.map((d) => ({
    uri,
    severity: ({ error: 1, warning: 2, info: 3, hint: 4 } as const)[ruffSeverity(d.code)],
    code: d.code ?? "ruff",
    message: d.message + (d.fix?.message ? ` — fix: ${d.fix.message}` : ""),
    range: {
      start: lspPos(d.start_location.row, d.start_location.column),
      end: lspPos(d.end_location.row, d.end_location.column),
    },
    fix: d.fix
      ? {
        title: d.fix.message ?? `Apply Ruff fix (${d.code ?? ""})`,
        edits: d.fix.edits.map((e) => ({
          range: {
            start: lspPos(e.location.row, e.location.column),
            end: lspPos(e.end_location.row, e.end_location.column),
          },
          newText: e.content ?? "",
        })),
      }
      : undefined,
  }));
  publish(uri, out);
}

function publish(uri: string, list: Problem[]) {
  const doc = docs.get(uri);
  // Clamp to the current document: stale diagnostics (from an older, longer
  // revision) must never produce out-of-range positions.
  const lines = (doc?.text ?? "").split("\n");
  const safe = list.map((d) => {
    const clamp = (p: LspPos): LspPos => {
      const line = Math.max(0, Math.min(p.line, lines.length - 1));
      const ch = Math.max(0, Math.min(p.character, lines[line].length));
      return { line, character: ch };
    };
    return { ...d, range: { start: clamp(d.range.start), end: clamp(d.range.end) } };
  });
  problems.set(uri, safe);
  try {
    transport.emit({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri,
        version: doc?.version,
        diagnostics: safe.map((d) => ({
          range: d.range,
          severity: d.severity,
          code: d.code,
          source: "ruff",
          message: d.message,
          data: d.fix ? { fix: d.fix } : undefined,
        })),
      },
    });
  } catch (err) {
    console.error("publishDiagnostics failed:", err);
  }
  shellRef.refreshBadges();
}

// ---------- problems panel ----------

function renderProblems(host: HTMLElement) {
  host.innerHTML = "";
  const draw = () => {
    host.innerHTML = "";
    const all = [...problems.entries()].flatMap(([uri, list]) => list.map((d) => ({ ...d, uri })));
    if (!all.length) {
      host.innerHTML = `<div class="empty-note">No problems. Spicy and clean. 🌶️</div>`;
      return;
    }
    const box = document.createElement("div");
    box.className = "prob-list";
    const sevName = (s: number) => (s === 1 ? "error" : s === 2 ? "warning" : s === 3 ? "info" : "hint");
    for (const d of all) {
      const row = document.createElement("div");
      row.className = "prob-row";
      row.innerHTML = `<span class="sev ${sevName(d.severity)}"></span><span class="msg"></span><span class="loc"></span>`;
      (row.querySelector(".sev") as HTMLElement).textContent = sevName(d.severity);
      const msg = row.querySelector(".msg") as HTMLElement;
      msg.textContent = `${d.code}: ${d.message}`;
      msg.title = `${pathFor(d.uri)}:${d.range.start.line + 1}`;
      (row.querySelector(".loc") as HTMLElement).textContent =
        `${pathFor(d.uri).split("/").pop()}:${d.range.start.line + 1}:${d.range.start.character + 1}`;
      row.onclick = () => openFile(pathFor(d.uri), d.range.start.line + 1, d.range.start.character);
      box.appendChild(row);
    }
    host.appendChild(box);
  };
  draw();
  return undefined;
}

function problemCounts(): { total: number; err: number; warn: number } {
  let total = 0;
  let err = 0;
  let warn = 0;
  for (const list of problems.values()) {
    for (const d of list) {
      total++;
      if (d.severity === 1) err++;
      else if (d.severity === 2) warn++;
    }
  }
  return { total, err, warn };
}

// ---------- init ----------

export async function initLsp(sh: Shell): Promise<void> {
  shellRef = sh;
  transport = new BridgeTransport();
  // Jedi calls can take a while on first use (Pyodide boot + jedi download);
  // the default 3s client timeout would spuriously fail them.
  client = new LSPClient({ extensions: languageServerExtensions(), timeout: 120000 });
  client.connect(transport);

  // Cross-file navigation: open the target file in a tab.
  const ws = client.workspace as unknown as {
    displayFile: (uri: string) => Promise<unknown>;
    requestFile: (uri: string) => Promise<unknown>;
    getFile: (uri: string) => unknown;
  };
  const ensureOpen = async (uri: string) => {
    await openFile(pathFor(uri)).catch(() => undefined);
    return ws.getFile(uri);
  };
  ws.displayFile = async (uri: string) => {
    const direct = ws.getFile(uri);
    if (direct) {
      const view = (direct as { getView?: () => unknown }).getView?.();
      if (view) return view;
    }
    await ensureOpen(uri);
    const file = ws.getFile(uri);
    return (file as { getView?: () => unknown } | null)?.getView?.() ?? null;
  };
  ws.requestFile = async (uri: string) => ws.getFile(uri) ?? ensureOpen(uri);

  setLspExtensionProvider((path) =>
    path.endsWith(".py") || path.endsWith(".pyi") ? [client.plugin(uriFor(path), "python")] : [],
  );

  sh.registerPanel({
    id: "problems", title: "Problems", order: 2,
    badge: () => {
      const c = problemCounts();
      if (!c.total) return null;
      return { text: String(c.total), kind: c.err ? "err" : "warn" };
    },
    render: renderProblems,
  });

  sh.setStatus({
    id: "problems", side: "left", order: 30,
    text: () => {
      const c = problemCounts();
      return c.total ? `${c.err} errors, ${c.warn} warnings` : "No problems";
    },
    tooltip: () => "Problems (Ruff). Click to open.",
    cls: () => {
      const c = problemCounts();
      return c.err ? "err" : c.warn ? "warn" : "ok";
    },
    onClick: () => sh.setPanel("problems"),
  });

  // Editor hooks: format (palette + save) and outline.
  editorHooks.format = async (path) => {
    const text = getTabText(path);
    if (text == null) return false;
    const out = await ruffFormat(text);
    if (!out || out === text) return false;
    return replaceDocText(path, out);
  };
  editorHooks.documentSymbols = async (path) => {
    const text = getTabText(path) ?? "";
    return outlineSymbols(uriFor(path), text).map((s) => ({
      name: s.name,
      kind: s.kind === 5 ? "class" : "function",
      line: s.location.range.start.line + 1,
    }));
  };
  beforeSaveHooks.push(async (path) => {
    const s = loadSettings();
    if (!s.formatOnSave || !s.ruffEnabled) return;
    if (!path.endsWith(".py")) return;
    await editorHooks.format(path);
  });

  // Re-sync saved files into the worker FS for Jedi; re-lint on external change.
  onWorkspaceChange((e) => {
    if (e.kind === "write" && e.path?.endsWith(".py")) {
      void syncWorkspaceToWorker([e.path]);
    }
    if (e.kind === "reset") wsSynced = false;
  });

  registerCommands([
    {
      id: "editor.format", title: "Format document", category: "Editor", icon: "zap", keybinding: "Shift+Alt+F",
      run: async () => {
        const { getActivePath } = await import("../editor/manager");
        const p = getActivePath();
        if (!p) return;
        if (!(await editorHooks.format(p))) notify.info("Already formatted.");
      },
    },
    {
      id: "lsp.restart", title: "Restart language server", category: "Pyttig",
      run: async () => {
        docs.clear();
        problems.clear();
        wsSynced = false;
        client.disconnect();
        client.connect(transport);
        notify.success("Language server restarted.");
      },
    },
  ]);
}
