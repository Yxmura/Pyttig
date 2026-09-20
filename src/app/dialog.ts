// Promise-based modal dialogs: input / confirm / select.

export interface InputOptions {
  title: string;
  message?: string;
  value?: string;
  placeholder?: string;
  password?: boolean;
  multiline?: boolean;
  okLabel?: string;
  validate?: (v: string) => string | null;
}

export interface SelectOptions<T> {
  title: string;
  message?: string;
  items: { label: string; description?: string; value: T }[];
}

function overlay(): HTMLElement {
  const o = document.createElement("div");
  o.className = "overlay";
  o.style.paddingTop = "20vh";
  document.body.appendChild(o);
  return o;
}

export function inputDialog(opts: InputOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const o = overlay();
    const d = document.createElement("div");
    d.className = "dialog";
    d.innerHTML = `<h3></h3>${opts.message ? "<p></p>" : ""}${
      opts.multiline ? "<textarea rows=4></textarea>" : "<input />"
    }<div class="d-actions"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok></button></div>`;
    (d.querySelector("h3") as HTMLElement).textContent = opts.title;
    if (opts.message) (d.querySelector("p") as HTMLElement).textContent = opts.message;
    const field = d.querySelector("input,textarea") as HTMLInputElement | HTMLTextAreaElement;
    if (field instanceof HTMLInputElement && opts.password) field.type = "password";
    else if (field instanceof HTMLInputElement) field.type = "text";
    field.value = opts.value ?? "";
    field.placeholder = opts.placeholder ?? "";
    (d.querySelector("[data-ok]") as HTMLButtonElement).textContent = opts.okLabel ?? "OK";
    o.appendChild(d);
    const done = (v: string | null) => {
      o.remove();
      resolve(v);
    };
    (d.querySelector("[data-x]") as HTMLButtonElement).onclick = () => done(null);
    (d.querySelector("[data-ok]") as HTMLButtonElement).onclick = () => {
      if (opts.validate) {
        const err = opts.validate(field.value);
        if (err) {
          field.style.borderColor = "var(--error)";
          field.title = err;
          return;
        }
      }
      done(field.value);
    };
    o.addEventListener("mousedown", (e) => {
      if (e.target === o) done(null);
    });
    d.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !opts.multiline) (d.querySelector("[data-ok]") as HTMLButtonElement).click();
      if (e.key === "Escape") done(null);
    });
    field.focus();
    field.select();
  });
}

export function confirmDialog(title: string, message: string, okLabel = "Confirm", danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const o = overlay();
    const d = document.createElement("div");
    d.className = "dialog";
    d.innerHTML = `<h3></h3><p></p><div class="d-actions"><button class="btn" data-x>Cancel</button><button class="btn" data-ok></button></div>`;
    (d.querySelector("h3") as HTMLElement).textContent = title;
    (d.querySelector("p") as HTMLElement).textContent = message;
    const ok = d.querySelector("[data-ok]") as HTMLButtonElement;
    ok.textContent = okLabel;
    if (danger) ok.classList.add("danger");
    else ok.classList.add("primary");
    o.appendChild(d);
    const done = (v: boolean) => {
      o.remove();
      resolve(v);
    };
    (d.querySelector("[data-x]") as HTMLButtonElement).onclick = () => done(false);
    ok.onclick = () => done(true);
    o.addEventListener("mousedown", (e) => {
      if (e.target === o) done(false);
    });
    d.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(true);
      if (e.key === "Escape") done(false);
    });
    ok.focus();
  });
}

export function selectDialog<T>(opts: SelectOptions<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const o = overlay();
    const d = document.createElement("div");
    d.className = "dialog";
    d.innerHTML = `<h3></h3>${opts.message ? "<p></p>" : ""}<div class="palette-list" style="max-height:260px"></div>`;
    (d.querySelector("h3") as HTMLElement).textContent = opts.title;
    if (opts.message) (d.querySelector("p") as HTMLElement).textContent = opts.message;
    const list = d.querySelector(".palette-list") as HTMLElement;
    const done = (v: T | null) => {
      o.remove();
      resolve(v);
    };
    for (const item of opts.items) {
      const row = document.createElement("div");
      row.className = "palette-item";
      const label = document.createElement("span");
      label.textContent = item.label;
      row.appendChild(label);
      if (item.description) {
        const desc = document.createElement("span");
        desc.className = "cat";
        desc.textContent = item.description;
        row.appendChild(desc);
      }
      row.onclick = () => done(item.value);
      list.appendChild(row);
    }
    o.appendChild(d);
    d.tabIndex = -1;
    d.focus();
    o.addEventListener("mousedown", (e) => {
      if (e.target === o) done(null);
    });
    d.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(null);
    });
  });
}
