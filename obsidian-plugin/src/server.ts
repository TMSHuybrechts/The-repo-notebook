// HTTP client for the Repo Notebook server (Express, loopback only). Finds the
// live desktop-app port through <dataDir>/server.json, falls back to the
// configured URL, and exposes the endpoints the plugin drives.

import { requestUrl } from "obsidian";
import * as fs from "fs";
import { spawn } from "child_process";
import type { Graph, RepoRecord, RuntimeItem, Store } from "./core/types";
import { readServerInfo } from "./core/store";

export interface ServerConfig {
  ai: boolean;
  aiProvider: string;
  token: boolean;
}

const PROBE_TTL = 8000;

export class ServerClient {
  private cache: { url: string | null; checkedAt: number } = { url: null, checkedAt: 0 };

  constructor(
    private readonly getDataDir: () => string,
    private readonly getFallbackUrl: () => string
  ) {}

  /** Base URL of a reachable server, or null. Cached for a few seconds. */
  async discover(force = false): Promise<string | null> {
    const now = Date.now();
    if (!force && now - this.cache.checkedAt < PROBE_TTL) return this.cache.url;
    const candidates: string[] = [];
    const info = await readServerInfo(this.getDataDir());
    if (info) candidates.push(`http://127.0.0.1:${info.port}`);
    const fallback = this.getFallbackUrl();
    if (fallback && !candidates.includes(fallback)) candidates.push(fallback);
    let found: string | null = null;
    for (const url of candidates) {
      if (await this.probe(url)) {
        found = url;
        break;
      }
    }
    this.cache = { url: found, checkedAt: Date.now() };
    return found;
  }

  get lastKnownUrl(): string | null {
    return this.cache.url;
  }

  forget(): void {
    this.cache = { url: null, checkedAt: 0 };
  }

  private async probe(url: string): Promise<boolean> {
    try {
      const res = await requestUrl({ url: `${url}/api/config`, method: "GET", throw: false });
      return res.status === 200 && res.json && typeof res.json === "object" && "token" in res.json;
    } catch {
      return false;
    }
  }

  async isOnline(force = false): Promise<boolean> {
    return Boolean(await this.discover(force));
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const base = await this.discover();
    if (!base) throw new Error("Repo Notebook draait niet. Start de app (commando: 'Start de Repo Notebook-app').");
    const res = await requestUrl({
      url: `${base}${path}`,
      method,
      throw: false,
      contentType: body !== undefined ? "application/json" : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data: unknown = null;
    try {
      data = res.json;
    } catch {
      data = null;
    }
    if (res.status >= 400) {
      const message = (data as { error?: string } | null)?.error || `HTTP ${res.status}`;
      if (res.status === 403) this.forget();
      throw new Error(message);
    }
    return data as T;
  }

  private repoPath(repo: Pick<RepoRecord, "owner" | "name">): string {
    return `/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  }

  config = (): Promise<ServerConfig> => this.call("GET", "/api/config");
  notebook = (): Promise<Store> => this.call("GET", "/api/notebook");
  graph = (): Promise<Graph> => this.call("GET", "/api/graph");
  saveRepo = (url: string): Promise<{ repo: RepoRecord; existed: boolean }> => this.call("POST", "/api/notebook", { url });
  bulkSave = (text: string): Promise<{ added: string[]; existed: string[]; failed: Array<{ slug: string; error: string }> }> =>
    this.call("POST", "/api/notebook/bulk", { text });
  refresh = (repo: RepoRecord): Promise<{ repo: RepoRecord }> => this.call("POST", `${this.repoPath(repo)}/refresh`);
  setMeta = (repo: RepoRecord, meta: { status?: string; category?: string; note?: string }): Promise<{ repo: RepoRecord }> =>
    this.call("POST", `${this.repoPath(repo)}/meta`, meta);
  remove = (repo: RepoRecord): Promise<{ repos: RepoRecord[] }> => this.call("DELETE", this.repoPath(repo));
  clone = (repo: RepoRecord, method: "https" | "ssh" = "https"): Promise<{ status: string; path: string; repo: RepoRecord }> =>
    this.call("POST", `${this.repoPath(repo)}/clone`, { method });
  openLocal = (repo: RepoRecord): Promise<{ status: string; path: string }> => this.call("POST", `${this.repoPath(repo)}/open-local`);
  runtime = (repo: RepoRecord): Promise<Record<string, unknown>> => this.call("GET", `${this.repoPath(repo)}/runtime`);
  runtimes = (): Promise<{ items: RuntimeItem[] }> => this.call("GET", "/api/runtimes");
  install = (repo: RepoRecord): Promise<Record<string, unknown>> => this.call("POST", `${this.repoPath(repo)}/install`);
  start = (repo: RepoRecord): Promise<{ status?: string; url?: string; pid?: number; portWarning?: string; runtime?: { url?: string } } & Record<string, unknown>> =>
    this.call("POST", `${this.repoPath(repo)}/start`);
  stop = (repo: RepoRecord): Promise<Record<string, unknown>> => this.call("POST", `${this.repoPath(repo)}/stop`);
  log = (repo: RepoRecord): Promise<{ log: string }> => this.call("GET", `${this.repoPath(repo)}/log`);
  pull = (repo: RepoRecord): Promise<Record<string, unknown>> => this.call("POST", `${this.repoPath(repo)}/pull`);
  updates = (repo: RepoRecord): Promise<{ behind?: number } & Record<string, unknown>> => this.call("GET", `${this.repoPath(repo)}/updates`);
  deleteClone = (repo: RepoRecord): Promise<Record<string, unknown>> => this.call("POST", `${this.repoPath(repo)}/delete-clone`);
  verdict = (repo: RepoRecord, refresh = false): Promise<{ available: boolean; verdict?: string; provider?: string; cached?: boolean; reason?: string }> =>
    this.call("POST", `${this.repoPath(repo)}/verdict`, { refresh });

  /** Launch the packaged desktop app (detached) and wait until its server answers. */
  async launchApp(exePath: string, timeoutMs = 25000): Promise<string> {
    if (!exePath) throw new Error("Geen pad naar Repo Notebook.exe ingesteld (instellingen).");
    if (!fs.existsSync(exePath)) throw new Error(`Repo Notebook.exe niet gevonden: ${exePath}`);
    const child = spawn(exePath, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => {});
    child.unref();
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 700));
      const url = await this.discover(true);
      if (url) return url;
    }
    throw new Error("De app is gestart maar de server antwoordt (nog) niet.");
  }
}
