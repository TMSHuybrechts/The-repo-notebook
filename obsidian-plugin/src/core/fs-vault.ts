// VaultLike backed by the plain file system — used by the tests and by the
// CLI export (scripts/export.mjs) so the same sync engine can write a
// "Repo Notebook" folder anywhere without Obsidian running.
import * as fs from "fs";
import * as path from "path";
import type { VaultLike } from "./sync";

export const fsVault = (root: string, busy: Set<string> = new Set()): VaultLike => {
  const abs = (p: string) => path.join(root, ...p.split("/"));
  return {
    exists: async (p) => fs.existsSync(abs(p)),
    read: async (p) => fs.promises.readFile(abs(p), "utf8"),
    create: async (p, content) => {
      await fs.promises.mkdir(path.dirname(abs(p)), { recursive: true });
      await fs.promises.writeFile(abs(p), content, "utf8");
    },
    update: async (p, fn) => {
      const current = await fs.promises.readFile(abs(p), "utf8");
      const next = fn(current);
      if (next === current) return false;
      await fs.promises.writeFile(abs(p), next, "utf8");
      return true;
    },
    mkdir: async (p) => {
      await fs.promises.mkdir(abs(p), { recursive: true });
    },
    listMarkdown: async (folder) => {
      const out: string[] = [];
      const walk = (dir: string, rel: string) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const r = `${rel}/${entry.name}`;
          if (entry.isDirectory()) walk(path.join(dir, entry.name), r);
          else if (entry.name.endsWith(".md")) out.push(r);
        }
      };
      walk(abs(folder), folder);
      return out;
    },
    isBusy: (p) => busy.has(p)
  };
};
