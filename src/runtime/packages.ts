// Packages activity view: micropip install / uninstall / list + one-click stacks.

import type { Shell } from "../app/shell";
import { registerCommands } from "../app/commands";
import { notify } from "../app/toast";
import { confirmDialog } from "../app/dialog";
import { ensurePackages, listPackages, uninstallPackages, onRuntimeChange, type EnsureResult, type PkgInfo } from "./client";
import { parseRequirements, REQUIREMENTS_FILE, splitRequirements } from "./requirements";

const PRESETS: { name: string; desc: string; pkgs: string[] }[] = [
  {
    name: "Data science core",
    desc: "numpy · pandas · matplotlib · requests · beautifulsoup4 · Pillow · sympy",
    pkgs: ["numpy", "pandas", "matplotlib", "requests", "beautifulsoup4", "Pillow", "pyyaml", "rich", "tqdm", "python-dateutil", "sympy"],
  },
  {
    name: "Data science extended",
    desc: "scipy · scikit-learn · statsmodels · seaborn · openpyxl · polars · pyarrow",
    pkgs: ["scipy", "scikit-learn", "statsmodels", "seaborn", "openpyxl", "polars", "pyarrow"],
  },
  {
    name: "Web & APIs",
    desc: "requests · httpx · beautifulsoup4 · lxml · pydantic · jsonschema · jinja2 · pyyaml",
    pkgs: ["requests", "httpx", "beautifulsoup4", "lxml", "pydantic", "jsonschema", "Jinja2", "pyyaml"],
  },
  {
    name: "Dev tools",
    desc: "pytest · rich · tqdm · click · tabulate · faker · ipython",
    pkgs: ["pytest", "rich", "tqdm", "click", "tabulate", "faker", "ipython"],
  },
  {
    name: "CodeFever P1–P3",
    desc: "pygame · pillow · requests · bs4 · flask · fastapi · discord.py · gymnasium · numpy · matplotlib · scikit-learn · tqdm · datasets",
    pkgs: [
      "pygame", "pillow", "requests", "beautifulsoup4", "flask", "fastapi",
      "discord.py", "gymnasium", "numpy", "matplotlib", "scikit-learn",
      "tqdm", "huggingface-hub", "datasets", "openai",
      "imbalanced-learn", "langdetect",
    ],
  },
];

let installed: PkgInfo[] = [];
let loading = false;
let draft = "";

/** "cowsay, torch — torch: no wheel for the browser…" */
function failureText(r: EnsureResult): string {
  const why = r.failed.map((n) => (r.errors?.[n] ? `${n}: ${r.errors[n]}` : n));
  return why.join(" · ");
}

async function refresh(host: HTMLElement) {
  loading = true;
  draw(host);
  try {
    installed = await listPackages();
  } catch (err) {
    notify.error(`Could not list packages: ${err instanceof Error ? err.message : err}`);
  }
  loading = false;
  draw(host);
}

