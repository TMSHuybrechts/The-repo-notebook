// Direct access to the Repo Notebook data directory (notebook.json +
// server.json). The desktop app, its MCP server and this plugin all share the
// same file; every writer uses the same atomic temp+rename+rolling-backup
// pattern so the store is always a complete, valid JSON document.

import * as fs from "fs";
import * as path from "path";
import type { RepoRecord, ServerInfo, Store } from "./types";
import { ALLOWED_STATUS } from "./types";

export const STORE_FILE = "notebook.json";
export const SERVER_FILE = "server.json";

/** Default data dir of the desktop app: %LOCALAPPDATA%\RepoNotebook\data. */
export const defaultDataDir = (): string => {
  const base = process.env.RN_DATA_DIR;
  if (base) return base;
  const local = process.env.LOCALAPPDATA;
  if (local) return path.join(local, "RepoNotebook", "data");
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, "RepoNotebook", "data");
};

export const storePath = (dataDir: string): string => path.join(dataDir, STORE_FILE);
export const serverInfoPath = (dataDir: string): string => path.join(dataDir, SERVER_FILE);

export const storeMtime = async (dataDir: string): Promise<number> => {
  try {
    const stat = await fs.promises.stat(storePath(dataDir));
    return stat.mtimeMs;
  } catch {
    return 0;
  }
};

export const readStore = async (dataDir: string): Promise<Store> => {
  const file = storePath(dataDir);
  try {
    const data = JSON.parse(await fs.promises.readFile(file, "utf8"));
    return { repos: Array.isArray(data.repos) ? data.repos : [] };
  } catch (error) {
    // Primary unreadable → fall back to the rolling backup, never to "empty".
    try {
      const backup = JSON.parse(await fs.promises.readFile(`${file}.bak`, "utf8"));
      if (Array.isArray(backup.repos)) return { repos: backup.repos };
    } catch {
      /* no usable backup */
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") throw new Error(`notebook.json niet gevonden in ${dataDir}`);
    throw new Error(`notebook.json is onleesbaar en er is geen bruikbare backup (${dataDir})`);
  }
};

let writeLock: Promise<unknown> = Promise.resolve();

/** Atomic write with rolling .bak — identical contract to the app server. */
export const writeStore = (dataDir: string, store: Store): Promise<void> => {
  const run = async () => {
    const file = storePath(dataDir);
    await fs.promises.mkdir(dataDir, { recursive: true });
    const payload = `${JSON.stringify(store, null, 2)}\n`;
    const tmp = `${file}.tmp-obsidian-${process.pid}`;
    await fs.promises.writeFile(tmp, payload);
    try {
      await fs.promises.copyFile(file, `${file}.bak`);
    } catch {
      /* first write — nothing to back up yet */
    }
    await fs.promises.rename(tmp, file);
  };
  writeLock = writeLock.catch(() => {}).then(run);
  return writeLock as Promise<void>;
};

export const findRepo = (store: Store, owner: string, name: string): RepoRecord | undefined =>
  store.repos.find((r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase());

export interface MetaPatch {
  status?: string;
  category?: string;
  note?: string;
}

/** Same validation as POST /api/notebook/:owner/:repo/meta in the app. */
export const sanitizeMeta = (patch: MetaPatch): Partial<RepoRecord> => {
  const out: Partial<RepoRecord> = {};
  if (typeof patch.category === "string") out.category = patch.category.trim().slice(0, 60);
  if (typeof patch.note === "string") out.note = patch.note.slice(0, 2000);
  if (typeof patch.status === "string") {
    if (!ALLOWED_STATUS.has(patch.status)) throw new Error(`Ongeldige status: ${patch.status}`);
    out.status = patch.status;
  }
  return out;
};

/** Read-modify-write one record; returns the updated record or null if absent. */
export const patchRepoMeta = async (dataDir: string, id: string, patch: MetaPatch): Promise<RepoRecord | null> => {
  const clean = sanitizeMeta(patch);
  if (!Object.keys(clean).length) return null;
  const store = await readStore(dataDir);
  let updated: RepoRecord | null = null;
  const repos = store.repos.map((repo) => {
    if (repo.id !== id) return repo;
    updated = { ...repo, ...clean };
    return updated;
  });
  if (!updated) return null;
  await writeStore(dataDir, { repos });
  return updated;
};

/** Insert or update a full record (used by the offline "add repo" path). */
export const upsertRepo = async (dataDir: string, repo: RepoRecord): Promise<{ repo: RepoRecord; existed: boolean }> => {
  let store: Store;
  try {
    store = await readStore(dataDir);
  } catch (error) {
    if (/niet gevonden/.test(String((error as Error).message))) store = { repos: [] };
    else throw error;
  }
  const i = store.repos.findIndex((item) => item.id === repo.id);
  const existed = i >= 0;
  const repos = existed
    ? store.repos.map((item, idx) => (idx === i ? { ...item, ...repo, savedAt: item.savedAt } : item))
    : [...store.repos, repo];
  await writeStore(dataDir, { repos });
  return { repo: repos.find((item) => item.id === repo.id) as RepoRecord, existed };
};

export const readServerInfo = async (dataDir: string): Promise<ServerInfo | null> => {
  try {
    const data = JSON.parse(await fs.promises.readFile(serverInfoPath(dataDir), "utf8"));
    if (data && Number.isInteger(data.port) && data.port > 0) return data as ServerInfo;
    return null;
  } catch {
    return null;
  }
};

export const dataDirExists = async (dataDir: string): Promise<boolean> => {
  try {
    await fs.promises.access(storePath(dataDir));
    return true;
  } catch {
    return false;
  }
};
