// VaultLike implementation on top of Obsidian's Vault API, so the sync engine
// goes through Obsidian (metadata cache, open editors) instead of raw fs.

import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { VaultLike } from "./core/sync";

const BUSY_WINDOW_MS = 12000;

export const obsidianVault = (app: App): VaultLike => {
  const vault = app.vault;
  const fileAt = (path: string): TFile | null => {
    const f = vault.getAbstractFileByPath(normalizePath(path));
    return f instanceof TFile ? f : null;
  };
  return {
    exists: async (path) => fileAt(path) !== null,
    read: async (path) => {
      const file = fileAt(path);
      if (!file) throw new Error(`Bestaat niet: ${path}`);
      return vault.read(file);
    },
    create: async (path, content) => {
      await vault.create(normalizePath(path), content);
    },
    update: async (path, fn) => {
      const file = fileAt(path);
      if (!file) throw new Error(`Bestaat niet: ${path}`);
      // Cheap pre-check: Vault.process writes whatever the callback returns,
      // so only go through it when the content will actually change — that
      // keeps mtimes (and every other plugin's re-indexing) untouched for the
      // ~all notes that are already up to date.
      const current = await vault.read(file);
      if (fn(current) === current) return false;
      let changed = false;
      await vault.process(file, (fresh) => {
        const next = fn(fresh);
        changed = next !== fresh;
        return next;
      });
      return changed;
    },
    mkdir: async (path) => {
      const clean = normalizePath(path);
      if (vault.getAbstractFileByPath(clean)) return;
      try {
        await vault.createFolder(clean);
      } catch (error) {
        if (!/exists/i.test(String((error as Error)?.message))) throw error;
      }
    },
    listMarkdown: async (folder) => {
      const root = vault.getAbstractFileByPath(normalizePath(folder));
      if (!(root instanceof TFolder)) return [];
      const out: string[] = [];
      const walk = (dir: TFolder) => {
        for (const child of dir.children) {
          if (child instanceof TFolder) walk(child);
          else if (child instanceof TFile && child.extension === "md") out.push(child.path);
        }
      };
      walk(root);
      return out;
    },
    // A note that is open in the active editor and was modified seconds ago is
    // being worked on — leave it alone this round rather than rewriting under
    // the cursor. It gets picked up by the next sync.
    isBusy: (path) => {
      const active = app.workspace.getActiveFile();
      if (!active || active.path !== normalizePath(path)) return false;
      return Date.now() - active.stat.mtime < BUSY_WINDOW_MS;
    }
  };
};
