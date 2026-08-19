import { Events, MarkdownView, Notice, Plugin, TFile, TFolder, normalizePath, requestUrl } from "obsidian";
import type { RepoRecord, RuntimeItem, Store } from "./core/types";
import { ALLOWED_STATUS, STATUS_LABELS } from "./core/types";
import { dataDirExists, patchRepoMeta, readStore, storeMtime, upsertRepo, writeStore } from "./core/store";
import { fetchGitHubRepo, type JsonFetcher } from "./core/github";
import { syncStoreToVault, type SyncResult } from "./core/sync";
import { notePath } from "./core/render";
import { parseExistingNote } from "./core/merge";
import { hashText, parseRepoRef } from "./core/util";
import { splitFrontmatter, frontmatterValue } from "./core/yaml";
import { DEFAULT_SETTINGS, RepoNotebookSettingTab, resolveDataDir, type RepoNotebookSettings } from "./settings";
import { ServerClient } from "./server";
import { obsidianVault } from "./vault-adapter";
import { AddRepoModal, ConfirmModal, TextModal } from "./modals";
import { ShelfView, VIEW_TYPE } from "./view";

type ActionKind = "refresh" | "clone" | "install" | "start" | "stop" | "log" | "pull" | "open-local" | "remove";

const WATCH_INTERVAL = 4000;
const WATCH_DEBOUNCE = 1200;
const PUSH_DEBOUNCE = 1500;
const RUNTIME_POLL = 6000;
const DEFERRED_RETRY_MS = 15000;

export default class RepoNotebookPlugin extends Plugin {
  settings: RepoNotebookSettings = { ...DEFAULT_SETTINGS };
  events = new Events();
  server!: ServerClient;
  store: Store | null = null;
  storeError = "";
  serverOnline = false;
  runtimes: RuntimeItem[] = [];
  runningIds = new Set<string>();
  lastSyncSummary = "";
  pushedNoteHashes = new Map<string, string>();

  private statusBar!: HTMLElement;
  private syncing: Promise<SyncResult | null> | null = null;
  private pendingSync = false;
  private watchTimer: number | null = null;
  private watchDebounce: number | null = null;
  private lastSeenMtime = 0;
  private runtimeTimer: number | null = null;
  private pushTimers = new Map<string, number>();
  private deferredRetries = 0;
  private warnedStatus = new Set<string>();
  private timeouts = new Set<number>();
  private unloaded = false;

