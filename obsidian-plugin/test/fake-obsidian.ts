// A deliberately small stand-in for the `obsidian` module so main.ts / view.ts
// can be exercised in Node (scripts/test.mjs aliases "obsidian" to this file
// for the harness test). Only the surface the plugin touches is implemented.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from "fs";
import * as path from "path";

export const normalizePath = (p: string): string => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");

export const notices: string[] = [];
export class Notice {
  constructor(message: string, _timeout?: number) {
    notices.push(String(message));
  }
  hide(): void {}
  setMessage(): this {
    return this;
  }
}

export class FakeEl {
  children: FakeEl[] = [];
  text = "";
  classes = new Set<string>();
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(ev: any) => void>> = {};
  value = "";
  rows = 0;
  constructor(public tag = "div", opts?: any) {
    if (opts) {
      if (typeof opts === "string") this.addClass(opts);
      if (opts.cls) String(opts.cls).split(/\s+/).forEach((c: string) => c && this.classes.add(c));
      if (opts.text) this.text = String(opts.text);
      if (opts.attr) Object.assign(this.attrs, opts.attr);
      if (opts.type) this.attrs.type = opts.type;
      if (opts.placeholder) this.attrs.placeholder = opts.placeholder;
    }
  }
  createDiv(opts?: any): FakeEl {
    return this.append(new FakeEl("div", opts));
  }
  createSpan(opts?: any): FakeEl {
    return this.append(new FakeEl("span", opts));
  }
  createEl(tag: string, opts?: any): FakeEl {
    return this.append(new FakeEl(tag, opts));
  }
  append(el: FakeEl): FakeEl {
    this.children.push(el);
    return el;
  }
  empty(): void {
    this.children = [];
    this.text = "";
  }
  setText(t: string): void {
    this.text = String(t);
  }
  addClass(...c: string[]): void {
    c.forEach((x) => x.split(/\s+/).forEach((y) => y && this.classes.add(y)));
  }
  removeClass(...c: string[]): void {
    c.forEach((x) => this.classes.delete(x));
  }
  toggleClass(c: string, on: boolean): void {
    on ? this.classes.add(c) : this.classes.delete(c);
  }
  hasClass(c: string): boolean {
    return this.classes.has(c);
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  addEventListener(name: string, fn: (ev: any) => void): void {
    (this.listeners[name] ||= []).push(fn);
  }
  click(): void {
    (this.listeners.click || []).forEach((fn) => fn({ preventDefault() {}, stopPropagation() {} }));
  }
  querySelectorAll(selector: string): FakeEl[] {
    const cls = selector.replace(/^\./, "");
    const out: FakeEl[] = [];
    const walk = (el: FakeEl) => {
      for (const c of el.children) {
        if (c.classes.has(cls)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  find(cls: string): FakeEl[] {
    return this.querySelectorAll(`.${cls}`);
  }
  allText(): string {
    return [this.text, ...this.children.map((c) => c.allText())].filter(Boolean).join(" ");
  }
  focus(): void {}
  get scrollHeight(): number {
    return 0;
  }
  set scrollTop(_v: number) {}
}

export const setIcon = (_el: FakeEl, _icon: string): void => {};

export class Events {
  private handlers = new Map<string, Set<(...a: any[]) => any>>();
  on(name: string, cb: (...a: any[]) => any): any {
    (this.handlers.get(name) || this.handlers.set(name, new Set()).get(name)!).add(cb);
    return { name, cb };
  }
  offref(ref: any): void {
    this.handlers.get(ref.name)?.delete(ref.cb);
  }
  off(name: string, cb: any): void {
    this.handlers.get(name)?.delete(cb);
  }
  trigger(name: string, ...data: any[]): void {
    for (const cb of this.handlers.get(name) || []) cb(...data);
  }
}

export class TAbstractFile {
  constructor(public path: string) {}
  get name(): string {
    return this.path.split("/").pop() || "";
  }
}
export class TFile extends TAbstractFile {
  get extension(): string {
    return this.name.includes(".") ? this.name.split(".").pop()! : "";
  }
  get basename(): string {
    return this.name.replace(/\.[^.]+$/, "");
  }
  stat = { mtime: 0, ctime: 0, size: 0 };
}
export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

/** Disk-backed vault rooted at a folder. */
export class Vault extends Events {
  constructor(public root: string) {
    super();
  }
  abs(p: string): string {
    return path.join(this.root, ...normalizePath(p).split("/"));
  }
  getAbstractFileByPath(p: string): TAbstractFile | null {
    const a = this.abs(p);
    if (!fs.existsSync(a)) return null;
    if (fs.statSync(a).isDirectory()) {
      const folder = new TFolder(normalizePath(p));
      for (const name of fs.readdirSync(a)) {
        const child = this.getAbstractFileByPath(`${normalizePath(p)}/${name}`);
        if (child) folder.children.push(child);
      }
      return folder;
    }
    const file = new TFile(normalizePath(p));
    file.stat.mtime = fs.statSync(a).mtimeMs;
    return file;
  }
  async read(file: TFile): Promise<string> {
    return fs.promises.readFile(this.abs(file.path), "utf8");
  }
  async create(p: string, content: string): Promise<TFile> {
    const a = this.abs(p);
    if (fs.existsSync(a)) throw new Error("File already exists.");
    await fs.promises.mkdir(path.dirname(a), { recursive: true });
    await fs.promises.writeFile(a, content, "utf8");
    const file = new TFile(normalizePath(p));
    this.trigger("create", file);
    return file;
  }
  async modify(file: TFile, content: string): Promise<void> {
    await fs.promises.writeFile(this.abs(file.path), content, "utf8");
    this.trigger("modify", file);
  }
  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const current = await this.read(file);
    const next = fn(current);
    if (next !== current) await this.modify(file, next);
    return next;
  }
  async createFolder(p: string): Promise<void> {
    const a = this.abs(p);
    if (fs.existsSync(a)) throw new Error("Folder already exists.");
    await fs.promises.mkdir(a, { recursive: true });
  }
}

export class MetadataCache {
  constructor(private vault: Vault) {}
  getFileCache(file: TFile): any {
    try {
      const text = fs.readFileSync(this.vault.abs(file.path), "utf8");
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      if (!m) return {};
      const frontmatter: Record<string, any> = {};
      for (const line of m[1].split(/\r?\n/)) {
        const kv = /^([^\s:][^:]*):\s*(.*)$/.exec(line);
        if (kv) frontmatter[kv[1]] = kv[2].replace(/^"|"$/g, "");
      }
      return { frontmatter };
    } catch {
      return null;
    }
  }
}

export class WorkspaceLeaf {
  view: any = null;
  openedFiles: TFile[] = [];
  async setViewState(state: any): Promise<void> {
    this.viewState = state;
  }
  viewState: any = null;
  async openFile(file: TFile): Promise<void> {
    this.openedFiles.push(file);
    this.workspace.activeFile = file;
  }
  constructor(public workspace: Workspace) {}
}

export class Workspace extends Events {
  activeFile: TFile | null = null;
  leaves: WorkspaceLeaf[] = [];
  layoutReadyCallbacks: Array<() => void> = [];
  onLayoutReady(cb: () => void): void {
    this.layoutReadyCallbacks.push(cb);
  }
  getActiveFile(): TFile | null {
    return this.activeFile;
  }
  getLeavesOfType(_type: string): WorkspaceLeaf[] {
    return this.leaves.filter((l) => l.viewState?.type === _type);
  }
  getRightLeaf(_split: boolean): WorkspaceLeaf {
    const leaf = new WorkspaceLeaf(this);
    this.leaves.push(leaf);
    return leaf;
  }
  getLeaf(_new?: boolean): WorkspaceLeaf {
    const leaf = new WorkspaceLeaf(this);
    this.leaves.push(leaf);
    return leaf;
  }
  async revealLeaf(_leaf: WorkspaceLeaf): Promise<void> {}
  getActiveViewOfType(_t: any): any {
    return null;
  }
}

export class App {
  vault: Vault;
  metadataCache: MetadataCache;
  workspace = new Workspace();
  constructor(root: string) {
    this.vault = new Vault(root);
    this.metadataCache = new MetadataCache(this.vault);
  }
}

export class Plugin {
  commands: Record<string, any> = {};
  views: Record<string, (leaf: WorkspaceLeaf) => any> = {};
  ribbons: Array<{ icon: string; title: string; cb: () => void }> = [];
  data: any = null;
  intervals: number[] = [];
  constructor(public app: App, public manifest: any = { id: "repo-notebook", version: "test" }) {}
  addCommand(cmd: any): any {
    this.commands[cmd.id] = cmd;
    return cmd;
  }
  registerView(type: string, factory: (leaf: WorkspaceLeaf) => any): void {
    this.views[type] = factory;
  }
  addRibbonIcon(icon: string, title: string, cb: () => void): FakeEl {
    this.ribbons.push({ icon, title, cb });
    return new FakeEl("div");
  }
  addStatusBarItem(): FakeEl {
    return new FakeEl("div");
  }
  addSettingTab(_tab: any): void {}
  registerEvent(_ref: any): void {}
  registerInterval(id: number): number {
    this.intervals.push(id);
    return id;
  }
  async loadData(): Promise<any> {
    return this.data;
  }
  async saveData(data: any): Promise<void> {
    this.data = data;
  }
}

export class ItemView {
  contentEl = new FakeEl("div");
  constructor(public leaf: WorkspaceLeaf) {}
}

export class Modal {
  contentEl = new FakeEl("div");
  opened = false;
  constructor(public app: App) {}
  open(): void {
    this.opened = true;
    (this as any).onOpen?.();
  }
  close(): void {
    this.opened = false;
    (this as any).onClose?.();
  }
}

export class PluginSettingTab {
  containerEl = new FakeEl("div");
  constructor(public app: App, public plugin: any) {}
}

export class Setting {
  settingEl: FakeEl;
  constructor(container: FakeEl) {
    this.settingEl = container.createDiv({ cls: "setting-item" });
  }
  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
  setHeading(): this {
    return this;
  }
  addText(cb: (t: any) => void): this {
    cb(new TextComponent());
    return this;
  }
  addTextArea(cb: (t: any) => void): this {
    cb(new TextAreaComponent());
    return this;
  }
  addToggle(cb: (t: any) => void): this {
    cb({ setValue: () => ({ onChange: () => {} }) });
    return this;
  }
  addSlider(cb: (t: any) => void): this {
    const s: any = { setLimits: () => s, setValue: () => s, setDynamicTooltip: () => s, onChange: () => s };
    cb(s);
    return this;
  }
  addButton(cb: (b: any) => void): this {
    const b: any = { setButtonText: () => b, setCta: () => b, setWarning: () => b, onClick: () => b };
    cb(b);
    return this;
  }
  addExtraButton(cb: (b: any) => void): this {
    const b: any = { setIcon: () => b, setTooltip: () => b, onClick: () => b };
    cb(b);
    return this;
  }
}

export class TextComponent {
  inputEl = new FakeEl("input");
  setPlaceholder(): this {
    return this;
  }
  setValue(v: string): this {
    this.inputEl.value = v;
    return this;
  }
  onChange(): this {
    return this;
  }
}
export class TextAreaComponent extends TextComponent {}

export class Menu {
  items: Array<{ title: string; onClick: () => void }> = [];
  addItem(cb: (item: any) => void): this {
    const entry = { title: "", onClick: () => {} };
    const item: any = {
      setTitle: (t: string) => ((entry.title = t), item),
      setIcon: () => item,
      setWarning: () => item,
      onClick: (fn: () => void) => ((entry.onClick = fn), item)
    };
    cb(item);
    this.items.push(entry);
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtMouseEvent(_ev: any): void {
    lastMenu = this;
  }
}
export let lastMenu: Menu | null = null;

export class MarkdownView {}

/** Real HTTP through Node's fetch, shaped like Obsidian's requestUrl. */
export const requestUrl = async (req: any): Promise<any> => {
  const r = typeof req === "string" ? { url: req } : req;
  const res = await fetch(r.url, {
    method: r.method || "GET",
    headers: { ...(r.headers || {}), ...(r.contentType ? { "Content-Type": r.contentType } : {}) },
    body: r.body
  });
  const text = await res.text();
  let json: any = undefined;
  const out = {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    text,
    arrayBuffer: new ArrayBuffer(0),
    get json() {
      if (json === undefined) json = JSON.parse(text);
      return json;
    }
  };
  if (res.status >= 400 && r.throw !== false) throw new Error(`Request failed, status ${res.status}`);
  return out;
};
