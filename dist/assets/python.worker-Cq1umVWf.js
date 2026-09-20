var L=`"""Pyttig Jedi language service.

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
`;const O="314.0.7",R=e=>`https://cdn.jsdelivr.net/pyodide/v${e}/full/`;function A(e=O){return`${R(e)}pyodide.mjs`}let t=null,k=null,v=!1,y=-1,E=[],m=null,p="",x="";const c=(e,n)=>self.postMessage(e,n);function g(){p&&(c({event:"stdout",runId:y,data:p}),p=""),x&&(c({event:"stderr",runId:y,data:x}),x="")}function F(e){p+=e+`
`,p.length>4096&&g()}function j(e){x+=e+`
`,x.length>4096&&g()}function b(e){p+=`\x1B[90m${e}\x1B[0m
`,p.length>4096&&g()}let P=Promise.resolve();function u(e){const n=P.then(e,e);return P=n.catch(()=>{}),n}async function J(e){let n="",r=null;try{const s={batched:a=>F(a)},o={batched:a=>j(a)};t.setStdout({batched:a=>{n+=a+`
`}}),t.setStderr({batched:a=>{n+=a+`
`}}),r=()=>{t.setStdout(s),t.setStderr(o)},await t.runPythonAsync(e)}finally{r?.()}for(const s of n.split(`
`))s.trim()&&b(s)}function B(){let e=[];const n=r=>{const s=new TextEncoder().encode(r+`
`);p+=r+`
`;for(const o of s)e.push(o)};return()=>{for(;;){if(e.length)return e.shift();if(E.length){n(E.shift());continue}if(m){c({event:"input-request",runId:y}),Atomics.store(m.meta,0,0),Atomics.wait(m.meta,0,0);const r=Atomics.load(m.meta,1);if(r>0){const s=m.buf.slice(0,r),o=new TextDecoder().decode(s).replace(/\r?\n$/,"");g(),n(o);continue}return null}return null}}}async function C(e){t=await(await import(e.moduleURL||A(O))).loadPyodide({indexURL:e.indexURL,stdout:o=>{p+=o+`
`},stderr:o=>{x+=o+`
`}}),t.setStdout({batched:o=>F(o)}),t.setStderr({batched:o=>j(o)}),t.setStdin({stdin:B(),isatty:!1,error:!1}),e.isolated&&e.interruptBuffer&&t.setInterruptBuffer(new Uint8Array(e.interruptBuffer)),e.isolated&&e.stdinBuffer&&e.stdinMeta&&(m={buf:new Uint8Array(e.stdinBuffer),meta:new Int32Array(e.stdinMeta)});try{await u(()=>t.loadPackage("pyodide-http",{messageCallback:()=>{},errorCallback:()=>{}})),await t.runPythonAsync(`import pyodide_http
pyodide_http.patch_all()`)}catch{}try{await t.runPythonAsync(`import matplotlib
matplotlib.use('Agg')`)}catch{}return{version:await t.runPythonAsync(`import sys
sys.version.split()[0]`),isolated:e.isolated,sabStdin:!!m}}function T(e){const n=new Map;if(!t)return n;const r=t.FS,s=o=>{let a;try{a=r.readdir(o).filter(h=>h!=="."&&h!=="..")}catch{return}for(const h of a){const f=`${o}/${h}`;try{const _=r.stat(f);r.isDir(_.mode)?s(f):n.set(f,`${_.size}:${Number(_.mtime)}`)}catch{}}};return s(e),n}async function I(e){if(!t)throw new Error("Python runtime is not ready yet");y=e.runId,E=[...e.stdinLines];const n="/home/pyodide/workspace";t.FS.mkdirTree(n);for(const i of e.files){const d=`${n}/${i.path}`,l=d.split("/").slice(0,-1).join("/");t.FS.mkdirTree(l),t.FS.writeFile(d,i.content)}const r=T(n);let s=0;const o=i=>{s++,b(String(i))};try{await u(()=>t.loadPackagesFromImports(e.code,{messageCallback:o,errorCallback:o}))}catch{}s&&(p+=`
`);try{await t.runPythonAsync(`import sys, os
os.chdir('/home/pyodide/workspace')`);const i=`import sys as __pyttig_sys
__pyttig_sys.argv = [${[e.filename,...e.args].map(l=>JSON.stringify(l)).join(", ")}]`;if(await t.runPythonAsync(i),!e.keepNs||!k){try{k?.destroy?.()}catch{}k=t.globals.get("dict")()}(await t.runPythonAsync(e.code,{filename:e.filename,globals:k}))?.destroy?.()}catch(i){g();const l=(i instanceof Error?i.message:String(i)).replace(/^PythonError:\s*/,"");c({event:"stderr",runId:y,data:l+(l.endsWith(`
`)?"":`
`)});const w=/ModuleNotFoundError: No module named '([^']+)'/.exec(l)?.[1];w&&c({event:"missing-module",runId:y,name:w.split(".")[0]})}finally{g()}const a=[];try{await t.runPythonAsync(`
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
`);const i=t.runPython("__pyttig_plots").toJs();for(const d of i){const l=t.FS.readFile(d);a.push({name:d.split("/").pop()??"figure.png",png:l.buffer})}}catch{}const h=T(n),f=[];let _=0;for(const[i,d]of h){if(r.get(i)===d)continue;const l=i.slice(n.length+1);try{if(t.FS.stat(i).size>5*1024*1024)continue;if(_>10*1024*1024)break;const S=t.FS.readFile(i);_+=S.length,f.push({path:l,content:S.buffer})}catch{}}const N=a.map(i=>i.png).concat(f.map(i=>i.content));c({id:e.id,ok:!0,result:{plots:a,changed:f},runId:y,type:"run-done"},N)}async function $(){if(!v){if(!t)throw new Error("Python runtime is not ready yet");await u(()=>t.loadPackage(["jedi","parso"],{messageCallback:()=>{},errorCallback:()=>{}})),await t.runPythonAsync(L+`
__pyttig_lsp_ready = True`),await t.runPythonAsync("handle('init', {})"),v=!0}}async function q(e){await $();const n=JSON.stringify(e.params);t.globals.set("__pyttig_params",n);const r=await t.runPythonAsync(`import json as __json
__r = handle(${JSON.stringify(e.op)}, __json.loads(__pyttig_params))
__r`);let s;try{s=r?.toJs?.({dict_converter:Object.fromEntries})??r}finally{r?.destroy?.()}return s}async function U(e){if(!t)throw new Error("Python runtime is not ready yet");const n=[];try{const o=t.runPython("list(__import__('sys').modules)").toJs();for(const a of e)o.includes(a)||n.push(a)}catch{n.push(...e)}if(n.length)try{return await u(()=>t.loadPackage(n,{messageCallback:o=>b(String(o)),errorCallback:o=>b(String(o))})),{installed:n,failed:[]}}catch{}const r=[],s=[];await u(()=>t.loadPackage("micropip",{messageCallback:()=>{},errorCallback:()=>{}}));for(const o of n){c({event:"pkg-status",name:o,state:"installing"});try{await u(()=>J(`import micropip
await micropip.install(${JSON.stringify(o)})`)),r.push(o),c({event:"pkg-status",name:o,state:"done"})}catch(a){s.push(o),c({event:"pkg-status",name:o,state:"error",error:String(a)})}}return{installed:r,failed:s}}self.onmessage=async e=>{const n=e.data;try{switch(n.type){case"init":{const r=await C(n);c({id:n.id,ok:!0,result:r});break}case"run":{await I(n);break}case"lsp":{const r=await q(n);c({id:n.id,ok:!0,result:r});break}case"ensure-packages":{const r=await U(n.names);c({id:n.id,ok:!0,result:r});break}case"list-packages":{await u(()=>t.loadPackage("micropip",{messageCallback:()=>{},errorCallback:()=>{}}));const r=await t.runPythonAsync(`import micropip, json
json.dumps([{k: {'name': v.name, 'version': v.version, 'source': str(getattr(v, 'source', ''))}} for k, v in micropip.list().items()])`);c({id:n.id,ok:!0,result:JSON.parse(r)});break}case"uninstall":{await u(()=>t.loadPackage("micropip",{messageCallback:()=>{},errorCallback:()=>{}})),await t.runPythonAsync(`import micropip
micropip.uninstall(${JSON.stringify(n.names)})`),c({id:n.id,ok:!0,result:{removed:n.names}});break}case"reset":{try{k?.destroy?.()}catch{}k=null,c({id:n.id,ok:!0,result:{}});break}case"sync-files":{const r="/home/pyodide/workspace";t.FS.mkdirTree(r);for(const s of n.files)try{const o=`${r}/${s.path}`;t.FS.mkdirTree(o.split("/").slice(0,-1).join("/")),t.FS.writeFile(o,s.content)}catch{}c({id:n.id,ok:!0,result:{files:n.files.length}});break}case"memory":{let r=0;try{r=t?._module?.HEAPU8?.length??0}catch{}c({id:n.id,ok:!0,result:{wasm:r,loaded:!!t}});break}case"ping":{c({id:n.id,ok:!!t});break}}}catch(r){g(),c({id:n.id??-1,ok:!1,error:r instanceof Error?r.message:String(r)})}};