  // ------------------------------------------------------------ lifecycle
  async onload(): Promise<void> {
    await this.loadSettings();
    this.server = new ServerClient(
      () => this.dataDir,
      () => this.settings.serverUrl
    );

    this.registerView(VIEW_TYPE, (leaf) => new ShelfView(leaf, this));
    this.addRibbonIcon("book-marked", "Repo Notebook", () => void this.activateView());
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("rn-statusbar");
    this.statusBar.addEventListener("click", () => void this.activateView());
    this.renderStatusBar();

    this.addSettingTab(new RepoNotebookSettingTab(this.app, this));
    this.registerCommands();

    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultModify(file)));

    this.app.workspace.onLayoutReady(() => {
      void (async () => {
        await this.ensureStoreLoaded();
        await this.probeServer();
        if (this.settings.syncOnStartup) await this.syncAll({ reason: "startup", quiet: true });
        this.restartWatcher();
        this.registerInterval(window.setInterval(() => void this.probeServer(), 15000));
      })();
    });
  }

  onunload(): void {
    this.unloaded = true;
    this.stopWatcher();
    this.stopRuntimePolling();
    for (const t of this.pushTimers.values()) window.clearTimeout(t);
    for (const t of this.timeouts) window.clearTimeout(t);
    this.timeouts.clear();
  }

  /** setTimeout that is cancelled on unload. */
  private later(fn: () => void, ms: number): void {
    if (this.unloaded) return;
    const id = window.setTimeout(() => {
      this.timeouts.delete(id);
      if (!this.unloaded) fn();
    }, ms);
    this.timeouts.add(id);
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) || {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  get dataDir(): string {
    return resolveDataDir(this.settings);
  }

  // ------------------------------------------------------------ commands
  private registerCommands(): void {
    this.addCommand({ id: "open-shelf", name: "Open het zijpaneel (plank)", callback: () => void this.activateView() });
    this.addCommand({ id: "sync-all", name: "Synchroniseer alle repos naar de vault", callback: () => void this.syncAll({ reason: "command" }) });
    this.addCommand({ id: "add-repo", name: "Repo toevoegen (URL of tekst met links)", callback: () => this.openAddRepo() });
    this.addCommand({
      id: "add-repo-from-clipboard",
      name: "Repo toevoegen vanaf klembord",
      callback: async () => {
        const text = await navigator.clipboard.readText().catch(() => "");
        this.openAddRepo(text);
      }
    });
    this.addCommand({ id: "open-app", name: "Open de Repo Notebook-app", callback: () => void this.openApp(this.currentRepo() || undefined) });
    this.addCommand({ id: "start-app", name: "Start de Repo Notebook-app", callback: () => void this.startApp() });
    this.addCommand({ id: "open-index", name: "Open de indexnote", callback: () => void this.openIndex() });

    const repoCommand = (id: string, name: string, run: (repo: RepoRecord) => void | Promise<void>) =>
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const repo = this.currentRepo();
          if (!repo) return false;
          if (!checking) void run(repo);
          return true;
        }
      });
    repoCommand("open-github", "Huidige repo: open op GitHub", (repo) => {
      window.open(repo.htmlUrl || `https://github.com/${repo.fullName}`);
    });
    repoCommand("refresh-current", "Huidige repo: ververs van GitHub", (repo) => this.action("refresh", repo));
    repoCommand("clone-current", "Huidige repo: kloon", (repo) => this.action("clone", repo));
    repoCommand("install-current", "Huidige repo: installeer", (repo) => this.action("install", repo));
    repoCommand("start-current", "Huidige repo: start", (repo) => this.action("start", repo));
    repoCommand("stop-current", "Huidige repo: stop", (repo) => this.action("stop", repo));
    repoCommand("log-current", "Huidige repo: toon log", (repo) => this.action("log", repo));
    repoCommand("pull-current", "Huidige repo: git pull", (repo) => this.action("pull", repo));
    repoCommand("open-local-current", "Huidige repo: open lokale map", (repo) => this.action("open-local", repo));
    repoCommand("push-current", "Huidige repo: stuur status/categorie/notities naar de app", (repo) => this.pushNoteMeta(repo, true));
    repoCommand("resync-current", "Huidige repo: hersynchroniseer deze note", async (repo) => {
      await this.syncAll({ reason: "command", onlyIds: new Set([repo.id]) });
    });
    repoCommand("remove-current", "Huidige repo: verwijder uit Repo Notebook", (repo) => this.action("remove", repo));
  }

  // ------------------------------------------------------------ store
  async ensureStoreLoaded(force = false): Promise<Store | null> {
    if (this.store && !force) return this.store;
    return this.reloadStore();
  }

  async reloadStore(): Promise<Store | null> {
    try {
      this.store = await readStore(this.dataDir);
      this.storeError = "";
    } catch (error) {
      // Data dir unreadable — the running app can still hand us the store.
      try {
        if (await this.server.isOnline()) {
          this.store = await this.server.notebook();
          this.storeError = "";
        } else {
          this.storeError = (error as Error).message;
        }
      } catch (inner) {
        this.storeError = `${(error as Error).message} · ${(inner as Error).message}`;
      }
    }
    this.events.trigger("store");
    this.renderStatusBar();
    return this.store;
  }

  findRepoById(id: string): RepoRecord | undefined {
    return this.store?.repos.find((r) => r.id === id);
  }

  /** The repo behind the active note, if it is one of ours. */
  currentRepo(): RepoRecord | null {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return null;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const ref = fm?.repo as string | undefined;
    if (!ref || typeof ref !== "string") return null;
    if (!file.path.startsWith(`${this.settings.folder}/`)) return null;
    return this.findRepoById(ref.toLowerCase()) || null;
  }

  // ------------------------------------------------------------ sync
  private syncOptions(extra: { onlyIds?: Set<string> }) {
    const s = this.settings;
    return {
      folder: s.folder,
      includeReadme: s.includeReadme,
      readmeMaxChars: s.readmeMaxChars,
      includeRelated: s.includeRelated,
      maxRelated: s.maxRelated,
      includeFiles: s.includeFiles,
      includeVerdict: s.includeVerdict,
      writeIndex: s.writeIndex,
      writeBase: s.writeBase,
      now: Date.now(),
      serverOnline: this.serverOnline,
      pushedNoteHashes: this.pushedNoteHashes,
      onlyIds: extra.onlyIds
    };
  }

  async syncAll(opts: { reason: string; onlyIds?: Set<string>; quiet?: boolean } = { reason: "manual" }): Promise<SyncResult | null> {
    if (this.unloaded) return null;
    if (this.syncing) {
      this.pendingSync = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        // mtime is taken BEFORE the read: a write that lands during the render
        // then still looks new to the watcher instead of being marked "seen".
        const mtimeAtRead = await storeMtime(this.dataDir);
        const store = await this.reloadStore();
        if (!store) {
          new Notice(`Repo Notebook: ${this.storeError || "geen data gevonden"}`, 7000);
          return null;
        }
        const result = await syncStoreToVault(store, obsidianVault(this.app), this.syncOptions({ onlyIds: opts.onlyIds }));
        if (this.unloaded) return result;
        this.lastSeenMtime = mtimeAtRead;
        if (!opts.onlyIds) {
          this.settings.lastSyncedMtime = this.lastSeenMtime;
          await this.saveSettings();
        }
        const parts = [`${result.created} nieuw`, `${result.updated} bijgewerkt`, `${result.unchanged} ongewijzigd`];
        if (result.deferred.length) parts.push(`${result.deferred.length} uitgesteld (in bewerking)`);
        if (result.skippedNoMarkers.length) parts.push(`${result.skippedNoMarkers.length} overgeslagen (markers weg)`);
        if (result.conflicts.length) parts.push(`${result.conflicts.length} notitie-conflict`);
        if (result.removedMarked) parts.push(`${result.removedMarked} als verwijderd gemarkeerd`);
        this.lastSyncSummary = `sync ${new Date().toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" })}`;
        const changed = result.created + result.updated + result.removedMarked > 0;
        if (!opts.quiet || changed || result.conflicts.length || result.skippedNoMarkers.length) {
          new Notice(`Repo Notebook · ${result.total} repos · ${parts.join(" · ")} (${result.durationMs} ms)`, changed ? 6000 : 3500);
        }
        if (result.skippedNoMarkers.length) {
          console.warn("[repo-notebook] notes zonder rn:notes-markers, niet overschreven:", result.skippedNoMarkers);
        }
        this.events.trigger("store");
        this.renderStatusBar();
        // Notes that were being edited are retried once the busy window has passed.
        if (result.deferredIds.length && this.deferredRetries < 5) {
          this.deferredRetries++;
          const ids = new Set(result.deferredIds);
          this.later(() => void this.syncAll({ reason: "deferred", onlyIds: ids, quiet: true }), DEFERRED_RETRY_MS);
        } else if (!result.deferredIds.length) {
          this.deferredRetries = 0;
        }
        return result;
      } catch (error) {
        console.error("[repo-notebook] sync failed", error);
        new Notice(`Repo Notebook sync mislukt: ${(error as Error).message}`, 8000);
        return null;
      } finally {
        this.syncing = null;
        if (this.pendingSync && !this.unloaded) {
          this.pendingSync = false;
          this.later(() => void this.syncAll({ reason: "pending", quiet: true }), 250);
        }
      }
    })();
    return this.syncing;
  }

  // ------------------------------------------------------------ watcher
  restartWatcher(): void {
    this.stopWatcher();
    if (!this.settings.watchStore) return;
    this.watchTimer = window.setInterval(() => void this.checkStore(), WATCH_INTERVAL);
    this.registerInterval(this.watchTimer);
  }

  private stopWatcher(): void {
    if (this.watchTimer) window.clearInterval(this.watchTimer);
    if (this.watchDebounce) window.clearTimeout(this.watchDebounce);
    this.watchTimer = null;
    this.watchDebounce = null;
  }

  private async checkStore(): Promise<void> {
    const mtime = await storeMtime(this.dataDir);
    if (!mtime || mtime === this.lastSeenMtime) return;
    if (!this.lastSeenMtime) {
      this.lastSeenMtime = mtime;
      return;
    }
    this.lastSeenMtime = mtime;
    if (this.watchDebounce) window.clearTimeout(this.watchDebounce);
    this.watchDebounce = window.setTimeout(() => void this.syncAll({ reason: "watch", quiet: true }), WATCH_DEBOUNCE);
  }

  // ------------------------------------------------------------ server
  async probeServer(): Promise<boolean> {
    const online = await this.server.isOnline(true);
    if (online !== this.serverOnline) {
      this.serverOnline = online;
      this.events.trigger("server");
      this.renderStatusBar();
      if (online) void this.pollRuntimes();
      else {
        this.runtimes = [];
        this.runningIds = new Set();
        this.events.trigger("runtimes");
      }
    }
    return online;
  }

  startRuntimePolling(): void {
    if (this.runtimeTimer) return;
    void this.pollRuntimes();
    this.runtimeTimer = window.setInterval(() => void this.pollRuntimes(), RUNTIME_POLL);
    this.registerInterval(this.runtimeTimer);
  }

  stopRuntimePolling(): void {
    if (this.runtimeTimer) window.clearInterval(this.runtimeTimer);
    this.runtimeTimer = null;
  }

  private async pollRuntimes(): Promise<void> {
    if (!this.serverOnline) return;
    try {
      const { items } = await this.server.runtimes();
      this.runtimes = items;
      const next = new Set(items.filter((i) => i.running).map((i) => i.id));
      const changed = next.size !== this.runningIds.size || [...next].some((id) => !this.runningIds.has(id));
      this.runningIds = next;
      if (changed) this.events.trigger("runtimes");
    } catch {
      /* server went away; the next probe flips the flag */
    }
  }

  async testConnection(): Promise<string> {
    const lines: string[] = [];
    const dir = this.dataDir;
    lines.push((await dataDirExists(dir)) ? `✓ notebook.json gevonden in ${dir}` : `✗ geen notebook.json in ${dir}`);
    const url = await this.server.discover(true);
    lines.push(url ? `✓ app online op ${url}` : "○ app offline (lezen werkt, acties niet)");
    try {
      const store = await readStore(dir);
      lines.push(`✓ ${store.repos.length} repos`);
    } catch (error) {
      lines.push(`✗ ${(error as Error).message}`);
    }
    return lines.join("\n");
  }

  async startApp(): Promise<void> {
    if (await this.server.isOnline(true)) {
      new Notice("Repo Notebook draait al.");
      return;
    }
    const notice = new Notice("Repo Notebook starten…", 0);
    try {
      const url = await this.server.launchApp(this.settings.appExePath);
      notice.hide();
      new Notice(`Repo Notebook online op ${url}`);
      await this.probeServer();
    } catch (error) {
      notice.hide();
      new Notice(`Starten mislukt: ${(error as Error).message}`, 8000);
    }
  }

  async openApp(repo?: RepoRecord): Promise<void> {
    const url = await this.server.discover();
    if (!url) {
      await this.startApp();
      return;
    }
    const hash = repo ? `#repo=${encodeURIComponent(repo.fullName)}` : "";
    window.open(`${url}/${hash}`);
  }

  // ------------------------------------------------------------ notes
  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async openRepoNote(repo: RepoRecord): Promise<void> {
    const path = normalizePath(notePath(this.settings.folder, repo));
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      await this.syncAll({ reason: "open", onlyIds: new Set([repo.id]), quiet: true });
      file = this.app.vault.getAbstractFileByPath(path);
    }
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    else new Notice(`Note voor ${repo.fullName} kon niet gemaakt worden.`);
  }

  async openIndex(): Promise<void> {
    const path = normalizePath(`${this.settings.folder}/${this.settings.folder.split("/").pop()}.md`);
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      await this.syncAll({ reason: "open-index", quiet: true });
      file = this.app.vault.getAbstractFileByPath(path);
    }
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
  }

  openAddRepo(initial = ""): void {
    const seed = initial && (parseRepoRef(initial.trim()) || /github\.com\//.test(initial)) ? initial.trim() : "";
    new AddRepoModal(this.app, seed, (refs) => this.addRepos(refs)).open();
  }

  private get githubFetcher(): JsonFetcher {
    return async (url, headers) => {
      const res = await requestUrl({ url, headers, throw: false });
      let json: unknown = null;
      try {
        json = res.json;
      } catch {
        json = null;
      }
      return { status: res.status, json, text: res.text };
    };
  }

  async addRepos(refs: string[]): Promise<void> {
    if (!refs.length) return;
    const notice = new Notice(`${refs.length === 1 ? refs[0] : `${refs.length} repos`} toevoegen…`, 0);
    const added: string[] = [];
    const existed: string[] = [];
    const failed: string[] = [];
    try {
      const online = await this.server.isOnline();
      if (online && refs.length > 1) {
        const result = await this.server.bulkSave(refs.map((r) => `https://github.com/${r}`).join("\n"));
        added.push(...result.added);
        existed.push(...result.existed);
        failed.push(...result.failed.map((f) => `${f.slug}: ${f.error}`));
      } else {
        for (const ref of refs) {
          const parsed = parseRepoRef(ref);
          if (!parsed) {
            failed.push(ref);
            continue;
          }
          try {
            if (online) {
              const result = await this.server.saveRepo(`https://github.com/${parsed.owner}/${parsed.name}`);
              (result.existed ? existed : added).push(result.repo.fullName);
            } else {
              const record = await fetchGitHubRepo(parsed.owner, parsed.name, this.githubFetcher, {
                token: this.settings.githubToken.trim() || process.env.GITHUB_TOKEN
              });
              const result = await upsertRepo(this.dataDir, record);
              (result.existed ? existed : added).push(result.repo.fullName);
            }
          } catch (error) {
            failed.push(`${ref}: ${(error as Error).message}`);
          }
        }
      }
    } finally {
      notice.hide();
    }
    const ids = new Set([...added, ...existed].map((n) => n.toLowerCase()));
    // Full sync: a new repo shifts the graph (IDF, clusters) of its neighbours too.
    if (ids.size) await this.syncAll({ reason: "add", quiet: true });
    const summary = [
      added.length ? `toegevoegd: ${added.join(", ")}` : "",
      existed.length ? `stond er al (bijgewerkt): ${existed.join(", ")}` : "",
      failed.length ? `mislukt: ${failed.join("; ")}` : ""
    ]
      .filter(Boolean)
      .join(" · ");
    new Notice(`Repo Notebook — ${summary || "niets gedaan"}`, failed.length ? 9000 : 5000);
    if (this.settings.openNoteAfterAdd && ids.size === 1) {
      const repo = this.findRepoById([...ids][0]);
      if (repo) await this.openRepoNote(repo);
    }
  }

  /**
   * Write status/category/note for a repo: through the running app when it is
   * online (one writer at a time), straight into notebook.json otherwise
   * (same atomic pattern the app and the MCP server use).
   */
  async applyMeta(repo: RepoRecord, patch: { status?: string; category?: string; note?: string }): Promise<RepoRecord | null> {
    if (await this.server.isOnline()) {
      const { repo: updated } = await this.server.setMeta(repo, patch);
      return updated;
    }
    return patchRepoMeta(this.dataDir, repo.id, patch);
  }

  async setStatus(repo: RepoRecord, status: string): Promise<void> {
    try {
      await this.applyMeta(repo, { status });
      new Notice(`${repo.fullName}: ${status ? STATUS_LABELS[status] : "status gewist"}`);
      await this.syncAll({ reason: "status", quiet: true });
    } catch (error) {
      new Notice(`Status zetten mislukt: ${(error as Error).message}`, 6000);
    }
  }

  // ------------------------------------------------------------ actions via the app
  async action(kind: ActionKind, repo: RepoRecord): Promise<void> {
    if (kind === "remove") {
      new ConfirmModal(
        this.app,
        "Verwijderen uit Repo Notebook",
        `${repo.fullName} verdwijnt uit de app. De note in je vault blijft staan (gemarkeerd als verwijderd).`,
        "Verwijder",
        () => this.runAction(kind, repo)
      ).open();
      return;
    }
    await this.runAction(kind, repo);
  }

  private async runAction(kind: ActionKind, repo: RepoRecord): Promise<void> {
    const labels: Record<ActionKind, string> = {
      refresh: "verversen",
      clone: "klonen",
      install: "installeren",
      start: "starten",
      stop: "stoppen",
      log: "log ophalen",
      pull: "git pull",
      "open-local": "map openen",
      remove: "verwijderen"
    };
    if (!(await this.server.isOnline())) {
      if (kind === "remove") {
        // Removing is a pure store edit — works without the app, same atomic write.
        try {
          const store = await readStore(this.dataDir);
          await writeStore(this.dataDir, { repos: store.repos.filter((r) => r.id !== repo.id) });
          new Notice(`${repo.fullName} verwijderd uit Repo Notebook.`);
          await this.syncAll({ reason: "remove", quiet: true });
        } catch (error) {
          new Notice(`${repo.fullName}: verwijderen mislukt — ${(error as Error).message}`, 8000);
        }
        return;
      }
      new Notice(`Voor ${labels[kind]} moet de Repo Notebook-app draaien. Start ze met het commando 'Start de Repo Notebook-app'.`, 7000);
      return;
    }
    const notice = kind === "log" ? null : new Notice(`${repo.fullName}: ${labels[kind]}…`, 0);
    try {
      switch (kind) {
        case "refresh":
          await this.server.refresh(repo);
          break;
        case "clone": {
          const r = await this.server.clone(repo);
          new Notice(r.status === "exists" ? `Stond al lokaal: ${r.path}` : `Gekloond naar ${r.path}`, 6000);
          break;
        }
        case "install":
          await this.server.install(repo);
          new Notice(`${repo.fullName}: installatie gestart — volg de log in de app of via 'toon log'.`, 6000);
          break;
        case "start": {
          const r = await this.server.start(repo);
          const url = r.runtime?.url || r.url;
          new Notice(`${repo.fullName}: ${r.status === "running" ? "draait al" : "gestart"}${url ? ` — ${url}` : ""}${r.portWarning ? `\n${r.portWarning}` : ""}`, 7000);
          break;
        }
        case "stop":
          await this.server.stop(repo);
          new Notice(`${repo.fullName}: gestopt.`);
          break;
        case "log": {
          const { log } = await this.server.log(repo);
          new TextModal(this.app, `Log — ${repo.fullName}`, log, async () => (await this.server.log(repo)).log).open();
          break;
        }
        case "pull": {
          const r = await this.server.pull(repo);
          new Notice(`${repo.fullName}: pull klaar${typeof r.output === "string" ? `\n${String(r.output).slice(-200)}` : ""}`, 6000);
          break;
        }
        case "open-local":
          await this.server.openLocal(repo);
          break;
        case "remove":
          await this.server.remove(repo);
          new Notice(`${repo.fullName} verwijderd uit Repo Notebook.`);
          break;
      }
      if (kind !== "log" && kind !== "open-local") {
        await this.syncAll({ reason: kind, quiet: true });
        void this.pollRuntimes();
      }
    } catch (error) {
      new Notice(`${repo.fullName}: ${labels[kind]} mislukt — ${(error as Error).message}`, 8000);
    } finally {
      notice?.hide();
    }
  }

  // ------------------------------------------------------------ vault → app (push)
  private onVaultModify(file: unknown): void {
    if (!this.settings.pushMeta) return;
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (!file.path.startsWith(`${this.settings.folder}/`)) return;
    const existing = this.pushTimers.get(file.path);
    if (existing) window.clearTimeout(existing);
    this.pushTimers.set(
      file.path,
      window.setTimeout(() => {
        this.pushTimers.delete(file.path);
        void this.pushFromFile(file);
      }, PUSH_DEBOUNCE)
    );
  }

  private async pushFromFile(file: TFile): Promise<void> {
    const content = await this.app.vault.read(file).catch(() => "");
    const { frontmatter } = splitFrontmatter(content);
    if (frontmatter === null) return;
    const ref = frontmatterValue(frontmatter, "repo");
    if (!ref) return;
    if ((frontmatterValue(frontmatter, "rn_removed") || "").toLowerCase() === "true") return;
    const repo = this.findRepoById(ref.toLowerCase()) || (await this.reloadStore())?.repos.find((r) => r.id === ref.toLowerCase());
    if (!repo) return;
    await this.pushNoteMeta(repo, false, content);
  }

  /** Send status/category/notes of the note to the app store when they differ. */
  async pushNoteMeta(repo: RepoRecord, explicit: boolean, content?: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(notePath(this.settings.folder, repo)));
    if (!(file instanceof TFile)) return;
    const text = content ?? (await this.app.vault.read(file));
    const parsed = parseExistingNote(text);
    const patch: { status?: string; category?: string; note?: string } = {};
    const status = parsed.status.trim().toLowerCase();
    if (status !== String(repo.status || "")) {
      if (ALLOWED_STATUS.has(status)) patch.status = status;
      else if (!this.warnedStatus.has(`${repo.id}:${status}`)) {
        this.warnedStatus.add(`${repo.id}:${status}`);
        new Notice(`${repo.fullName}: status "${parsed.status}" kent de app niet — gebruik todo, installed, keep, archive of leeg.`, 7000);
      }
    }
    if (parsed.category !== String(repo.category || "")) patch.category = parsed.category;
    if (parsed.notesRegion !== null) {
      const vaultNote = parsed.notesRegion.trim();
      const appNote = String(repo.note || "").trim();
      const appHash = hashText(String(repo.note || ""));
      // Only push the note text when the app side didn't change since our last sync
      // (otherwise the sync will merge / flag a conflict first).
      const appUnchanged = appHash === parsed.noteHash || this.pushedNoteHashes.get(repo.id) === appHash || (!parsed.noteHash && !appNote);
      if (vaultNote !== appNote && (appUnchanged || explicit)) patch.note = parsed.notesRegion.trim();
    }
    if (!Object.keys(patch).length) {
      if (explicit) new Notice(`${repo.fullName}: note en app zijn al gelijk.`);
      return;
    }
    try {
      const updated = await this.applyMeta(repo, patch);
      if (!updated) return;
      if (patch.note !== undefined) this.pushedNoteHashes.set(repo.id, hashText(updated.note || ""));
      if (this.store) this.store.repos = this.store.repos.map((r) => (r.id === repo.id ? updated : r));
      const what = Object.keys(patch)
        .map((k) => ({ status: "status", category: "categorie", note: "notities" })[k as keyof typeof patch])
        .join(", ");
      new Notice(`${repo.fullName}: ${what} → Repo Notebook`, 3000);
      this.events.trigger("store");
      // Re-render this note so its hash/frontmatter reflect the pushed state.
      await this.syncAll({ reason: "push", quiet: true });
    } catch (error) {
      new Notice(`${repo.fullName}: terugschrijven mislukt — ${(error as Error).message}`, 8000);
    }
  }

  // ------------------------------------------------------------ status bar
  renderStatusBar(): void {
    const n = this.store?.repos.length ?? 0;
    this.statusBar.empty();
    this.statusBar.createSpan({ text: `RN ${n}` });
    const dot = this.statusBar.createSpan({ cls: `rn-dot ${this.serverOnline ? "is-online" : "is-offline"}` });
    dot.setAttribute("title", this.serverOnline ? "Repo Notebook-app online" : "Repo Notebook-app offline");
    this.statusBar.setAttribute("aria-label", `Repo Notebook: ${n} repos, app ${this.serverOnline ? "online" : "offline"}`);
  }

  /** Used by the view to resolve a folder for the current vault layout. */
  folderExists(): boolean {
    return this.app.vault.getAbstractFileByPath(normalizePath(this.settings.folder)) instanceof TFolder;
  }

  activeMarkdownView(): MarkdownView | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }
}
