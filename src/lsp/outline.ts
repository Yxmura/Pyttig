// Fast regex-based Python outline (no runtime needed for Ctrl+Shift+O).

export interface OutlineSymbol {
  name: string;
  kind: number; // 5 = class, 12 = function (LSP SymbolKind)
  line: number; // 1-based
  col: number; // 0-based
}

export function outlineSymbols(uri: string, text: string): {
  name: string;
  kind: number;
  location: { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } };
}[] {
  const out: {
    name: string;
    kind: number;
    location: { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } };
  }[] = [];
  const lines = text.split("\n");
  lines.forEach((ln, i) => {
    const m = /^(\s*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/.exec(ln);
    if (m) {
      const col = ln.indexOf(m[3]);
      out.push({
        name: m[3],
        kind: m[2] === "class" ? 5 : 12,
        location: { uri, range: { start: { line: i, character: col }, end: { line: i, character: col + m[3].length } } },
      });
    }
  });
  return out;
}

export function outlineSimple(text: string): { name: string; kind: string; line: number }[] {
  return outlineSymbols("", text).map((s) => ({
    name: s.name,
    kind: s.kind === 5 ? "class" : "function",
    line: s.location.range.start.line + 1,
  }));
}
