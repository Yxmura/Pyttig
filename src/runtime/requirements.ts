// requirements.txt support: exercise repos usually ship one.
// Parsing is deliberately forgiving — comments, options, extras, version
// pins and environment markers are all accepted.

// Classroom repos often ship a `pip freeze` from Colab/Jupyter. Those files
// list the notebook machinery, which Pyttig replaces with itself: installing
// it is pointless and some of it (pexpect, ptyprocess) cannot work here.
const NOTEBOOK_RUNTIME = new Set([
  "appnope", "argon2-cffi", "argon2-cffi-bindings", "asttokens", "async-lru",
  "bleach", "comm", "debugpy", "decorator", "defusedxml", "entrypoints",
  "executing", "fastjsonschema", "ipykernel", "ipython", "ipython-genutils",
  "ipywidgets", "jupyter", "jupyter-client", "jupyter-console", "jupyter-core",
  "jupyter-events", "jupyter-lsp", "jupyter-server", "jupyter-server-terminals",
  "jupyterlab", "jupyterlab-pygments", "jupyterlab-server", "jupyterlab-widgets",
  "matplotlib-inline", "mistune", "nbclassic", "nbclient", "nbconvert",
  "nbformat", "nest-asyncio", "notebook", "notebook-shim", "pandocfilters",
  "parso", "pexpect", "pickleshare", "prometheus-client", "prompt-toolkit",
  "ptyprocess", "pure-eval", "pyzmq", "send2trash", "soupsieve", "stack-data",
  "terminado", "tinycss2", "tornado", "traitlets", "wcwidth",
  "webencodings", "widgetsnbextension",
]);

export function parseRequirements(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    let spec = line.split(";")[0].trim(); // environment markers
    spec = spec.split(" #")[0].trim(); // trailing comments
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
    if (!m) continue;
    const name = m[1];
    // Skip obvious non-package noise.
    if (!/[A-Za-z]/.test(name)) continue;
    out.push(name);
  }
  return [...new Set(out)];
}

/** Split requirements into what's worth installing here and notebook plumbing. */
export function splitRequirements(names: string[]): { install: string[]; skipped: string[] } {
  const install: string[] = [];
  const skipped: string[] = [];
  for (const n of names) {
    if (NOTEBOOK_RUNTIME.has(n.toLowerCase())) skipped.push(n);
    else install.push(n);
  }
  return { install, skipped };
}

export const REQUIREMENTS_FILE = "requirements.txt";
