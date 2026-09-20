// Toast notifications (bottom-right), VS Code style.

import { icons } from "./icons";

export type ToastKind = "info" | "success" | "error" | "warn";

export interface ToastAction {
  label: string;
  run: () => void;
  primary?: boolean;
}

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (!host) {
    host = document.createElement("div");
    host.className = "toasts";
    host.setAttribute("role", "status");
    document.body.appendChild(host);
  }
  return host;
}

export function toast(
  message: string,
  kind: ToastKind = "info",
  opts: { actions?: ToastAction[]; timeout?: number } = {},
): () => void {
  const el = document.createElement("div");
  el.className = "toast";
  const icon =
    kind === "success" ? icons.check : kind === "error" ? icons.alertCircle : kind === "warn" ? icons.alertTriangle : icons.info;
  el.innerHTML = `<span class="t-ico ${kind}">${icon}</span><div class="t-body"><div class="t-msg"></div><div class="t-actions" style="display:none"></div></div><button class="t-close" aria-label="Dismiss">${icons.x}</button>`;
  (el.querySelector(".t-msg") as HTMLElement).textContent = message;
  const actionsEl = el.querySelector(".t-actions") as HTMLElement;
  if (opts.actions?.length) {
    actionsEl.style.display = "flex";
    for (const a of opts.actions) {
      const b = document.createElement("button");
      b.className = `btn${a.primary ? " primary" : ""}`;
      b.textContent = a.label;
      b.onclick = () => {
        dismiss();
        a.run();
      };
      actionsEl.appendChild(b);
    }
  }
  let timer: number | undefined;
  const dismiss = () => {
    window.clearTimeout(timer);
    el.remove();
  };
  (el.querySelector(".t-close") as HTMLButtonElement).onclick = dismiss;
  ensureHost().appendChild(el);
  timer = window.setTimeout(dismiss, opts.timeout ?? (opts.actions?.length ? 12000 : 5000));
  return dismiss;
}

export const notify = {
  info: (m: string, o?: { actions?: ToastAction[]; timeout?: number }) => toast(m, "info", o),
  success: (m: string, o?: { actions?: ToastAction[]; timeout?: number }) => toast(m, "success", o),
  error: (m: string, o?: { actions?: ToastAction[]; timeout?: number }) => toast(m, "error", o),
  warn: (m: string, o?: { actions?: ToastAction[]; timeout?: number }) => toast(m, "warn", o),
};
