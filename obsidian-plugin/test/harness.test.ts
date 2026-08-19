// End-to-end wiring test of the plugin class against the fake `obsidian`
// module (scripts/test.mjs aliases "obsidian" → test/fake-obsidian.ts):
// onload → startup sync → side panel → open note → push meta → set status →
// offline "add repo" (real GitHub API, skipped without network).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import RepoNotebookPlugin from "../src/main";
import { VIEW_TYPE } from "../src/view";
import { App, TFile, notices, lastMenu, FakeEl } from "./fake-obsidian";
import { writeStore, readStore } from "../src/core/store";
import { sampleRepo } from "./fixtures";

// The plugin uses the renderer's window/timer globals; map them onto Node's.
export const openedUrls: string[] = [];
(globalThis as any).window = Object.assign(globalThis as any, { open: (url: string) => openedUrls.push(url) });

const scratch = (name: string): string => {
  const base = process.env.RN_TEST_SCRATCH || os.tmpdir();
  const dir = path.join(base, `rn-harness-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const until = async (cond: () => boolean, ms = 8000): Promise<void> => {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("plugin lifecycle: load → sync → panel → open → push → status → add", async (t) => {
  const vaultDir = scratch("vault");
  const dataDir = scratch("data");
  await writeStore(dataDir, {
    repos: [
      sampleRepo(),
      sampleRepo({ id: "x/agent-kit", owner: "x", name: "agent-kit", fullName: "x/agent-kit", topics: ["ai", "agents"], readme: "# Agent kit\nBuild agents." }),
      sampleRepo({ id: "y/ollama-ui", owner: "y", name: "ollama-ui", fullName: "y/ollama-ui", topics: ["llm"], language: "TypeScript", status: "keep", readme: "# Ollama UI" })
    ]
  });

  const app = new App(vaultDir);
  const plugin = new RepoNotebookPlugin(app as any);
  plugin.data = { dataDir, folder: "Repo Notebook", serverUrl: "http://127.0.0.1:1", appExePath: "", watchStore: false };
  let view: any = null;
  try {
  await plugin.onload();
  assert.ok(plugin.commands["sync-all"], "commands registered");
  assert.ok(plugin.commands["clone-current"].checkCallback(true) === false, "repo commands inactive without a repo note");
  for (const cb of app.workspace.layoutReadyCallbacks) cb();
  await until(() => Boolean(plugin.lastSyncSummary));

  assert.equal(plugin.store?.repos.length, 3);
  assert.equal(plugin.serverOnline, false);
  assert.ok(fs.existsSync(path.join(vaultDir, "Repo Notebook", "browser-use", "browser-use.md")));
  assert.ok(fs.existsSync(path.join(vaultDir, "Repo Notebook", "Repo Notebook.md")));
  assert.ok(fs.existsSync(path.join(vaultDir, "Repo Notebook", "Repos.base")));
  assert.ok(notices.some((n) => /3 repos · 3 nieuw/.test(n)), `startup notice: ${notices.join(" | ")}`);

  // Side panel
  const leaf = app.workspace.getRightLeaf(false);
  view = plugin.views[VIEW_TYPE](leaf);
  await view.onOpen();
  const root: FakeEl = view.contentEl;
  assert.equal(root.find("rn-row").length, 3);
  assert.equal(root.find("rn-letter").map((l) => l.text).join(""), "ABO");
  // search
  view.query = "ollama";
  view.renderList();
  assert.equal(root.find("rn-row").length, 1);
  view.query = "";
  view.filter = "keep";
  view.renderList();
  assert.equal(root.find("rn-row").length, 1);
  view.filter = "";
  view.renderList();
  // context menu on first row
  const repo = plugin.findRepoById("x/agent-kit")!;
  view.showMenu(repo, {} as any);
  const titles = lastMenu!.items.map((i) => i.title);
  assert.ok(titles.includes("Open note") && titles.includes("Kloon") && titles.includes("Verwijder uit Repo Notebook"), titles.join(","));

  // Open note → becomes current repo
  await plugin.openRepoNote(repo);
  assert.equal(plugin.currentRepo()?.id, "x/agent-kit");
  assert.equal(plugin.commands["clone-current"].checkCallback(true), true);

  // Push: edit status + notes in the note, then let the modify handler run
  const notePath = path.join(vaultDir, "Repo Notebook", "x", "agent-kit.md");
  let content = fs.readFileSync(notePath, "utf8");
  content = content.replace(/^status: ""$/m, "status: todo").replace(/^category: agents$/m, "category: Agents").replace("<!-- rn:notes -->\n\n<!-- /rn:notes -->", "<!-- rn:notes -->\nProberen op de Victus.\n<!-- /rn:notes -->");
  fs.writeFileSync(notePath, content, "utf8");
  const file = app.vault.getAbstractFileByPath("Repo Notebook/x/agent-kit.md") as TFile;
  await (plugin as any).pushFromFile(file);
  const stored = (await readStore(dataDir)).repos.find((r) => r.id === "x/agent-kit")!;
  assert.equal(stored.status, "todo");
  assert.equal(stored.category, "Agents");
  assert.equal(stored.note, "Proberen op de Victus.");
  // The note is active + just modified → the re-render is deferred (busy window).
  const deferred = await plugin.syncAll({ reason: "test", quiet: true });
  assert.deepEqual(deferred?.deferredIds, ["x/agent-kit"]);
  app.workspace.activeFile = null; // user moved on → the next sync may touch it
  const res = await plugin.syncAll({ reason: "test", quiet: true });
  assert.equal(res?.conflicts.length, 0);
  assert.equal(res?.updated, 1);
  const after = fs.readFileSync(notePath, "utf8");
  assert.match(after, /^status: todo$/m);
  assert.match(after, /^category: Agents$/m);
  assert.match(after, /📂 Agents/);
  assert.match(after, /  - repo\/status\/todo\n/);
  assert.doesNotMatch(after, /verschilt/);
  const again = await plugin.syncAll({ reason: "test", quiet: true });
  assert.equal(again?.updated, 0);

  // setStatus from the panel menu
  await plugin.setStatus(repo, "archive");
  assert.equal((await readStore(dataDir)).repos.find((r) => r.id === "x/agent-kit")!.status, "archive");
  assert.match(fs.readFileSync(notePath, "utf8"), /^status: archive$/m);

  // Offline add (real GitHub API) — skipped when the network is unavailable
  let online = true;
  try {
    await fetch("https://api.github.com/", { method: "HEAD" });
  } catch {
    online = false;
  }
  if (online) {
    await plugin.addRepos(["octocat/Hello-World"]);
    const store = await readStore(dataDir);
    const added = store.repos.find((r) => r.id === "octocat/hello-world");
    if (!added) {
      // rate limited — acceptable in CI-like conditions
      assert.ok(notices.some((n) => /rate limit|mislukt/.test(n)), notices.slice(-3).join(" | "));
      t.diagnostic("GitHub add skipped (rate limit)");
    } else {
      assert.equal(added.fullName, "octocat/Hello-World");
      assert.ok(fs.existsSync(path.join(vaultDir, "Repo Notebook", "octocat", "Hello-World.md")));
      assert.ok(notices.some((n) => /toegevoegd: octocat\/Hello-World/.test(n)));
    }
  } else {
    t.diagnostic("no network — GitHub add skipped");
  }

  } finally {
    await view?.onClose();
    plugin.onunload();
    for (const id of plugin.intervals) clearInterval(id);
  }
});
