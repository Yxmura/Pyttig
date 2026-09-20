// Workbench shell: titlebar, activity bar, sidebar, editor area, panel, status bar.
// Other modules register views/panels/status items here.

import { icons, type IconName } from "./icons";

export interface ActivityView {
  id: string;
  title: string;
  icon: IconName;
  order?: number;
  badge?: () => string | number | null;
  render: (el: HTMLElement) => void | (() => void);
}

export interface PanelTab {
  id: string;
  title: string;
  order?: number;
  badge?: () => { text: string; kind: "err" | "warn" | "" } | null;
  render: (el: HTMLElement) => void | (() => void);
}

export interface StatusItem {
  id: string;
  side?: "left" | "right";
  order?: number;
  icon?: IconName;
  text: () => string;
  tooltip?: () => string;
  onClick?: () => void;
  cls?: () => string;
  visible?: () => boolean;
}

export interface Shell {
  root: HTMLElement;
  sidebarEl: HTMLElement;
  sideBody: HTMLElement;
  panelEl: HTMLElement;
  panelBody: HTMLElement;
  tabsEl: HTMLElement;
  crumbsEl: HTMLElement;
  editorHost: HTMLElement;
  statusLeft: HTMLElement;
  statusRight: HTMLElement;
  activityEl: HTMLElement;
  runBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  wsNameEl: HTMLElement;
  registerActivity(view: ActivityView): void;
  setActivity(id: string): void;
  /** Reveal an activity without toggling (safe to call when it's already open). */
  showActivity(id: string): void;
  toggleSidebar(): void;
  registerPanel(tab: PanelTab): void;
  setPanel(id: string | null): void;
  togglePanel(id?: string): void;
  setPanelHeight(px: number): void;
  setStatus(item: StatusItem): void;
  refreshBadges(): void;
  setWorkspaceName(name: string): void;
  setRunning(running: boolean): void;
  refresh(): void;
}

const LS_SIDE_W = "pyttig.ui.sideW";
const LS_PANEL_H = "pyttig.ui.panelH";

