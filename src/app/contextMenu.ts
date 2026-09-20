// Custom VS Code-style context menus. One reusable implementation for the
// explorer, the editor and anywhere else that needs a right-click menu.

import { icons, type IconName } from "./icons";

export interface MenuItem {
  label?: string;
  icon?: IconName;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Renders a separator line; all other fields are ignored. */
  separator?: boolean;
  run?: () => void | Promise<void>;
}

export interface MenuPoint {
  x: number;
  y: number;
}

let cleanupCurrent: (() => void) | null = null;

export function closeContextMenu(): void {
  cleanupCurrent?.();
  cleanupCurrent = null;
}

export function isContextMenuOpen(): boolean {
  return !!cleanupCurrent;
}

export function showContextMenu(items: MenuItem[], at: MenuPoint): void {
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.setAttribute("role", "menu");
  menu.tabIndex = -1;

  const runnable: HTMLButtonElement[] = [];
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      sep.setAttribute("role", "separator");
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = `ctx-item${item.danger ? " danger" : ""}`;
    btn.setAttribute("role", "menuitem");
    btn.disabled = !!item.disabled;
    btn.innerHTML =
      `<span class="ctx-ico">${item.icon ? icons[item.icon] : ""}</span>` +
      `<span class="ctx-label"></span>` +
      (item.hint ? `<span class="ctx-hint"></span>` : "");
    (btn.querySelector(".ctx-label") as HTMLElement).textContent = item.label ?? "";
    if (item.hint) (btn.querySelector(".ctx-hint") as HTMLElement).textContent = item.hint;
    btn.addEventListener("click", () => {
      closeContextMenu();
      void item.run?.();
    });
    btn.addEventListener("mousemove", () => {
      const i = runnable.indexOf(btn);
      if (i >= 0) select(i);
    });
    menu.appendChild(btn);
    if (!item.disabled) runnable.push(btn);
  }

  document.body.appendChild(menu);

  // Clamp to the viewport.
  const rect = menu.getBoundingClientRect();
  const x = Math.max(4, Math.min(at.x, window.innerWidth - rect.width - 8));
  const y = Math.max(4, Math.min(at.y, window.innerHeight - rect.height - 8));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  let selected = -1;
  const select = (i: number) => {
    if (!runnable.length) return;
    selected = (i + runnable.length) % runnable.length;
    runnable.forEach((b, j) => b.classList.toggle("selected", j === selected));
    runnable[selected]?.scrollIntoView({ block: "nearest" });
  };
  const clearSelection = () => {
    selected = -1;
    runnable.forEach((b) => b.classList.remove("selected"));
  };
  // Like VS Code: leaving the menu with the pointer drops the highlight, so
  // keyboard navigation always starts from a known state.
  menu.addEventListener("mouseleave", clearSelection);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeContextMenu();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      select(selected === -1 ? 0 : selected + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      select(selected === -1 ? runnable.length - 1 : selected - 1);
    } else if (e.key === "Enter" && selected >= 0) {
      e.preventDefault();
      runnable[selected].click();
    }
  };
  const onPointerDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) closeContextMenu();
  };
  const onContextMenu = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) closeContextMenu();
  };
  const onClose = () => closeContextMenu();

  window.addEventListener("keydown", onKey, true);
  window.addEventListener("mousedown", onPointerDown, true);
  window.addEventListener("contextmenu", onContextMenu, true);
  window.addEventListener("blur", onClose);
  window.addEventListener("resize", onClose);
  window.addEventListener("wheel", onClose, { passive: true });

  cleanupCurrent = () => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("mousedown", onPointerDown, true);
    window.removeEventListener("contextmenu", onContextMenu, true);
    window.removeEventListener("blur", onClose);
    window.removeEventListener("resize", onClose);
    window.removeEventListener("wheel", onClose);
    menu.remove();
  };

  menu.focus();
}
