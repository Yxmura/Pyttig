// Welcome tab shown when no file is open: two clear starting points.

import { icons } from "./icons";
import { runCommand } from "./commands";

export function renderWelcome(host: HTMLElement): void {
  // Idempotent: several code paths (boot, tab close, self-healing) may ask.
  if (host.querySelector(".welcome")) return;
  host.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "welcome";
  wrap.innerHTML = `
    <div class="welcome-inner">
      <div class="welcome-hero">
        <img class="welcome-logo" src="./logo.png" alt="Pyttig logo" />
        <h1>Pyttig <span class="spicy">· pittig fast Python</span></h1>
      </div>
      <p class="welcome-sub">Python, in your browser, with basic git support.</p>
      <div class="welcome-actions">
        <button class="btn primary" data-new>${icons.filePlus}<span>New file</span></button>
        <button class="btn" data-clone>${icons.git}<span>Clone a GitHub repo</span></button>
      </div>
      <p class="welcome-hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> to run · <kbd>Ctrl</kbd>+<kbd>P</kbd> to open a file · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> for commands</p>
    </div>`;
  host.appendChild(wrap);
  (wrap.querySelector("[data-new]") as HTMLButtonElement).onclick = () => void runCommand("file.new");
  (wrap.querySelector("[data-clone]") as HTMLButtonElement).onclick = () => void runCommand("git.clone");
}
