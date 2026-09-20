// Generates:
//   public/fileicons/*.svg        — only the icons referenced by the manifest
//   src/fs/fileIconMap.json       — trimmed name/extension → icon maps
// Source: material-icon-theme (MIT), the icon set used by VS Code.
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const srcDir = join(root, "node_modules", "material-icon-theme");
const manifest = JSON.parse(readFileSync(join(srcDir, "dist", "material-icons.json"), "utf8"));
const defs = manifest.iconDefinitions ?? {};

/** Resolve a definition name to an icon file name (e.g. "python" → "python.svg"). */
function resolve(defName) {
  const def = defs[defName];
  if (def?.iconPath) return basename(def.iconPath);
  return `${defName}.svg`;
}

function mapResolved(map = {}) {
  const out = {};
  for (const [key, val] of Object.entries(map)) {
    if (typeof val === "string") out[key.toLowerCase()] = resolve(val);
  }
  return out;
}

const out = {
  file: resolve(manifest.file ?? "file"),
  folder: resolve(manifest.folder ?? "folder"),
  folderExpanded: resolve(manifest.folderExpanded ?? "folder-open"),
  fileNames: mapResolved(manifest.fileNames),
  fileExtensions: mapResolved(manifest.fileExtensions),
  folderNames: mapResolved(manifest.folderNames),
  folderNamesExpanded: mapResolved(manifest.folderNamesExpanded),
};

// ---- copy only referenced icons into public/fileicons/
const outDir = join(root, "public", "fileicons");
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const needed = new Set([
  out.file,
  out.folder,
  out.folderExpanded,
  ...Object.values(out.fileNames),
  ...Object.values(out.fileExtensions),
  ...Object.values(out.folderNames),
  ...Object.values(out.folderNamesExpanded),
]);

let copied = 0;
let missing = 0;
for (const file of needed) {
  const from = join(srcDir, "icons", file);
  if (!existsSync(from)) {
    missing++;
    continue;
  }
  copyFileSync(from, join(outDir, file));
  copied++;
}

writeFileSync(
  join(root, "src", "fs", "fileIconMap.json"),
  `${JSON.stringify(out)}\n`,
  "utf8",
);

const bytes = JSON.stringify(out).length;
console.log(
  `file icons: copied ${copied} svg (${needed.size} referenced, ${missing} missing), map ${(bytes / 1024).toFixed(1)} KB`,
);
