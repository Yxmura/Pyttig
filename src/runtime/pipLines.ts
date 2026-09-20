// Colab/Jupyter habit support: `!pip install …` and `%pip install …` lines.
//
// There is no real pip in the browser (no subprocesses, no builds). These
// lines are stripped from the program and routed to micropip instead, which
// installs pure-Python wheels from PyPI and wasm wheels from the Pyodide
// index. Keeping the line count stable means tracebacks still line up.

export interface PipLines {
  packages: string[];
  code: string;
}

export function extractPipInstalls(code: string): PipLines {
  const packages: string[] = [];
  const lines = code.split(/\r?\n/);
  const out = lines.map((line) => {
    const m = /^\s*[!%]\s*pip\s+install\s+(.+?)\s*$/.exec(line);
    if (!m) return line;
    for (const token of m[1].split(/\s+/)) {
      if (!token || token.startsWith("-")) continue; // flags like -q / --quiet
      packages.push(token);
    }
    return `# ${line.trim()}`;
  });
  return { packages: [...new Set(packages)], code: out.join("\n") };
}
