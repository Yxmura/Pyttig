"""Build a wheel from a pure-Python sdist, inside the browser.

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
                name = info.filename.replace("\\", "/")
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
    """Return the path of a wheel built from the latest sdist of `name`."""
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
        # `setuptools.build_meta:__legacy__` points at an instance, not a module.
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
    """Let micropip read `file://` wheels from the virtual FS.

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
        head = str(f).replace("\\", "/").split("/")[0]
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
