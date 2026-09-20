var A=`"""Pyttig Jedi language service.

Runs inside the Pyodide worker. Exposes completion, hover, signature help,
go-to-definition, references, rename, document symbols and syntax checking
over plain dicts (JSON-serializable) so the JS side can speak LSP.

Conventions: lines are 1-based, columns are 0-based (Jedi style).
The JS bridge converts to/from LSP positions.
"""

import sys
import traceback

try:
    import jedi
except ImportError:  # pragma: no cover
    jedi = None

_PROJECT = None
_ROOT = "/home/pyodide/workspace"


def _truncate(text, limit=1200):
    if not text:
        return ""
    text = str(text)
    return text if len(text) <= limit else text[:limit] + "\\n…"


def init(root=None):
    """Create a Jedi project rooted at the mirrored workspace."""
    global _PROJECT, _ROOT
    if root:
        _ROOT = root
    if jedi is None:
        return {"ok": False, "error": "jedi not installed"}
    try:
        if _ROOT not in sys.path:
            sys.path.insert(0, _ROOT)
        _PROJECT = jedi.Project(_ROOT, sys_path=[_ROOT] + sys.path)
        return {"ok": True, "jedi": jedi.__version__}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def _script(code, path):
    if jedi is None or _PROJECT is None:
        raise RuntimeError("jedi not ready")
    return jedi.Script(code=code, path=path, project=_PROJECT)


def complete(code, path, line, column):
    try:
        script = _script(code, path)
        out = []
        for c in script.complete(line, column):
            try:
                sigs = c.get_signatures()
                sig = sigs[0].to_string() if sigs else ""
            except Exception:  # noqa: BLE001
                sig = ""
            out.append(
                {
                    "name": c.name,
                    "type": c.type,
                    "doc": _truncate(c.docstring()),
                    "signature": sig,
                }
            )
            if len(out) >= 100:
                break
        return {"ok": True, "items": out}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def hover(code, path, line, column):
    try:
        script = _script(code, path)
        helps = script.help(line, column)
        if not helps:
            inferred = script.infer(line, column)
            helps = inferred
        if not helps:
            return {"ok": True, "value": None}
        h = helps[0]
        try:
            sigs = h.get_signatures()
            sig = sigs[0].to_string() if sigs else ""
        except Exception:  # noqa: BLE001
            sig = ""
        name = getattr(h, "full_name", None) or h.name
        md = "\`\`\`python\\n%s\\n%s\\n\`\`\`\\n%s" % (h.name, sig, _truncate(h.docstring()))
        return {"ok": True, "value": {"name": name, "markdown": md}}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def signature(code, path, line, column):
    try:
        script = _script(code, path)
        sigs = script.get_signatures(line, column)
        out = []
        for s in sigs:
            params = []
            try:
                for p in s.params:
                    params.append(p.to_string())
            except Exception:  # noqa: BLE001
                pass
            out.append(
                {
                    "label": s.to_string(),
                    "doc": _truncate(s.docstring()),
                    "params": params,
                    "index": getattr(s, "index", 0) or 0,
                }
            )
        return {"ok": True, "signatures": out}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def _loc(d):
    path = str(d.module_path) if getattr(d, "module_path", None) else None
    return {
        "path": path,
        "line": d.line,
        "column": d.column,
        "name": d.name,
        "type": getattr(d, "type", ""),
    }


def goto(code, path, line, column):
    try:
        script = _script(code, path)
        targets = script.goto(line, column, follow_imports=True)
        if not targets:
            targets = script.infer(line, column)
        return {"ok": True, "targets": [_loc(t) for t in targets if t.module_path]}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def references(code, path, line, column):
    try:
        script = _script(code, path)
        refs = script.get_references(line, column, include_builtins=False)
        return {"ok": True, "targets": [_loc(r) for r in refs if r.module_path]}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def rename(code, path, line, column, new_name):
    try:
        script = _script(code, path)
        refactoring = script.rename(line, column, new_name=new_name)
        changed = {}
        for fpath, changed_file in refactoring.get_changed_files().items():
            changed[str(fpath)] = changed_file.get_new_code()
        return {"ok": True, "changed": changed}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def symbols(code, path):
    try:
        script = _script(code, path)
        names = script.get_names(all_scopes=True, definitions=True)
        out = []
        for n in names:
            if n.type in ("function", "class"):
                out.append({"name": (n.full_name or n.name).split(".")[-1], "kind": n.type, "line": n.line})
        return {"ok": True, "symbols": out}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def syntax_check(code, path):
    try:
        compile(code, path, "exec")
        return {"ok": True, "errors": []}
    except SyntaxError as exc:
        return {
            "ok": True,
            "errors": [
                {
                    "message": "%s: %s" % (type(exc).__name__, exc.msg),
                    "line": exc.lineno or 1,
                    "column": (exc.offset or 1) - 1,
                    "end_column": (exc.end_offset or exc.offset or 1) - 1,
                }
            ],
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": True, "errors": [{"message": str(exc), "line": 1, "column": 0}]}


_HANDLERS = {
    "init": init,
    "complete": complete,
    "hover": hover,
    "signature": signature,
    "goto": goto,
    "references": references,
    "rename": rename,
    "symbols": symbols,
    "syntax_check": syntax_check,
}


def handle(op, params):
    """Entry point called from JS. Always returns a JSON-serializable dict."""
    fn = _HANDLERS.get(op)
    if fn is None:
        return {"ok": False, "error": "unknown op: %s" % op}
    try:
        return fn(**(params or {}))
    except Exception:  # noqa: BLE001
        return {"ok": False, "error": traceback.format_exc(limit=3)}
`;const j="314.0.7",B=e=>`https://cdn.jsdelivr.net/pyodide/v${e}/full/`;function C(e=j){return`${B(e)}pyodide.mjs`}function $(e){const n=[],o=e.split(/\r?\n/).map(s=>{const a=/^\s*[!%]\s*pip\s+install\s+(.+?)\s*$/.exec(s);if(!a)return s;for(const l of a[1].split(/\s+/))!l||l.startsWith("-")||n.push(l);return`# ${s.trim()}`});return{packages:[...new Set(n)],code:o.join(`
`)}}let t=null,k=null,v=!1,g=-1,E=[],y=null,d="",x="";const c=(e,n)=>self.postMessage(e,n);function _(){d&&(c({event:"stdout",runId:g,data:d}),d=""),x&&(c({event:"stderr",runId:g,data:x}),x="")}function F(e){d+=e+`
`,d.length>4096&&_()}function N(e){x+=e+`
`,x.length>4096&&_()}function h(e){d+=`\x1B[90m${e}\x1B[0m
`,d.length>4096&&_()}let T=Promise.resolve();function f(e){const n=T.then(e,e);return T=n.catch(()=>{}),n}async function L(){if(!t)throw new Error("Python runtime is not ready yet");await f(()=>t.loadPackage("micropip",{messageCallback:()=>{},errorCallback:()=>{}}))}async function J(e){let n="",r=null;try{const o={batched:a=>F(a)},s={batched:a=>N(a)};t.setStdout({batched:a=>{n+=a+`
`}}),t.setStderr({batched:a=>{n+=a+`
`}}),r=()=>{t.setStdout(o),t.setStderr(s)},await t.runPythonAsync(e)}finally{r?.()}for(const o of n.split(`
`))o.trim()&&h(o)}function I(){let e=[];const n=r=>{const o=new TextEncoder().encode(r+`
`);d+=r+`
`;for(const s of o)e.push(s)};return()=>{for(;;){if(e.length)return e.shift();if(E.length){n(E.shift());continue}if(y){c({event:"input-request",runId:g}),Atomics.store(y.meta,0,0),Atomics.wait(y.meta,0,0);const r=Atomics.load(y.meta,1);if(r>0){const o=y.buf.slice(0,r),s=new TextDecoder().decode(o).replace(/\r?\n$/,"");_(),n(s);continue}return null}return null}}}async function q(e){t=await(await import(e.moduleURL||C(j))).loadPyodide({indexURL:e.indexURL,stdout:s=>{d+=s+`
`},stderr:s=>{x+=s+`
`}}),t.setStdout({batched:s=>F(s)}),t.setStderr({batched:s=>N(s)}),t.setStdin({stdin:I(),isatty:!1,error:!1}),e.isolated&&e.interruptBuffer&&t.setInterruptBuffer(new Uint8Array(e.interruptBuffer)),e.isolated&&e.stdinBuffer&&e.stdinMeta&&(y={buf:new Uint8Array(e.stdinBuffer),meta:new Int32Array(e.stdinMeta)});try{await f(()=>t.loadPackage("pyodide-http",{messageCallback:()=>{},errorCallback:()=>{}})),await t.runPythonAsync(`import pyodide_http
pyodide_http.patch_all()`)}catch{}try{await t.runPythonAsync(`import matplotlib
matplotlib.use('Agg')`)}catch{}return{version:await t.runPythonAsync(`import sys
sys.version.split()[0]`),isolated:e.isolated,sabStdin:!!y}}function O(e){const n=new Map;if(!t)return n;const r=t.FS,o=s=>{let a;try{a=r.readdir(s).filter(l=>l!=="."&&l!=="..")}catch{return}for(const l of a){const b=`${s}/${l}`;try{const m=r.stat(b);r.isDir(m.mode)?o(b):n.set(b,`${m.size}:${Number(m.mtime)}`)}catch{}}};return o(e),n}async function U(e){if(!t)throw new Error("Python runtime is not ready yet");g=e.runId,E=[...e.stdinLines];const n="/home/pyodide/workspace";t.FS.mkdirTree(n);for(const i of e.files){const u=`${n}/${i.path}`,p=u.split("/").slice(0,-1).join("/");t.FS.mkdirTree(p),t.FS.writeFile(u,i.content)}const r=O(n),o=$(e.code);if(o.packages.length){h(`pip install ${o.packages.join(" ")}`);try{await L(),await f(()=>J(`import micropip as __pyttig_micropip
await __pyttig_micropip.install(${JSON.stringify(o.packages)})`)),h("ok")}catch(i){h(`pip install failed: ${i instanceof Error?i.message:i}`)}d+=`
`}let s=0;const a=i=>{s++,h(String(i))};try{await f(()=>t.loadPackagesFromImports(o.code,{messageCallback:a,errorCallback:a}))}catch{}s&&(d+=`
`);try{await t.runPythonAsync(`import sys, os
os.chdir('/home/pyodide/workspace')`);const i=`import sys as __pyttig_sys
__pyttig_sys.argv = [${[e.filename,...e.args].map(p=>JSON.stringify(p)).join(", ")}]`;if(await t.runPythonAsync(i),!e.keepNs||!k){try{k?.destroy?.()}catch{}k=t.globals.get("dict")()}(await t.runPythonAsync(o.code,{filename:e.filename,globals:k}))?.destroy?.()}catch(i){_();const p=(i instanceof Error?i.message:String(i)).replace(/^PythonError:\s*/,"");c({event:"stderr",runId:g,data:p+(p.endsWith(`
`)?"":`
`)});const w=/ModuleNotFoundError: No module named '([^']+)'/.exec(p)?.[1];w&&c({event:"missing-module",runId:g,name:w.split(".")[0]})}finally{_()}const l=[];try{await t.runPythonAsync(`
import io, os
__pyttig_plots = []
try:
    import matplotlib.pyplot as plt
    os.makedirs('/tmp/pyttig_plots', exist_ok=True)
    for __n in plt.get_fignums():
        __fig = plt.figure(__n)
        __p = '/tmp/pyttig_plots/fig-%d.png' % __n
        __fig.savefig(__p, format='png', dpi=110, bbox_inches='tight')
        __pyttig_plots.append(__p)
    plt.close('all')
