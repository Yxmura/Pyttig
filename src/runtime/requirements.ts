// requirements.txt support: exercise repos usually ship one.
// Parsing is deliberately forgiving — comments, options, extras, version
// pins and environment markers are all accepted.

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

export const REQUIREMENTS_FILE = "requirements.txt";
