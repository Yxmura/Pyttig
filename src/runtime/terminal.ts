// xterm.js terminal: output rendering, traceback links, line-input mode.
import { Terminal, type ILink, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

/** Catppuccin terminal palettes (Mocha / Latte). */
const MOCHA_TERM: ITheme = {
  background: "#11111b",
  foreground: "#cdd6f4",
  cursor: "#f5e0dc",
  selectionBackground: "#585b70",
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#cba6f7",
  cyan: "#94e2d5",
  white: "#bac2de",
  brightBlack: "#585b70",
  brightRed: "#f38ba8",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#cba6f7",
  brightCyan: "#94e2d5",
  brightWhite: "#a6adc8",
};

const LATTE_TERM: ITheme = {
  background: "#eff1f5",
  foreground: "#4c4f69",
  cursor: "#dc8a78",
  selectionBackground: "#acb0be",
  black: "#5c5f77",
  red: "#d20f39",
  green: "#40a02b",
  yellow: "#df8e1d",
  blue: "#1e66f5",
  magenta: "#8839ef",
  cyan: "#179299",
  white: "#acb0be",
  brightBlack: "#6c6f85",
  brightRed: "#d20f39",
  brightGreen: "#40a02b",
  brightYellow: "#df8e1d",
  brightBlue: "#1e66f5",
  brightMagenta: "#8839ef",
  brightCyan: "#179299",
  brightWhite: "#bcc0cc",
};

const TERM_FONT = '"Geist Mono", "JetBrains Mono", "Cascadia Code", Consolas, monospace';

function currentTermTheme(): ITheme {
  return document.documentElement.dataset.theme === "light" ? LATTE_TERM : MOCHA_TERM;
}

export class PyTerminal {
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private host: HTMLElement | null = null;
  private inputResolve: ((line: string | null) => void) | null = null;
  private editLine = "";
  private openFileAt: (path: string, line: number) => void = () => {};

  onOpenFile(fn: (path: string, line: number) => void) {
    this.openFileAt = fn;
  }

  /** Re-apply the terminal palette after a theme change. */
  resyncTheme(): void {
    if (this.term) this.term.options.theme = currentTermTheme();
  }

  /** The xterm instance exists from the start, so output written before the
   *  panel is ever shown is kept and rendered when it is attached. */
  private ensure(): Terminal {
    if (this.term) return this.term;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: TERM_FONT,
      theme: currentTermTheme(),
      allowProposedApi: true,
    });
    term.loadAddon(new WebLinksAddon());
    term.onData((data) => this.handleKey(data));
    // Let app shortcuts through while the terminal has focus: a student
    // watching a game or reading output must still be able to press Shift+F5.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const appShortcut =
        e.key === "F5" || (e.ctrlKey && !e.altKey && e.key.toLowerCase() !== "c");
      return !appShortcut;
    });
    this.term = term;
    this.wireLinks();
    return term;
  }

  attach(host: HTMLElement): void {
    const term = this.ensure();
    if (this.host === host) {
      this.fit?.fit();
      return;
    }
    if (term.element) {
      // Move the live terminal (keeping scrollback) into the new host —
      // switching panel tabs must not wipe what a student just ran.
      this.host = host;
      host.innerHTML = "";
      host.appendChild(term.element);
      try {
        this.fit?.fit();
      } catch { /* hidden */ }
      term.refresh(0, term.rows - 1);
      term.scrollToBottom();
      return;
    }
    this.host = host;
    host.innerHTML = "";
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    this.fit = fit;
    try {
      fit.fit();
    } catch {
      /* host may have no size yet; fitView() retries on show */
    }
    new ResizeObserver(() => {
      try {
        fit.fit();
      } catch { /* hidden */ }
    }).observe(host);
  }

  /** Real link provider needs the terminal instance; wire after attach. */
  wireLinks(): void {
    if (!this.term) return;
    const term = this.term;
    const open = this.openFileAt;
    term.registerLinkProvider({
      provideLinks(y: number, cb: (links: ILink[] | undefined) => void) {
        const buf = term.buffer.active;
        const line = buf.getLine(y)?.translateToString(true) ?? "";
        const re = /File "([^"]+)", line (\d+)/g;
        const out: ILink[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(line))) {
          const start = m.index;
          const end = start + m[0].length;
          const path = m[1];
          const lineno = Number(m[2]);
          const text = m[0];
          out.push({
            range: { start: { x: start + 1, y }, end: { x: end + 1, y } },
            text,
            activate: () => open(path, lineno),
          });
        }
        cb(out);
      },
    });
  }

  write(data: string): void {
    this.ensure().write(data);
  }

  clear(): void {
    this.ensure().clear();
  }

  fitView(): void {
    try {
      this.fit?.fit();
    } catch { /* hidden */ }
  }

  get inputActive(): boolean {
    return this.inputResolve !== null;
  }

  /** Prompt for one line of input. Resolves null on Ctrl+C. */
  readLine(prompt = ""): Promise<string | null> {
    if (prompt) this.write(prompt);
    this.editLine = "";
    return new Promise((resolve) => {
      this.inputResolve = resolve;
    });
  }

  cancelInput(): void {
    if (this.inputResolve) {
      this.write("^C\r\n");
      const r = this.inputResolve;
      this.inputResolve = null;
      r(null);
    }
  }

  submitFromApi(line: string | null): void {
    if (!this.inputResolve) return;
    const r = this.inputResolve;
    this.inputResolve = null;
    if (line !== null) this.write(line + "\r\n");
    r(line);
  }

  private handleKey(data: string): void {
    if (!this.inputResolve) return; // output-only otherwise
    if (data === "\r") {
      const line = this.editLine;
      this.editLine = "";
      const r = this.inputResolve;
      this.inputResolve = null;
      this.write("\r\n");
      r(line);
    } else if (data === "\u007f") {
      if (this.editLine.length) {
        this.editLine = this.editLine.slice(0, -1);
        this.write("\b \b");
      }
    } else if (data === "\u0003") {
      this.cancelInput();
    } else if (data >= " " || data === "\t") {
      this.editLine += data;
      this.write(data);
    }
  }
}

export const terminal = new PyTerminal();