function draw(host: HTMLElement) {
  host.innerHTML = "";
  const box = document.createElement("div");
  box.className = "search-box";
  box.innerHTML = `<input placeholder="Install package… e.g. numpy, cowsay" aria-label="Install package"/>`;
  const input = box.querySelector("input") as HTMLInputElement;
  input.value = draft;
  input.oninput = () => {
    draft = input.value;
  };
  const btn = document.createElement("button");
  btn.className = "btn primary";
  btn.textContent = loading ? "Working…" : "Install";
  btn.disabled = loading;
  btn.onclick = async () => {
    const names = input.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (!names.length) return;
    input.value = "";
    draft = "";
    btn.disabled = true;
    try {
      const r = await ensurePackages(names);
      if (r.failed.length) notify.error(`Failed — ${failureText(r)}`, { timeout: 15000 });
      else notify.success(`Installed: ${r.installed.join(", ")}.`);
    } catch (err) {
      notify.error(String(err));
    }
    await refresh(host);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") btn.click();
  };
  box.appendChild(btn);
  host.appendChild(box);

  const presets = document.createElement("div");
  presets.className = "side-section";
  presets.innerHTML = `<h4>Stacks</h4>`;
  for (const p of PRESETS) {
    const card = document.createElement("div");
    card.className = "preset-card";
    card.innerHTML = `<b></b><p></p>`;
    (card.querySelector("b") as HTMLElement).textContent = p.name;
    (card.querySelector("p") as HTMLElement).textContent = p.desc;
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = "Install stack";
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await ensurePackages(p.pkgs);
        if (r.failed.length) notify.warn(`Installed with skips — ${failureText(r)}`, { timeout: 15000 });
        else notify.success(`${p.name} installed.`);
      } catch (err) {
        notify.error(String(err));
      }
      await refresh(host);
    };
    card.appendChild(b);
    presets.appendChild(card);
  }
  host.appendChild(presets);

  const sec = document.createElement("div");
  sec.className = "side-section";
  sec.innerHTML = `<h4>Installed (${installed.length})</h4>`;
  const sorted = [...installed].sort((a, b) => a.name.localeCompare(b.name));
  if (!sorted.length && !loading) {
    sec.innerHTML += `<div class="empty-note">Nothing installed yet. What you install is remembered and restored on your next visit.</div>`;
  }
  for (const p of sorted) {
    const row = document.createElement("div");
    row.className = "pkg-row";
    row.innerHTML = `<span class="p-name"></span><span class="p-ver"></span><span class="p-src"></span>`;
    (row.querySelector(".p-name") as HTMLElement).textContent = p.name;
    (row.querySelector(".p-ver") as HTMLElement).textContent = p.version;
    (row.querySelector(".p-src") as HTMLElement).textContent = p.source || "stdlib";
    if (p.source === "pyodide") {
      // Bundled with the runtime: it can't be uninstalled, and shouldn't be.
      row.title = `${p.name} ships with the Python runtime`;
      sec.appendChild(row);
      continue;
    }
    const del = document.createElement("button");
    del.className = "icon-btn";
    del.title = `Uninstall ${p.name}`;
    del.innerHTML = "✕";
    del.onclick = async () => {
      if (!(await confirmDialog("Uninstall", `Uninstall "${p.name}"?`, "Uninstall", true))) return;
      try {
        await uninstallPackages([p.name]);
        notify.success(`Uninstalled ${p.name}. Restart the runtime to fully clear it.`);
      } catch (err) {
        notify.error(String(err));
      }
      await refresh(host);
    };
    row.appendChild(del);
    sec.appendChild(row);
  }
  host.appendChild(sec);
}

export function initPackages(shell: Shell): void {
  shell.registerActivity({
    id: "packages", title: "Packages", icon: "package", order: 5,
    render: (el) => {
      void refresh(el);
    },
  });
  registerCommands([
    {
      id: "packages.open", title: "Open packages", category: "Run", icon: "package",
      run: () => {
        shell.showActivity("packages");
        return Promise.resolve();
      },
    },
    {
      id: "packages.requirements",
      title: "Install from requirements.txt",
      category: "Run",
      icon: "package",
      run: async () => {
        const { wsExists, wsRead } = await import("../fs/workspace");
        if (!(await wsExists(REQUIREMENTS_FILE))) {
          notify.info(`No ${REQUIREMENTS_FILE} in this workspace.`);
          return;
        }
        const names = parseRequirements(await wsRead(REQUIREMENTS_FILE));
        if (!names.length) {
          notify.info(`${REQUIREMENTS_FILE} lists no installable packages.`);
          return;
        }
        const { install, skipped } = splitRequirements(names);
        if (!install.length) {
          notify.info(
            `${REQUIREMENTS_FILE} only lists notebook/Jupyter plumbing — nothing to install here.`,
          );
          return;
        }
        shell.showActivity("packages");
        const skipNote = skipped.length ? ` (skipping ${skipped.length} notebook-only package(s))` : "";
        notify.info(`Installing ${install.length} package(s) from ${REQUIREMENTS_FILE}${skipNote}…`, { timeout: 6000 });
        const r = await ensurePackages(install);
        if (r.failed.length) {
          notify.warn(`Installed ${r.installed.length}; skipped — ${failureText(r)}`, {
            timeout: 15000,
          });
        } else {
          notify.success(`Installed ${r.installed.length} package(s) from ${REQUIREMENTS_FILE}.`);
        }
      },
    },
  ]);
  onRuntimeChange(() => {
    // package progress toasts are emitted by the runtime itself
  });
}
