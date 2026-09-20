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
`,J=`"""Build a wheel from a pure-Python sdist, inside the browser.

There is no pip and no compiler here, but most sdists of pure-Python packages
can be built in-process: download the tarball from PyPI, install the declared
PEP 517 build backend (setuptools / hatchling / flit_core / poetry-core are all
pure Python), then call its build_wheel() directly instead of spawning the
usual subprocess. Anything that needs to compile C/Rust fails, which is
correct and reported as such.
"""

import importlib
import os
import shutil
import tarfile
import tempfile
import tomllib
import zipfile

from pyodide.http import pyfetch

PYPI = "https://pypi.org/pypi/{name}/json"


async def _fetch_bytes(url: str) -> bytes:
    resp = await pyfetch(url)
    if resp.status != 200:
        raise RuntimeError(f"download failed ({resp.status}) for {url}")
    return await resp.bytes()


def _extract(archive: str, dest: str) -> None:
    if archive.endswith(".zip"):
        with zipfile.ZipFile(archive) as zf:
            for info in zf.infolist():
                name = info.filename.replace("\\\\", "/")
                if name.startswith("/") or ".." in name.split("/"):
                    continue
                zf.extract(info, dest)
    else:
        with tarfile.open(archive) as tf:
            tf.extractall(dest, filter="data")


def _source_root(dest: str) -> str:
    entries = [os.path.join(dest, e) for e in os.listdir(dest)]
    dirs = [e for e in entries if os.path.isdir(e) and not e.endswith(".egg-info")]
    if len(dirs) == 1 and not any(os.path.isfile(e) for e in entries):
        return dirs[0]
    return dest


async def build_wheel_from_sdist(name: str, out_dir: str) -> str:
    """Return the path of a wheel built from the latest sdist of \`name\`."""
    import micropip

    resp = await pyfetch(PYPI.format(name=name))
    if resp.status != 200:
        raise RuntimeError(f"{name} is not on PyPI")
    data = await resp.json()
    sdists = [u for u in data.get("urls", []) if u.get("packagetype") == "sdist"]
    if not sdists:
        raise RuntimeError(f"{name} has no source distribution on PyPI")
    sdist = sdists[-1]

    work = tempfile.mkdtemp(prefix="pyttig-sdist-")
    archive = os.path.join(work, sdist["filename"])
    with open(archive, "wb") as fh:
        fh.write(await _fetch_bytes(sdist["url"]))

    src = os.path.join(work, "src")
    os.makedirs(src, exist_ok=True)
    _extract(archive, src)
    root = _source_root(src)

    requires = ["setuptools>=61", "wheel"]
    backend = "setuptools.build_meta:__legacy__"
    pyproject = os.path.join(root, "pyproject.toml")
    if os.path.exists(pyproject):
        with open(pyproject, "rb") as fh:
            build_system = (tomllib.load(fh).get("build-system") or {})
        requires = build_system.get("requires") or requires
        backend = build_system.get("build-backend") or backend

    try:
        await micropip.install(list(requires))
    except Exception as exc:
        # e.g. "Requested 'packaging>=26.2', but packaging==26.1 is installed":
        # the backend needs a newer build dependency than the runtime ships.
        # Reinstall only that requirement — a blanket reinstall would upgrade
        # shared runtime packages (numpy, setuptools) and break other imports.
        import re

        requested = re.findall(r"Requested '([^']+)'", str(exc))
        if not requested:
            raise
        for req in requested:
            await micropip.install([req], reinstall=True)

    mod_name, _, attr = backend.partition(":")
    backend_obj = importlib.import_module(mod_name)
    if attr:
        # \`setuptools.build_meta:__legacy__\` points at an instance, not a module.
        backend_obj = getattr(backend_obj, attr)
    build = getattr(backend_obj, "build_wheel")

    os.makedirs(out_dir, exist_ok=True)
    cwd = os.getcwd()
    os.chdir(root)
    try:
        wheel_name = build(out_dir)
    finally:
        os.chdir(cwd)
        shutil.rmtree(work, ignore_errors=True)
    return os.path.join(out_dir, wheel_name)