export function createShell(root: HTMLElement): Shell {
  root.innerHTML = `
    <div class="titlebar">
      <div class="brand"><img class="brand-logo" src="./logo.png" alt="Pyttig logo" /><span>Pyttig</span></div>
      <div class="ws-name" id="ws-name">workspace</div>
      <div class="spacer"></div>
      <button class="tb-btn primary" id="tb-run" title="Run Python file (Ctrl+Enter or F5)">${icons.play}<span>Run</span></button>
      <button class="tb-btn" id="tb-stop" title="Stop (Shift+F5)" hidden>${icons.stop}</button>
      <button class="tb-btn" id="tb-palette" title="Command palette (Ctrl+Shift+P)">${icons.command}</button>
      <button class="tb-btn" id="tb-theme" title="Toggle dark/light theme"></button>
    </div>
    <div class="workbench">
      <div class="activitybar" id="activity"></div>
      <div class="sidebar" id="sidebar">
        <div class="side-head" id="side-head">Explorer</div>
        <div class="side-body" id="side-body"></div>
      </div>
      <div class="splitter-v" id="split-side"></div>
      <div class="main-col">
        <div class="editor-wrap">
          <div class="tabs" id="tabs"></div>
          <div class="breadcrumbs" id="crumbs"></div>
          <div class="editor-host" id="editor-host"></div>
        </div>
        <div class="splitter-h" id="split-panel"></div>
        <div class="panel" id="panel">
          <div class="panel-tabs" id="panel-tabs"></div>
          <div class="panel-body" id="panel-body"></div>
        </div>
      </div>
    </div>
    <div class="statusbar">
      <div id="st-left" style="display:contents"></div>
      <div class="spacer"></div>
      <div id="st-right" style="display:contents"></div>
    </div>`;

  const $ = (id: string) => root.querySelector(`#${id}`) as HTMLElement;
  const sidebarEl = $("sidebar");
  const sideBody = $("side-body");
  const sideHead = $("side-head");
  const panelEl = $("panel");
  const tabsEl = $("tabs");

  const activities = new Map<string, ActivityView>();
  const panels = new Map<string, PanelTab>();
  const statuses: StatusItem[] = [];
  let activeActivity: string | null = null;
  let activePanel: string | null = null;
  let cleanupSide: (() => void) | null = null;
  let cleanupPanel: (() => void) | null = null;

  const shell = {
    root, sidebarEl, sideBody, panelEl,
    panelBody: $("panel-body"),
    tabsEl, crumbsEl: $("crumbs"), editorHost: $("editor-host"),
    statusLeft: $("st-left"), statusRight: $("st-right"),
    activityEl: $("activity"),
    runBtn: $("tb-run") as HTMLButtonElement,
    stopBtn: $("tb-stop") as HTMLButtonElement,
    wsNameEl: $("ws-name"),

    registerActivity(view: ActivityView) {
      const first = !activeActivity;
      activities.set(view.id, view);
      if (first) activeActivity = view.id;
      renderActivityBar();
      if (first) renderSide();
    },

    setActivity(id: string) {
      if (!activities.has(id)) return;
      if (activeActivity === id && !sidebarEl.classList.contains("hidden")) {
        sidebarEl.classList.add("hidden");
        renderActivityBar();
        return;
      }
      activeActivity = id;
      sidebarEl.classList.remove("hidden");
      renderActivityBar();
      renderSide();
    },

    showActivity(id: string) {
      if (!activities.has(id)) return;
      if (activeActivity === id && !sidebarEl.classList.contains("hidden")) return;
      activeActivity = id;
      sidebarEl.classList.remove("hidden");
      renderActivityBar();
      renderSide();
    },

    toggleSidebar() {
      sidebarEl.classList.toggle("hidden");
    },

    registerPanel(tab: PanelTab) {
      panels.set(tab.id, tab);
      renderPanelTabs();
    },

    setPanel(id: string | null) {
      activePanel = id;
      panelEl.classList.toggle("hidden", id === null);
      renderPanelTabs();
      renderPanelBody();
    },

    togglePanel(id?: string) {
      const target = id ?? activePanel ?? [...panels.keys()][0];
      if (!target) return;
      if (activePanel === target && !panelEl.classList.contains("hidden")) {
        panelEl.classList.add("hidden");
      } else {
        activePanel = target;
        panelEl.classList.remove("hidden");
      }
      renderPanelTabs();
      renderPanelBody();
    },

    setPanelHeight(px: number) {
      const clamped = Math.max(120, Math.min(window.innerHeight * 0.6, px));
      panelEl.style.height = `${clamped}px`;
      try {
        localStorage.setItem(LS_PANEL_H, String(clamped));
      } catch { /* ignore */ }
    },

    setStatus(item: StatusItem) {
      const i = statuses.findIndex((s) => s.id === item.id);
      if (i >= 0) statuses[i] = item;
      else statuses.push(item);
      renderStatus();
    },

    refreshBadges() {
      renderActivityBar();
      renderPanelTabs();
      renderStatus();
    },

    setWorkspaceName(name: string) {
      shell.wsNameEl.textContent = name;
    },

    setRunning(running: boolean) {
      shell.runBtn.disabled = running;
      shell.stopBtn.disabled = !running;
      shell.stopBtn.hidden = !running;
    },

    refresh() {
      renderActivityBar();
      renderSide();
      renderPanelTabs();
      renderPanelBody();
      renderStatus();
    },
  } as Shell;

  function renderActivityBar() {
    const bar = shell.activityEl;
    bar.innerHTML = "";
    const sorted = [...activities.values()].sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    for (const v of sorted) {
      if (v.id === "__settings__") continue;
      const b = document.createElement("button");
      b.className = `ab-btn${activeActivity === v.id && !sidebarEl.classList.contains("hidden") ? " active" : ""}`;
      b.title = v.title;
      b.innerHTML = icons[v.icon];
      const badge = v.badge?.();
      if (badge) {
        const s = document.createElement("span");
        s.className = "badge";
        s.textContent = String(badge);
        b.appendChild(s);
      }
      b.onclick = () => shell.setActivity(v.id);
      bar.appendChild(b);
    }
    const sp = document.createElement("div");
    sp.className = "ab-spacer";
    bar.appendChild(sp);
    const settings = activities.get("__settings__");
    if (settings) {
      const b = document.createElement("button");
      b.className = `ab-btn${activeActivity === "__settings__" && !sidebarEl.classList.contains("hidden") ? " active" : ""}`;
      b.title = settings.title;
      b.innerHTML = icons[settings.icon];
      b.onclick = () => shell.setActivity("__settings__");
      bar.appendChild(b);
    }
  }

  function renderSide() {
    cleanupSide?.();
    cleanupSide = null;
    sideBody.innerHTML = "";
    const v = activeActivity ? activities.get(activeActivity) : undefined;
    sideHead.textContent = v?.title ?? "";
    if (v) {
      const r = v.render(sideBody);
      if (typeof r === "function") cleanupSide = r;
    }
  }

  function renderPanelTabs() {
    const tabs = $("panel-tabs");
    tabs.innerHTML = "";
    const sorted = [...panels.values()].sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    for (const p of sorted) {
      const b = document.createElement("button");
      b.className = `panel-tab${activePanel === p.id ? " active" : ""}`;
      const label = document.createElement("span");
      label.textContent = p.title;
      b.appendChild(label);
      const badge = p.badge?.();
      if (badge) {
        const c = document.createElement("span");
        c.className = `count ${badge.kind}`;
        c.textContent = badge.text;
        b.appendChild(c);
      }
      b.onclick = () => {
        if (activePanel === p.id && !panelEl.classList.contains("hidden")) panelEl.classList.add("hidden");
        else {
          activePanel = p.id;
          panelEl.classList.remove("hidden");
        }
        renderPanelTabs();
        renderPanelBody();
      };
      tabs.appendChild(b);
    }
    const actions = document.createElement("div");
    actions.className = "panel-actions";
    const close = document.createElement("button");
    close.className = "icon-btn";
    close.title = "Hide panel (Ctrl+`)";
    close.innerHTML = icons.x;
    close.onclick = () => {
      panelEl.classList.add("hidden");
      renderPanelTabs();
    };
    actions.appendChild(close);
    tabs.appendChild(actions);
  }

  function renderPanelBody() {
    cleanupPanel?.();
    cleanupPanel = null;
    const body = shell.panelBody;
    body.innerHTML = "";
    for (const p of panels.values()) {
      const el = document.createElement("div");
      el.className = `panel-view${activePanel === p.id ? " active" : ""}`;
      el.dataset.panel = p.id;
      body.appendChild(el);
      if (activePanel === p.id) {
        const r = p.render(el);
        if (typeof r === "function") cleanupPanel = r;
      }
    }
  }

  function renderStatus() {
    const render = (host: HTMLElement, side: "left" | "right") => {
      host.innerHTML = "";
      const items = statuses
        .filter((s) => (s.side ?? "left") === side && (!s.visible || s.visible()))
        .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
      for (const s of items) {
        const el = document.createElement("span");
        el.className = `st-item ${s.cls?.() ?? ""}`;
        el.title = s.tooltip?.() ?? "";
        el.innerHTML = `${s.icon ? icons[s.icon] : ""}<span></span>`;
        (el.querySelector("span") as HTMLElement).textContent = s.text();
        if (s.onClick) el.onclick = s.onClick;
        else el.style.cursor = "default";
        host.appendChild(el);
      }
    };
    render(shell.statusLeft, "left");
    render(shell.statusRight, "right");
  }

  // Restore sizes + wire splitters.
  try {
    const w = Number(localStorage.getItem(LS_SIDE_W));
    if (w >= 170 && w <= 480) sidebarEl.style.width = `${w}px`;
    const h = Number(localStorage.getItem(LS_PANEL_H));
    if (h >= 120) panelEl.style.height = `${h}px`;
  } catch { /* ignore */ }

  const splitSide = $("split-side");
  splitSide.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarEl.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => {
      const w = Math.max(170, Math.min(480, startW + ev.clientX - startX));
      sidebarEl.style.width = `${w}px`;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      try {
        localStorage.setItem(LS_SIDE_W, String(sidebarEl.getBoundingClientRect().width));
      } catch { /* ignore */ }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  const splitPanel = $("split-panel");
  splitPanel.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panelEl.getBoundingClientRect().height;
    const move = (ev: MouseEvent) => shell.setPanelHeight(startH - (ev.clientY - startY));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  panelEl.classList.add("hidden");
  return shell;
}
