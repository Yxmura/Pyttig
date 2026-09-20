// Pinned Pyodide version shared by the worker (loader) and the client (indexURL).

export const PYODIDE_VERSION = "314.0.7";
const CDN = (version: string) => `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;

export function pyodideIndexUrl(version: string = PYODIDE_VERSION): string {
  return `${CDN(version)}`;
}

export function pyodideModuleUrl(version: string = PYODIDE_VERSION): string {
  return `${CDN(version)}pyodide.mjs`;
}

const OVERRIDE_KEY = "pyttig.pyodideUrl";

/** Custom base URL (e.g. launcher-vendored /__pyttig__/pyodide/314.0.7/), or "" for CDN. */
export function getPyodideOverride(): string {
  try {
    return (localStorage.getItem(OVERRIDE_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

function join(base: string, file: string): string {
  return base.endsWith("/") ? base + file : `${base}/${file}`;
}

/** Effective {module, index} URLs honoring the override. */
export function resolvePyodideUrls(): { module: string; index: string } {
  const base = getPyodideOverride();
  if (base) return { module: join(base, "pyodide.mjs"), index: base.endsWith("/") ? base : `${base}/` };
  return { module: pyodideModuleUrl(), index: pyodideIndexUrl() };
}