except Exception:
    pass
`);const i=t.runPython("__pyttig_plots").toJs();for(const u of i){const p=t.FS.readFile(u);l.push({name:u.split("/").pop()??"figure.png",png:p.buffer})}}catch{}const b=O(n),m=[];let S=0;for(const[i,u]of b){if(r.get(i)===u)continue;const p=i.slice(n.length+1);try{if(t.FS.stat(i).size>5*1024*1024)continue;if(S>10*1024*1024)break;const P=t.FS.readFile(i);S+=P.length,m.push({path:p,content:P.buffer})}catch{}}const R=l.map(i=>i.png).concat(m.map(i=>i.content));c({id:e.id,ok:!0,result:{plots:l,changed:m},runId:g,type:"run-done"},R)}async function D(){if(!v){if(!t)throw new Error("Python runtime is not ready yet");await f(()=>t.loadPackage(["jedi","parso"],{messageCallback:()=>{},errorCallback:()=>{}})),await t.runPythonAsync(A+`
__pyttig_lsp_ready = True`),await t.runPythonAsync("handle('init', {})"),v=!0}}async function M(e){await D();const n=JSON.stringify(e.params);t.globals.set("__pyttig_params",n);const r=await t.runPythonAsync(`import json as __json
__r = handle(${JSON.stringify(e.op)}, __json.loads(__pyttig_params))
__r`);let o;try{o=r?.toJs?.({dict_converter:Object.fromEntries})??r}finally{r?.destroy?.()}return o}async function z(e){if(!t)throw new Error("Python runtime is not ready yet");const n=[];try{const s=t.runPython("list(__import__('sys').modules)").toJs();for(const a of e)s.includes(a)||n.push(a)}catch{n.push(...e)}if(n.length)try{return await f(()=>t.loadPackage(n,{messageCallback:s=>h(String(s)),errorCallback:s=>h(String(s))})),{installed:n,failed:[]}}catch{}const r=[],o=[];await L();for(const s of n){c({event:"pkg-status",name:s,state:"installing"});try{await f(()=>J(`import micropip
await micropip.install(${JSON.stringify(s)})`)),r.push(s),c({event:"pkg-status",name:s,state:"done"})}catch(a){o.push(s),c({event:"pkg-status",name:s,state:"error",error:String(a)})}}return{installed:r,failed:o}}self.onmessage=async e=>{const n=e.data;try{switch(n.type){case"init":{const r=await q(n);c({id:n.id,ok:!0,result:r});break}case"run":{await U(n);break}case"lsp":{const r=await M(n);c({id:n.id,ok:!0,result:r});break}case"ensure-packages":{const r=await z(n.names);c({id:n.id,ok:!0,result:r});break}case"list-packages":{await f(()=>t.loadPackage("micropip",{messageCallback:()=>{},errorCallback:()=>{}}));const r=await t.runPythonAsync(`import micropip, json
json.dumps([{k: {'name': v.name, 'version': v.version, 'source': str(getattr(v, 'source', ''))}} for k, v in micropip.list().items()])`);c({id:n.id,ok:!0,result:JSON.parse(r)});break}case"uninstall":{await f(()=>t.loadPackage("micropip",{messageCallback:()=>{},errorCallback:()=>{}})),await t.runPythonAsync(`import micropip
micropip.uninstall(${JSON.stringify(n.names)})`),c({id:n.id,ok:!0,result:{removed:n.names}});break}case"reset":{try{k?.destroy?.()}catch{}k=null,c({id:n.id,ok:!0,result:{}});break}case"sync-files":{const r="/home/pyodide/workspace";t.FS.mkdirTree(r);for(const o of n.files)try{const s=`${r}/${o.path}`;t.FS.mkdirTree(s.split("/").slice(0,-1).join("/")),t.FS.writeFile(s,o.content)}catch{}c({id:n.id,ok:!0,result:{files:n.files.length}});break}case"memory":{let r=0;try{r=t?._module?.HEAPU8?.length??0}catch{}c({id:n.id,ok:!0,result:{wasm:r,loaded:!!t}});break}case"ping":{c({id:n.id,ok:!!t});break}}}catch(r){_(),c({id:n.id??-1,ok:!1,error:r instanceof Error?r.message:String(r)})}};
