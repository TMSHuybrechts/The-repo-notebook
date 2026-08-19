// Side panel: the shelf inside Obsidian — search, status filters, letter
// groups, running dots, and a right-click menu with every app action.

import { ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import type RepoNotebookPlugin from "./main";
import type { RepoRecord } from "./core/types";
import { STATUS_LABELS, STATUS_ORDER } from "./core/types";
import { repoHealth, repoLetter, shortNumber, sortRepos } from "./core/util";

export const VIEW_TYPE = "repo-notebook-shelf";

type Filter = "" | "todo" | "installed" | "keep" | "archive" | "cloned" | "running";

const repoText = (repo: RepoRecord): string =>
  [repo.owner, repo.name, repo.fullName, repo.description, repo.language, repo.category, repo.note, ...(repo.topics || [])]
    .join(" ")
    .toLowerCase();

export class ShelfView extends ItemView {
  private query = "";
  private filter: Filter = "";
  private listEl!: HTMLElement;
  private footerEl!: HTMLElement;
  private statusDot!: HTMLElement;
  private countEl!: HTMLElement;
  private detach: Array<() => void> = [];

  constructor(leaf: WorkspaceLeaf, private readonly plugin: RepoNotebookPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Repo Notebook";
  }

  getIcon(): string {
    return "book-marked";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("rn-shelf");

    const header = root.createDiv({ cls: "rn-header" });
    const title = header.createDiv({ cls: "rn-title" });
    const icon = title.createSpan({ cls: "rn-title-icon" });
    setIcon(icon, "book-marked");
    title.createSpan({ text: "Repo Notebook" });
    this.countEl = title.createSpan({ cls: "rn-count" });
    this.statusDot = header.createSpan({ cls: "rn-dot", attr: { "aria-label": "app-status" } });

    const toolbar = root.createDiv({ cls: "rn-toolbar" });
    const btn = (label: string, iconName: string, tip: string, onClick: () => void) => {
      const b = toolbar.createEl("button", { cls: "rn-btn", attr: { "aria-label": tip, title: tip } });
      const i = b.createSpan({ cls: "rn-btn-icon" });
      setIcon(i, iconName);
      b.createSpan({ text: label });
      b.addEventListener("click", onClick);
      return b;
    };
    btn("Sync", "refresh-cw", "Synchroniseer notebook.json naar de vault", () => void this.plugin.syncAll({ reason: "panel" }));
    btn("Repo", "plus", "Repo toevoegen", () => this.plugin.openAddRepo());
    btn("App", "external-link", "Open de Repo Notebook-app", () => void this.plugin.openApp());

    const searchWrap = root.createDiv({ cls: "rn-search" });
    const search = searchWrap.createEl("input", { type: "search", placeholder: "Zoek repo, taal, topic, categorie…" });
    search.addEventListener("input", () => {
      this.query = search.value.trim().toLowerCase();
      this.renderList();
    });

    const chips = root.createDiv({ cls: "rn-chips" });
    const chipDefs: Array<[Filter, string]> = [["", "Alle"], ...STATUS_ORDER.map((k) => [k, STATUS_LABELS[k]] as [Filter, string]), ["cloned", "Gekloond"], ["running", "Draait"]];
    for (const [key, label] of chipDefs) {
      const chip = chips.createEl("button", { cls: "rn-chip", text: label, attr: { "data-filter": key } });
      chip.addEventListener("click", () => {
        this.filter = key;
        chips.querySelectorAll(".rn-chip").forEach((c) => c.toggleClass("is-active", c.getAttribute("data-filter") === key));
        this.renderList();
      });
      if (key === this.filter) chip.addClass("is-active");
    }

    this.listEl = root.createDiv({ cls: "rn-list" });
    this.footerEl = root.createDiv({ cls: "rn-footer" });

    const ref1 = this.plugin.events.on("store", () => this.renderList());
    const ref2 = this.plugin.events.on("runtimes", () => this.renderList());
    const ref3 = this.plugin.events.on("server", () => this.renderStatus());
    this.detach = [() => this.plugin.events.offref(ref1), () => this.plugin.events.offref(ref2), () => this.plugin.events.offref(ref3)];
    this.renderStatus();
    this.renderList();
    void this.plugin.ensureStoreLoaded();
    this.plugin.startRuntimePolling();
  }

  async onClose(): Promise<void> {
    this.detach.forEach((fn) => fn());
    this.detach = [];
    this.plugin.stopRuntimePolling();
  }

  renderStatus(): void {
    const online = this.plugin.serverOnline;
    this.statusDot.toggleClass("is-online", online);
    this.statusDot.toggleClass("is-offline", !online);
    this.statusDot.setAttribute("title", online ? `App online (${this.plugin.server.lastKnownUrl})` : "App offline — acties zoals klonen/starten hebben de app nodig");
  }

  renderList(): void {
    const repos = sortRepos(this.plugin.store?.repos || []);
    const running = this.plugin.runningIds;
    const list = this.listEl;
    list.empty();
    this.countEl.setText(repos.length ? String(repos.length) : "");

    const filtered = repos.filter((repo) => {
      if (this.query && !repoText(repo).includes(this.query)) return false;
      switch (this.filter) {
        case "cloned":
          return Boolean(repo.cloneStatus || repo.localPath);
        case "running":
          return running.has(repo.id);
        case "":
          return true;
        default:
          return repo.status === this.filter;
      }
    });

    if (!repos.length) {
      const empty = list.createDiv({ cls: "rn-empty" });
      empty.createEl("p", { text: this.plugin.storeError || "Nog geen repos geladen." });
      const b = empty.createEl("button", { cls: "rn-btn", text: "Synchroniseer" });
      b.addEventListener("click", () => void this.plugin.syncAll({ reason: "panel" }));
      this.footerEl.setText("");
      return;
    }
    if (!filtered.length) {
      list.createDiv({ cls: "rn-empty", text: "Geen repo past bij dit filter." });
    }

    let letter = "";
    for (const repo of filtered) {
      const l = repoLetter(repo);
      if (l !== letter) {
        letter = l;
        list.createDiv({ cls: "rn-letter", text: letter });
      }
      const row = list.createDiv({ cls: "rn-row" });
      const main = row.createDiv({ cls: "rn-row-main" });
      const top = main.createDiv({ cls: "rn-row-top" });
      if (running.has(repo.id)) top.createSpan({ cls: "rn-run-dot", attr: { title: "Draait" } });
      top.createSpan({ cls: "rn-name", text: repo.name });
      top.createSpan({ cls: "rn-owner", text: repo.owner });
      if (repo.stars) top.createSpan({ cls: "rn-stars", text: `★ ${shortNumber(repo.stars)}` });
      const sub = main.createDiv({ cls: "rn-row-sub" });
      const bits: string[] = [];
      if (repo.language) bits.push(repo.language);
      if (repo.status && STATUS_LABELS[repo.status]) bits.push(STATUS_LABELS[repo.status]);
      if (repo.category) bits.push(repo.category);
      const health = repoHealth(repo);
      if (health && health.key !== "active") bits.push(health.label);
      if (repo.cloneStatus || repo.localPath) bits.push("gekloond");
      sub.setText(bits.join(" · ") || repo.description?.slice(0, 80) || "");
      if (repo.status) row.addClass(`is-status-${repo.status}`);

      row.addEventListener("click", () => void this.plugin.openRepoNote(repo));
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        this.showMenu(repo, ev);
      });
      const more = row.createEl("button", { cls: "rn-more", attr: { "aria-label": "Acties" } });
      setIcon(more, "more-vertical");
      more.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.showMenu(repo, ev);
      });
    }

    const cloned = repos.filter((r) => r.cloneStatus || r.localPath).length;
    this.footerEl.setText(
      `${filtered.length}/${repos.length} repos · ${cloned} gekloond${running.size ? ` · ${running.size} draait` : ""}${this.plugin.lastSyncSummary ? ` · ${this.plugin.lastSyncSummary}` : ""}`
    );
  }

  showMenu(repo: RepoRecord, ev: MouseEvent): void {
    const menu = new Menu();
    const running = this.plugin.runningIds.has(repo.id);
    const cloned = Boolean(repo.cloneStatus || repo.localPath);
    menu.addItem((i) => i.setTitle("Open note").setIcon("file-text").onClick(() => void this.plugin.openRepoNote(repo)));
    menu.addItem((i) => i.setTitle("Open op GitHub").setIcon("github").onClick(() => window.open(repo.htmlUrl || `https://github.com/${repo.fullName}`)));
    menu.addItem((i) => i.setTitle("Open in Repo Notebook-app").setIcon("external-link").onClick(() => void this.plugin.openApp(repo)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Ververs van GitHub").setIcon("refresh-cw").onClick(() => void this.plugin.action("refresh", repo)));
    if (!cloned) menu.addItem((i) => i.setTitle("Kloon").setIcon("download").onClick(() => void this.plugin.action("clone", repo)));
    if (cloned) {
      menu.addItem((i) => i.setTitle("Installeer").setIcon("package").onClick(() => void this.plugin.action("install", repo)));
      if (running) menu.addItem((i) => i.setTitle("Stop").setIcon("square").onClick(() => void this.plugin.action("stop", repo)));
      else menu.addItem((i) => i.setTitle("Start").setIcon("play").onClick(() => void this.plugin.action("start", repo)));
      menu.addItem((i) => i.setTitle("Toon log").setIcon("scroll-text").onClick(() => void this.plugin.action("log", repo)));
      menu.addItem((i) => i.setTitle("Git pull").setIcon("git-pull-request").onClick(() => void this.plugin.action("pull", repo)));
      menu.addItem((i) => i.setTitle("Open lokale map").setIcon("folder-open").onClick(() => void this.plugin.action("open-local", repo)));
    }
    menu.addSeparator();
    for (const key of STATUS_ORDER) {
      menu.addItem((i) =>
        i
          .setTitle(`${repo.status === key ? "✓ " : ""}${STATUS_LABELS[key]}`)
          .setIcon("tag")
          .onClick(() => void this.plugin.setStatus(repo, repo.status === key ? "" : key))
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Verwijder uit Repo Notebook")
        .setIcon("trash")
        .setWarning(true)
        .onClick(() => void this.plugin.action("remove", repo))
    );
    menu.showAtMouseEvent(ev);
  }
}