def is_compiler_error(message: str) -> bool:
    """Heuristic: did the build fail because it wanted a C/Rust compiler?"""
    needles = (
        "compiler", "gcc", "clang", "emcc", "cc1plus", "cargo", "maturin",
        "meson", "ninja", "Python.h", "numpy/arrayobject.h", "no such file or directory: 'cc'",
        "unable to execute", "error: command", "Rust", "cython",
    )
    low = message.lower()
    return any(n.lower() in low for n in needles)


def dependencies_of(wheel_path: str) -> list[str]:
    """Top-level dependency names from a built wheel, markers evaluated.

    micropip's resolver can only fetch dependencies from PyPI, so a wheel we
    built here would fail on e.g. aiohttp (which lives in the Pyodide
    distribution). We resolve those names ourselves instead.
    """
    import email
    import zipfile

    with zipfile.ZipFile(wheel_path) as zf:
        meta = next(n for n in zf.namelist() if n.endswith(".dist-info/METADATA"))
        msg = email.message_from_string(zf.read(meta).decode("utf-8", "replace"))

    raw = msg.get_all("Requires-Dist") or []
    names: list[str] = []
    try:
        from packaging.requirements import Requirement

        for value in raw:
            req = Requirement(value)
            if req.marker is not None and not req.marker.evaluate({"extra": ""}):
                continue
            names.append(req.name)
    except ImportError:  # packaging always ships with Pyodide; just in case
        for value in raw:
            head = value.split(";")[0]
            for sep in ("[", "<", ">", "=", "!", "~", " "):
                head = head.split(sep)[0]
            if head:
                names.append(head)
    # Preserve order, drop duplicates.
    seen: set[str] = set()
    out: list[str] = []
    for n in names:
        if n.lower() not in seen:
            seen.add(n.lower())
            out.append(n)
    return out


_patched = False


def _patch_local_wheel_fetch() -> None:
    """Let micropip read \`file://\` wheels from the virtual FS.

    micropip accepts the file: scheme but downloads through the browser fetch,
    which cannot read the Emscripten filesystem. Wheels we just built live
    there, so teach the download step to open them directly.
    """
    global _patched
    if _patched:
        return
    import micropip.wheelinfo as wi

    original = wi.WheelInfo._fetch_bytes

    async def _fetch_bytes(self, url, fetch_kwargs, compat_layer):
        if self.parsed_url.scheme in ("file", "emfs"):
            from urllib.parse import unquote

            with open(unquote(self.parsed_url.path), "rb") as fh:
                return fh.read()
        return await original(self, url, fetch_kwargs, compat_layer)

    wi.WheelInfo._fetch_bytes = _fetch_bytes
    _patched = True


async def install_local_wheel(path: str, deps: bool = True) -> None:
    """Install a wheel file that already exists in the virtual FS."""
    import micropip

    _patch_local_wheel_fetch()
    await micropip.install("file://" + path, deps=deps)


