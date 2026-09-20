var J=`"""Pyttig Jedi language service.

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
`,B=`"""Build a wheel from a pure-Python sdist, inside the browser.

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


def missing_dependency(dist_name: str) -> str:
    """Import a distribution's top-level module and report a missing module.

    Some packages ship incomplete metadata (soupsieve 2.8 imports bs4 without
    declaring it) and the Pyodide lock occasionally lists fewer dependencies
    than the wheel does (httpx without httpcore). Installing by name then
    leaves an unusable package. We import it here and, if a module is missing,
    the caller installs that through the normal chain and tries again.
    """
    import importlib
    import importlib.metadata as md

    try:
        dist = md.distribution(dist_name)
    except Exception:
        return ""
    tops: set[str] = set()
    for f in dist.files or []:
        head = str(f).replace("\\\\", "/").split("/")[0]
        if head.startswith("..") or head.endswith((".dist-info", ".egg-info")):
            continue
        if head in ("bin", "share", "include", "Scripts", "__pycache__"):
            continue
        if head.endswith(".py"):
            tops.add(head[:-3])
        elif "." not in head:
            tops.add(head)
        elif ".so" in head:
            tops.add(head.split(".")[0])
    skip = {"setup", "conftest", "noxfile", "tasks", "scripts", "sitecustomize", "_distutils_hack", "tests", "test"}
    for top in sorted(t for t in tops if t and t not in skip):
        try:
            importlib.import_module(top)
            return ""
        except ModuleNotFoundError as exc:
            return getattr(exc, "name", "") or top
        except Exception:
            return ""  # broken for another reason — not a missing dependency
    return ""
`;const q="314.0.7",z=e=>`https://cdn.jsdelivr.net/pyodide/v${e}/full/`;function D(e=q){return`${z(e)}pyodide.mjs`}function U(e){const t=[],s=e.split(/\r?\n/).map(o=>{const l=/^\s*[!%]\s*pip\s+install\s+(.+?)\s*$/.exec(o);if(!l)return o;for(const r of l[1].split(/\s+/))!r||r.startsWith("-")||t.push(r);return`# ${o.trim()}`});return{packages:[...new Set(t)],code:s.join(`
`)}}const W={pygame:"pygame-ce",pil:"pillow",image:"pillow",bs4:"beautifulsoup4",sklearn:"scikit-learn",cv2:"opencv-python",yaml:"pyyaml",docx:"python-docx",pptx:"python-pptx",dateutil:"python-dateutil",dotenv:"python-dotenv",jwt:"pyjwt",openssl:"pyopenssl",crypto:"pycryptodome",serial:"pyserial",usb:"pyusb",discord:"discord.py",imblearn:"imbalanced-learn",skimage:"scikit-image",attr:"attrs",pkg_resources:"setuptools",levenshtein:"python-levenshtein",fitz:"pymupdf",google:"protobuf",win32com:"pywin32"};function M(e){return W[e.trim().toLowerCase()]??e.trim()}let i=null,_=null,F=!1,w=-1,R=[],g=null,m="",x="";const d=(e,t)=>self.postMessage(e,t);function b(){m&&(d({event:"stdout",runId:w,data:m}),m=""),x&&(d({event:"stderr",runId:w,data:x}),x="")}function A(e){m+=e+`
`,m.length>256&&b()}function C(e){x+=e+`
`,x.length>256&&b()}function y(e){m+=`\x1B[90m${e}\x1B[0m
`,m.length>4096&&b()}let L=Promise.resolve();function k(e){const t=L.then(e,e);return L=t.catch(()=>{}),t}let N=!1;function V(e){if(!e||N)return;N=!0;const t=e.endsWith("?"),n=t||e.endsWith("/")?e:`${e}/`,s=new Set(["pypi.org","files.pythonhosted.org","test.pypi.org","cdn.jsdelivr.net"]),o=self.fetch.bind(self),l=r=>t?n+encodeURIComponent(r):n+r;self.fetch=(r,a)=>{try{const p=typeof r=="string"?r:r instanceof URL?r.href:r.url,f=new URL(p,self.location.href);return f.protocol!=="http:"&&f.protocol!=="https:"||f.origin===self.location.origin||s.has(f.hostname)?o(r,a):typeof r!="string"&&!(r instanceof URL)?o(new Request(l(p),r),a):o(l(p),a)}catch{return o(r,a)}}}async function S(){if(!i)throw new Error("Python runtime is not ready yet");await k(()=>i.loadPackage("micropip",{messageCallback:()=>{},errorCallback:()=>{}}))}async function P(e){let t="",n=null,s;try{const o={batched:r=>A(r)},l={batched:r=>C(r)};i.setStdout({batched:r=>{t+=r+`
`}}),i.setStderr({batched:r=>{t+=r+`
`}}),n=()=>{i.setStdout(o),i.setStderr(l)},s=await i.runPythonAsync(e)}finally{n?.()}for(const o of t.split(`
`))o.trim()&&y(o);return s}async function j(e,t,n=0){if(!i)throw new Error("Python runtime is not ready yet");const s=M(e);try{await k(()=>i.loadPackage([s],{messageCallback:t,errorCallback:t}));return}catch{}let o=!1;try{await k(()=>P(`import micropip
await micropip.install(${JSON.stringify(s)})`)),o=!0}catch{}o||await Y(s,t,n),await H(s,t,n)}async function H(e,t,n){if(n>2)return;const s=["import sys, importlib","if '/tmp' not in sys.path: sys.path.insert(0, '/tmp')","mod = sys.modules.get('pyttig_sdist_build') or importlib.import_module('pyttig_sdist_build')",`mod.missing_dependency(${JSON.stringify(e)})`].join(`
`);let o="";try{o=String(await P(s))}catch{return}!o||o===e||o.includes(".")||(y(`  also needs ${o}`),await j(o,t,n+1))}async function Y(e,t,n){if(!i)throw new Error("Python runtime is not ready yet");if(n>4)throw new Error(`dependency chain too deep at ${e}`);const o=["import sys, importlib","if '/tmp' not in sys.path: sys.path.insert(0, '/tmp')","mod = sys.modules.get('pyttig_sdist_build') or importlib.import_module('pyttig_sdist_build')",`await mod.build_wheel_from_sdist(${JSON.stringify(e)}, ${JSON.stringify("/tmp/pyttig-wheels")})`].join(`
`),l=String(await P(o)),r=`file://${l}`,a=String(await P(`import sys, importlib, json
if '/tmp' not in sys.path: sys.path.insert(0, '/tmp')
mod = sys.modules.get('pyttig_sdist_build') or importlib.import_module('pyttig_sdist_build')
json.dumps(mod.dependencies_of(${JSON.stringify(l)}))`));for(const p of JSON.parse(a||"[]"))p.toLowerCase()!==e.toLowerCase()&&(y(`  needs ${p}`),await j(p,t,n+1));await P(`import micropip
await micropip.install(${JSON.stringify(r)}, deps=False)`)}function Z(){let e=[];const t=n=>{const s=new TextEncoder().encode(n+`
`);m+=n+`
`;for(const o of s)e.push(o)};return()=>{for(;;){if(e.length)return e.shift();if(R.length){t(R.shift());continue}if(g){d({event:"input-request",runId:w}),Atomics.store(g.meta,0,0),Atomics.wait(g.meta,0,0);const n=Atomics.load(g.meta,1);if(n>0){const s=g.buf.slice(0,n),o=new TextDecoder().decode(s).replace(/\r?\n$/,"");b(),t(o);continue}return null}return null}}}async function G(e){i=await(await import(e.moduleURL||D(q))).loadPyodide({indexURL:e.indexURL,stdout:o=>{m+=o+`
`},stderr:o=>{x+=o+`
`}}),i.setStdout({batched:o=>A(o)}),i.setStderr({batched:o=>C(o)}),i.setStdin({stdin:Z(),isatty:!1,error:!1}),i.FS.writeFile("/tmp/pyttig_sdist_build.py",B),e.isolated&&e.interruptBuffer&&i.setInterruptBuffer(new Uint8Array(e.interruptBuffer)),e.isolated&&e.stdinBuffer&&e.stdinMeta&&(g={buf:new Uint8Array(e.stdinBuffer),meta:new Int32Array(e.stdinMeta)}),V(e.proxy);try{await k(()=>i.loadPackage("pyodide-http",{messageCallback:()=>{},errorCallback:()=>{}})),await i.runPythonAsync(`import pyodide_http
pyodide_http.patch_all()`)}catch{}try{await i.runPythonAsync(`import matplotlib
matplotlib.use('Agg')`)}catch{}return{version:await i.runPythonAsync(`import sys
sys.version.split()[0]`),isolated:e.isolated,sabStdin:!!g}}const Q=`
import os as __pyttig_os, builtins as __pyttig_builtins
__pyttig_os.environ["SDL_VIDEODRIVER"] = "dummy"
__pyttig_os.environ["SDL_AUDIODRIVER"] = "dummy"
__pyttig_import = __pyttig_builtins.__import__
def __pyttig_import_hook(name, *args, **kwargs):
    mod = __pyttig_import(name, *args, **kwargs)
    if name == "pygame" and not getattr(mod, "__pyttig_shimmed", False):
        def __pyttig_no_window(*_a, **_k):
            raise RuntimeError(
                "Pyttig runs Python in a background worker, so pygame cannot open a window here. "
                "Everything else in your program runs (sprites, movement, collisions, prints). "
                "Use the local launcher for the visual part."
            )
        try:
            mod.display.set_mode = __pyttig_no_window
            mod.__pyttig_shimmed = True
        except Exception:
            pass
    return mod
__pyttig_builtins.__import__ = __pyttig_import_hook
`;function I(e){const t=new Map;if(!i)return t;const n=i.FS,s=o=>{let l;try{l=n.readdir(o).filter(r=>r!=="."&&r!=="..")}catch{return}for(const r of l){const a=`${o}/${r}`;try{const p=n.stat(a);n.isDir(p.mode)?s(a):t.set(a,`${p.size}:${Number(p.mtime)}`)}catch{}}};return s(e),t}async function K(e){if(!i)throw new Error("Python runtime is not ready yet");await T,w=e.runId,R=[...e.stdinLines];const t="/home/pyodide/workspace";i.FS.mkdirTree(t);for(const c of e.files){const u=`${t}/${c.path}`,h=u.split("/").slice(0,-1).join("/");i.FS.mkdirTree(h),i.FS.writeFile(u,c.content)}const n=I(t),s=U(e.code);if(s.packages.length){y(`pip install ${s.packages.join(" ")}`);try{await S();for(const c of s.packages)await j(c,u=>y(String(u)));y("ok"),d({event:"pkg-installed",names:s.packages})}catch(c){y(`pip install failed: ${c instanceof Error?c.message:c}`)}m+=`
`}let o=0;const l=c=>{o++,y(String(c))};try{await k(()=>i.loadPackagesFromImports(s.code,{messageCallback:l,errorCallback:l}))}catch{}o&&(m+=`
`);try{await i.runPythonAsync(`import sys, os
os.chdir('/home/pyodide/workspace')`);const c=`import sys as __pyttig_sys
__pyttig_sys.argv = [${[e.filename,...e.args].map($=>JSON.stringify($)).join(", ")}]`;if(await i.runPythonAsync(c),!e.keepNs||!_){try{_?.destroy?.()}catch{}_=i.globals.get("dict")()}const u=_;u.set("__name__","__main__"),u.set("__file__",`${t}/${e.filename}`),u.set("__package__",null);const v=[/\bpygame\b/.test(s.code)?Q:"",`__pyttig_code = eval(compile(${JSON.stringify(s.code)}, ${JSON.stringify(e.filename)}, "exec", flags=__import__("ast").PyCF_ALLOW_TOP_LEVEL_AWAIT), globals())`,"if __pyttig_code is not None:","    await __pyttig_code"].join(`
`);(await i.runPythonAsync(v,{filename:e.filename,globals:_}))?.destroy?.()}catch(c){b();const h=(c instanceof Error?c.message:String(c)).replace(/^PythonError:\s*/,"");d({event:"stderr",runId:w,data:h+(h.endsWith(`
`)?"":`
`)});const v=/ModuleNotFoundError: No module named '([^']+)'/.exec(h)?.[1];v&&d({event:"missing-module",runId:w,name:v.split(".")[0]})}finally{b()}const r=[];try{await i.runPythonAsync(`
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
`);const c=i.runPython("__pyttig_plots").toJs();for(const u of c){const h=i.FS.readFile(u);r.push({name:u.split("/").pop()??"figure.png",png:h.buffer})}}catch{}const a=I(t),p=[];let f=0;for(const[c,u]of a){if(n.get(c)===u)continue;const h=c.slice(t.length+1);try{if(i.FS.stat(c).size>5*1024*1024)continue;if(f>10*1024*1024)break;const O=i.FS.readFile(c);f+=O.length,p.push({path:h,content:O.buffer})}catch{}}const E=r.map(c=>c.png).concat(p.map(c=>c.content));d({id:e.id,ok:!0,result:{plots:r,changed:p},runId:w,type:"run-done"},E)}async function X(){if(!F){if(!i)throw new Error("Python runtime is not ready yet");await k(()=>i.loadPackage(["jedi","parso"],{messageCallback:()=>{},errorCallback:()=>{}})),await i.runPythonAsync(J+`
__pyttig_lsp_ready = True`),await i.runPythonAsync("handle('init', {})"),F=!0}}async function ee(e){await X();const t=JSON.stringify(e.params);i.globals.set("__pyttig_params",t);const n=await i.runPythonAsync(`import json as __json
__r = handle(${JSON.stringify(e.op)}, __json.loads(__pyttig_params))
__r`);let s;try{s=n?.toJs?.({dict_converter:Object.fromEntries})??n}finally{n?.destroy?.()}return s}async function te(e,t=!1){if(!i)throw new Error("Python runtime is not ready yet");const n=t?()=>{}:a=>y(String(a)),s=[];try{const a=i.runPython("list(__import__('sys').modules)").toJs();for(const p of e)a.includes(p)||s.push(p)}catch{s.push(...e)}if(s.length)try{return await k(()=>i.loadPackage(s,{messageCallback:n,errorCallback:n})),{installed:s,failed:[],errors:{}}}catch{}const o=[],l=[],r={};await S();for(const a of s){d({event:"pkg-status",name:a,state:"installing"});try{await j(a,n),o.push(a),d({event:"pkg-status",name:a,state:"done"})}catch(p){const f=p instanceof Error?p.message:String(p);l.push(a),r[a]=ne(f);for(const E of f.split(`
`).slice(-5))E.trim()&&y(E);d({event:"pkg-status",name:a,state:"error",error:r[a]})}}return{installed:o,failed:l,errors:r}}function ne(e){const t=e.replace(/\s+/g," ").trim();if(/C compiler|clang|emcc|cc1plus|gcc|cargo|maturin|meson|ninja|Python\.h|arrayobject\.h|unable to execute|no such file or directory: 'cc'/i.test(t))return"needs compiled code and has no browser build";const s=[...e.split(`
`).map(r=>r.trim()).filter(Boolean)].reverse(),l=s.find(r=>/^[A-Za-z_][\w.]*(Error|Exception): /.test(r))??s.find(r=>/^[A-Za-z_][\w.]*: /.test(r)&&!/^See: /.test(r))??t;return/Couldn't find a pure Python 3 wheel|No wheel|not found in PyPI/i.test(l)?"no wheel for the browser — it would need compiling C code, which browsers can't do":/no source distribution|is not on PyPI/i.test(l)?"not available for the browser (no wheel, no source package on PyPI)":/Failed to fetch|NetworkError|Load failed/i.test(l)?"download failed (check your connection)":l.slice(0,200)}let T=Promise.resolve();self.onmessage=async e=>{const t=e.data;try{switch(t.type){case"init":{const n=await G(t);d({id:t.id,ok:!0,result:n});break}case"run":{await K(t);break}case"lsp":{const n=await ee(t);d({id:t.id,ok:!0,result:n});break}case"ensure-packages":{const n=te(t.names,t.quiet);T=Promise.allSettled([T,n]);const s=await n;d({id:t.id,ok:!0,result:s});break}case"list-packages":{await S();const n=await i.runPythonAsync(`import micropip, json
json.dumps([{'name': v.name, 'version': v.version, 'source': str(getattr(v, 'source', ''))} for v in micropip.list().values()])`),s=JSON.parse(n),o=new Set(s.map(r=>r.name.toLowerCase())),l=new Set(["micropip","jedi","parso","pyodide-http","packaging","pyodide-py"]);for(const[r,a]of Object.entries(i.loadedPackages??{})){const p=r.toLowerCase();o.has(p)||l.has(p)||s.push({name:r,version:String(a),source:"pyodide"})}s.sort((r,a)=>r.name.localeCompare(a.name)),d({id:t.id,ok:!0,result:s});break}case"uninstall":{await S(),await i.runPythonAsync(`import micropip
micropip.uninstall(${JSON.stringify(t.names)})`),d({id:t.id,ok:!0,result:{removed:t.names}});break}case"reset":{try{_?.destroy?.()}catch{}_=null,d({id:t.id,ok:!0,result:{}});break}case"sync-files":{const n="/home/pyodide/workspace";i.FS.mkdirTree(n);for(const s of t.files)try{const o=`${n}/${s.path}`;i.FS.mkdirTree(o.split("/").slice(0,-1).join("/")),i.FS.writeFile(o,s.content)}catch{}d({id:t.id,ok:!0,result:{files:t.files.length}});break}case"memory":{let n=0;try{n=i?._module?.HEAPU8?.length??0}catch{}d({id:t.id,ok:!0,result:{wasm:n,loaded:!!i}});break}case"ping":{d({id:t.id,ok:!!i});break}}}catch(n){b(),d({id:t.id??-1,ok:!1,error:n instanceof Error?n.message:String(n)})}};