# Wheels built here are always installed from the virtual FS.
_patch_local_wheel_fetch()
`;const L="314.0.7",$=e=>`https://cdn.jsdelivr.net/pyodide/v${e}/full/`;function B(e=L){return`${$(e)}pyodide.mjs`}function z(e){const n=[],s=e.split(/\r?\n/).map(i=>{const l=/^\s*[!%]\s*pip\s+install\s+(.+?)\s*$/.exec(i);if(!l)return i;for(const o of l[1].split(/\s+/))!o||o.startsWith("-")||n.push(o);return`# ${i.trim()}`});return{packages:[...new Set(n)],code:s.join(`
`)}}let t=null,b=null,R=!1,g=-1,j=[],y=null,m="",k="";const d=(e,n)=>self.postMessage(e,n);function _(){m&&(d({event:"stdout",runId:g,data:m}),m=""),k&&(d({event:"stderr",runId:g,data:k}),k="")}function C(e){m+=e+`
`,m.length>4096&&_()}function I(e){k+=e+`
`,k.length>4096&&_()}function h(e){m+=`\x1B[90m${e}\x1B[0m
`,m.length>4096&&_()}let q=Promise.resolve();function w(e){const n=q.then(e,e);return q=n.catch(()=>{}),n}async function E(){if(!t)throw new Error("Python runtime is not ready yet");await w(()=>t.loadPackage("micropip",{messageCallback:()=>{},errorCallback:()=>{}}))}async function v(e){let n="",r=null,s;try{const i={batched:o=>C(o)},l={batched:o=>I(o)};t.setStdout({batched:o=>{n+=o+`
`}}),t.setStderr({batched:o=>{n+=o+`
`}}),r=()=>{t.setStdout(i),t.setStderr(l)},s=await t.runPythonAsync(e)}finally{r?.()}for(const i of n.split(`
`))i.trim()&&h(i);return s}async function O(e,n,r=0){if(!t)throw new Error("Python runtime is not ready yet");try{await w(()=>t.loadPackage([e],{messageCallback:n,errorCallback:n}));return}catch{}try{await w(()=>v(`import micropip
await micropip.install(${JSON.stringify(e)})`));return}catch{}await D(e,n,r)}async function D(e,n,r){if(!t)throw new Error("Python runtime is not ready yet");if(r>4)throw new Error(`dependency chain too deep at ${e}`);const i=["import sys, importlib","if '/tmp' not in sys.path: sys.path.insert(0, '/tmp')","mod = sys.modules.get('pyttig_sdist_build') or importlib.import_module('pyttig_sdist_build')",`await mod.build_wheel_from_sdist(${JSON.stringify(e)}, ${JSON.stringify("/tmp/pyttig-wheels")})`].join(`
`),l=String(await v(i)),o=`file://${l}`,c=String(await v(`import sys, importlib, json
if '/tmp' not in sys.path: sys.path.insert(0, '/tmp')
mod = sys.modules.get('pyttig_sdist_build') or importlib.import_module('pyttig_sdist_build')
json.dumps(mod.dependencies_of(${JSON.stringify(l)}))`));for(const p of JSON.parse(c||"[]"))p.toLowerCase()!==e.toLowerCase()&&(h(`  needs ${p}`),await O(p,n,r+1));await v(`import micropip
await micropip.install(${JSON.stringify(o)}, deps=False)`)}function W(){let e=[];const n=r=>{const s=new TextEncoder().encode(r+`
`);m+=r+`
`;for(const i of s)e.push(i)};return()=>{for(;;){if(e.length)return e.shift();if(j.length){n(j.shift());continue}if(y){d({event:"input-request",runId:g}),Atomics.store(y.meta,0,0),Atomics.wait(y.meta,0,0);const r=Atomics.load(y.meta,1);if(r>0){const s=y.buf.slice(0,r),i=new TextDecoder().decode(s).replace(/\r?\n$/,"");_(),n(i);continue}return null}return null}}}async function U(e){t=await(await import(e.moduleURL||B(L))).loadPyodide({indexURL:e.indexURL,stdout:i=>{m+=i+`
`},stderr:i=>{k+=i+`
`}}),t.setStdout({batched:i=>C(i)}),t.setStderr({batched:i=>I(i)}),t.setStdin({stdin:W(),isatty:!1,error:!1}),t.FS.writeFile("/tmp/pyttig_sdist_build.py",J),e.isolated&&e.interruptBuffer&&t.setInterruptBuffer(new Uint8Array(e.interruptBuffer)),e.isolated&&e.stdinBuffer&&e.stdinMeta&&(y={buf:new Uint8Array(e.stdinBuffer),meta:new Int32Array(e.stdinMeta)});try{await w(()=>t.loadPackage("pyodide-http",{messageCallback:()=>{},errorCallback:()=>{}})),await t.runPythonAsync(`import pyodide_http
pyodide_http.patch_all()`)}catch{}try{await t.runPythonAsync(`import matplotlib
matplotlib.use('Agg')`)}catch{}return{version:await t.runPythonAsync(`import sys
sys.version.split()[0]`),isolated:e.isolated,sabStdin:!!y}}function N(e){const n=new Map;if(!t)return n;const r=t.FS,s=i=>{let l;try{l=r.readdir(i).filter(o=>o!=="."&&o!=="..")}catch{return}for(const o of l){const c=`${i}/${o}`;try{const p=r.stat(c);r.isDir(p.mode)?s(c):n.set(c,`${p.size}:${Number(p.mtime)}`)}catch{}}};return s(e),n}async function M(e){if(!t)throw new Error("Python runtime is not ready yet");await T,g=e.runId,j=[...e.stdinLines];const n="/home/pyodide/workspace";t.FS.mkdirTree(n);for(const a of e.files){const u=`${n}/${a.path}`,f=u.split("/").slice(0,-1).join("/");t.FS.mkdirTree(f),t.FS.writeFile(u,a.content)}const r=N(n),s=z(e.code);if(s.packages.length){h(`pip install ${s.packages.join(" ")}`);try{await E();for(const a of s.packages)await O(a,u=>h(String(u)));h("ok"),d({event:"pkg-installed",names:s.packages})}catch(a){h(`pip install failed: ${a instanceof Error?a.message:a}`)}m+=`
`}let i=0;const l=a=>{i++,h(String(a))};try{await w(()=>t.loadPackagesFromImports(s.code,{messageCallback:l,errorCallback:l}))}catch{}i&&(m+=`
`);try{await t.runPythonAsync(`import sys, os
os.chdir('/home/pyodide/workspace')`);const a=`import sys as __pyttig_sys
__pyttig_sys.argv = [${[e.filename,...e.args].map(f=>JSON.stringify(f)).join(", ")}]`;if(await t.runPythonAsync(a),!e.keepNs||!b){try{b?.destroy?.()}catch{}b=t.globals.get("dict")()}(await t.runPythonAsync(s.code,{filename:e.filename,globals:b}))?.destroy?.()}catch(a){_();const f=(a instanceof Error?a.message:String(a)).replace(/^PythonError:\s*/,"");d({event:"stderr",runId:g,data:f+(f.endsWith(`
`)?"":`
`)});const S=/ModuleNotFoundError: No module named '([^']+)'/.exec(f)?.[1];S&&d({event:"missing-module",runId:g,name:S.split(".")[0]})}finally{_()}const o=[];try{await t.runPythonAsync(`
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
`);const a=t.runPython("__pyttig_plots").toJs();for(const u of a){const f=t.FS.readFile(u);o.push({name:u.split("/").pop()??"figure.png",png:f.buffer})}}catch{}const c=N(n),p=[];let x=0;for(const[a,u]of c){if(r.get(a)===u)continue;const f=a.slice(n.length+1);try{if(t.FS.stat(a).size>5*1024*1024)continue;if(x>10*1024*1024)break;const F=t.FS.readFile(a);x+=F.length,p.push({path:f,content:F.buffer})}catch{}}const P=o.map(a=>a.png).concat(p.map(a=>a.content));d({id:e.id,ok:!0,result:{plots:o,changed:p},runId:g,type:"run-done"},P)}async function H(){if(!R){if(!t)throw new Error("Python runtime is not ready yet");await w(()=>t.loadPackage(["jedi","parso"],{messageCallback:()=>{},errorCallback:()=>{}})),await t.runPythonAsync(A+`
__pyttig_lsp_ready = True`),await t.runPythonAsync("handle('init', {})"),R=!0}}async function Z(e){await H();const n=JSON.stringify(e.params);t.globals.set("__pyttig_params",n);const r=await t.runPythonAsync(`import json as __json
__r = handle(${JSON.stringify(e.op)}, __json.loads(__pyttig_params))
__r`);let s;try{s=r?.toJs?.({dict_converter:Object.fromEntries})??r}finally{r?.destroy?.()}return s}async function Y(e,n=!1){if(!t)throw new Error("Python runtime is not ready yet");const r=n?()=>{}:c=>h(String(c)),s=[];try{const c=t.runPython("list(__import__('sys').modules)").toJs();for(const p of e)c.includes(p)||s.push(p)}catch{s.push(...e)}if(s.length)try{return await w(()=>t.loadPackage(s,{messageCallback:r,errorCallback:r})),{installed:s,failed:[],errors:{}}}catch{}const i=[],l=[],o={};await E();for(const c of s){d({event:"pkg-status",name:c,state:"installing"});try{await O(c,r),i.push(c),d({event:"pkg-status",name:c,state:"done"})}catch(p){const x=p instanceof Error?p.message:String(p);l.push(c),o[c]=G(x);for(const P of x.split(`
`).slice(-5))P.trim()&&h(P);d({event:"pkg-status",name:c,state:"error",error:o[c]})}}return{installed:i,failed:l,errors:o}}function G(e){const n=e.replace(/\s+/g," ").trim();if(/C compiler|clang|emcc|cc1plus|gcc|cargo|maturin|meson|ninja|Python\.h|arrayobject\.h|unable to execute|no such file or directory: 'cc'/i.test(n))return"needs compiled code and has no browser build";const s=[...e.split(`
`).map(o=>o.trim()).filter(Boolean)].reverse(),l=s.find(o=>/^[A-Za-z_][\w.]*(Error|Exception): /.test(o))??s.find(o=>/^[A-Za-z_][\w.]*: /.test(o)&&!/^See: /.test(o))??n;return/Couldn't find a pure Python 3 wheel|No wheel|not found in PyPI/i.test(l)?"no wheel for the browser — it would need compiling C code, which browsers can't do":/no source distribution|is not on PyPI/i.test(l)?"not available for the browser (no wheel, no source package on PyPI)":/Failed to fetch|NetworkError|Load failed/i.test(l)?"download failed (check your connection)":l.slice(0,200)}let T=Promise.resolve();self.onmessage=async e=>{const n=e.data;try{switch(n.type){case"init":{const r=await U(n);d({id:n.id,ok:!0,result:r});break}case"run":{await M(n);break}case"lsp":{const r=await Z(n);d({id:n.id,ok:!0,result:r});break}case"ensure-packages":{const r=Y(n.names,n.quiet);T=Promise.allSettled([T,r]);const s=await r;d({id:n.id,ok:!0,result:s});break}case"list-packages":{await E();const r=await t.runPythonAsync(`import micropip, json
json.dumps([{'name': v.name, 'version': v.version, 'source': str(getattr(v, 'source', ''))} for v in micropip.list().values()])`),s=JSON.parse(r),i=new Set(s.map(o=>o.name.toLowerCase())),l=new Set(["micropip","jedi","parso","pyodide-http","packaging","pyodide-py"]);for(const[o,c]of Object.entries(t.loadedPackages??{})){const p=o.toLowerCase();i.has(p)||l.has(p)||s.push({name:o,version:String(c),source:"pyodide"})}s.sort((o,c)=>o.name.localeCompare(c.name)),d({id:n.id,ok:!0,result:s});break}case"uninstall":{await E(),await t.runPythonAsync(`import micropip
micropip.uninstall(${JSON.stringify(n.names)})`),d({id:n.id,ok:!0,result:{removed:n.names}});break}case"reset":{try{b?.destroy?.()}catch{}b=null,d({id:n.id,ok:!0,result:{}});break}case"sync-files":{const r="/home/pyodide/workspace";t.FS.mkdirTree(r);for(const s of n.files)try{const i=`${r}/${s.path}`;t.FS.mkdirTree(i.split("/").slice(0,-1).join("/")),t.FS.writeFile(i,s.content)}catch{}d({id:n.id,ok:!0,result:{files:n.files.length}});break}case"memory":{let r=0;try{r=t?._module?.HEAPU8?.length??0}catch{}d({id:n.id,ok:!0,result:{wasm:r,loaded:!!t}});break}case"ping":{d({id:n.id,ok:!!t});break}}}catch(r){_(),d({id:n.id??-1,ok:!1,error:r instanceof Error?r.message:String(r)})}};
