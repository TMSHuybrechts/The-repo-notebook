import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { syncStoreToVault, markRemoved } from "../src/core/sync";
import { fsVault } from "../src/core/fs-vault";
import { readStore, writeStore, patchRepoMeta, upsertRepo, readServerInfo, storeMtime } from "../src/core/store";
import { hashText } from "../src/core/util";
import { NOTES_END, NOTES_START } from "../src/core/render";
import { sampleRepo } from "./fixtures";
import type { Store } from "../src/core/types";

const NOW = Date.parse("2026-08-19T12:00:00Z");

const scratch = (name: string): string => {
  const base = process.env.RN_TEST_SCRATCH || os.tmpdir();
  const dir = path.join(base, `rn-obsidian-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const OPTIONS = {
  folder: "Repo Notebook",
  includeReadme: true,
  readmeMaxChars: 30000,
  includeRelated: true,
  includeFiles: true,
  includeVerdict: true,
  now: NOW,
  maxRelated: 6,
  writeIndex: true,
  writeBase: true,
  serverOnline: false
};

const storeOf = (): Store => ({
  repos: [
    sampleRepo(),
    sampleRepo({ id: "x/agent-kit", owner: "x", name: "agent-kit", fullName: "x/agent-kit", topics: ["ai", "agents"], readme: "# Agent kit\nBuild agents for the browser." }),
    sampleRepo({ id: "y/ollama-ui", owner: "y", name: "ollama-ui", fullName: "y/ollama-ui", topics: ["llm", "ollama"], language: "TypeScript", readme: "# Ollama UI\nChat with local llm models.", status: "keep" })
  ]
});

test("sync creates notes, index and base; second run is a no-op", async () => {
  const root = scratch("sync");
  const vault = fsVault(root);
  const first = await syncStoreToVault(storeOf(), vault, OPTIONS);
  assert.equal(first.created, 3);
  assert.equal(first.updated, 0);
  assert.ok(fs.existsSync(path.join(root, "Repo Notebook", "browser-use", "browser-use.md")));
  assert.ok(fs.existsSync(path.join(root, "Repo Notebook", "Repo Notebook.md")));
  assert.ok(fs.existsSync(path.join(root, "Repo Notebook", "Repos.base")));
  const note = fs.readFileSync(path.join(root, "Repo Notebook", "x", "agent-kit.md"), "utf8");
  assert.match(note, /## Verwante repos\n- \[\[Repo Notebook\/browser-use\/browser-use\|browser-use\/browser-use\]\]/);

  const second = await syncStoreToVault(storeOf(), vault, OPTIONS);
  assert.equal(second.created, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 3);
  assert.equal(second.graph.nodes.length, 3);
});

test("sync preserves user notes, custom frontmatter, tags and aliases", async () => {
  const root = scratch("preserve");
  const vault = fsVault(root);
  await syncStoreToVault(storeOf(), vault, OPTIONS);
  const file = path.join(root, "Repo Notebook", "browser-use", "browser-use.md");
  let content = fs.readFileSync(file, "utf8");
  content = content
    .replace("---\nrepo:", "---\nrating: 5\nreview:\n  - solid\n  - fast\nrepo:")
    .replace(`${NOTES_START}\n\n${NOTES_END}`, `${NOTES_START}\nMijn eigen notitie\n- met lijst\n${NOTES_END}`)
    .replace("tags:\n", "tags:\n  - mijn-tag\n")
    .replace("aliases:\n", "aliases:\n  - BU\n");
  fs.writeFileSync(file, content, "utf8");

  const store = storeOf();
  store.repos[0].stars = 70000; // app-side change forces a rewrite
  const result = await syncStoreToVault(store, vault, OPTIONS);
  assert.equal(result.updated, 1);
  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /^rating: 5$/m);
  assert.match(after, /^review:\n  - solid\n  - fast$/m);
  assert.match(after, /^stars: 70000$/m);
  assert.match(after, /  - mijn-tag\n/);
  assert.match(after, /  - BU\n/);
  assert.match(after, new RegExp(`${NOTES_START}\\nMijn eigen notitie\\n- met lijst\\n${NOTES_END}`));
  assert.equal((after.match(/repo-notebook\n/g) || []).length, 1);
});

test("sync: app note flows into untouched vault region, conflict when both changed", async () => {
  const root = scratch("notes");
  const vault = fsVault(root);
  const store = storeOf();
  store.repos[1].note = "app v1";
  await syncStoreToVault(store, vault, OPTIONS);
  const file = path.join(root, "Repo Notebook", "x", "agent-kit.md");
  assert.match(fs.readFileSync(file, "utf8"), /<!-- rn:notes -->\napp v1\n<!-- \/rn:notes -->/);

  store.repos[1].note = "app v2";
  await syncStoreToVault(store, vault, OPTIONS);
  assert.match(fs.readFileSync(file, "utf8"), /<!-- rn:notes -->\napp v2\n<!-- \/rn:notes -->/);

  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("app v2\n<!-- /rn:notes -->", "vault v3\n<!-- /rn:notes -->"), "utf8");
  store.repos[1].note = "app v4";
  const r = await syncStoreToVault(store, vault, OPTIONS);
  const after = fs.readFileSync(file, "utf8");
  assert.equal(r.conflicts.length, 1);
  assert.match(after, /<!-- rn:notes -->\nvault v3\n<!-- \/rn:notes -->/);
  assert.match(after, /\[!warning\] Notitie in de Repo Notebook-app verschilt[\s\S]*> app v4/);

  // A note we pushed ourselves is not a conflict.
  store.repos[1].note = "vault v3";
  const pushed = new Map([["x/agent-kit", hashText("vault v3")]]);
  const r2 = await syncStoreToVault(store, vault, { ...OPTIONS, pushedNoteHashes: pushed });
  assert.equal(r2.conflicts.length, 0);
  const settled = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(settled, /verschilt/);
  assert.match(settled, new RegExp(`rn_note_hash: "?${hashText("vault v3")}"?`));
});

test("sync skips notes without markers and defers busy notes", async () => {
  const root = scratch("skip");
  const busy = new Set<string>();
  const vault = fsVault(root, busy);
  await syncStoreToVault(storeOf(), vault, OPTIONS);
  const file = path.join(root, "Repo Notebook", "y", "ollama-ui.md");
  fs.writeFileSync(file, "---\nrepo: y/ollama-ui\nrn_note_hash: abc\n---\nuser removed the markers", "utf8");
  busy.add("Repo Notebook/x/agent-kit.md");
  const store = storeOf();
  store.repos.forEach((r) => (r.stars = 1));
  const r = await syncStoreToVault(store, vault, OPTIONS);
  assert.deepEqual(r.skippedNoMarkers, ["Repo Notebook/y/ollama-ui.md"]);
  assert.deepEqual(r.deferred, ["Repo Notebook/x/agent-kit.md"]);
  assert.equal(fs.readFileSync(file, "utf8"), "---\nrepo: y/ollama-ui\nrn_note_hash: abc\n---\nuser removed the markers");
});

test("sync marks notes whose repo vanished and keeps them", async () => {
  const root = scratch("removed");
  const vault = fsVault(root);
  await syncStoreToVault(storeOf(), vault, OPTIONS);
  const store = storeOf();
  store.repos = store.repos.filter((r) => r.id !== "y/ollama-ui");
  const r = await syncStoreToVault(store, vault, OPTIONS);
  assert.equal(r.removedMarked, 1);
  const content = fs.readFileSync(path.join(root, "Repo Notebook", "y", "ollama-ui.md"), "utf8");
  assert.match(content, /^rn_removed: true$/m);
  assert.match(content, /  - repo\/verwijderd\n/);
  assert.match(content, /> \[!warning\] Niet meer in Repo Notebook/);
  const again = await syncStoreToVault(store, vault, OPTIONS);
  assert.equal(again.removedMarked, 0);
  assert.match(fs.readFileSync(path.join(root, "Repo Notebook", "Repo Notebook.md"), "utf8"), /1 verwijderde notes bewaard/);
});

test("markRemoved handles inline tags and missing tags", () => {
  assert.match(markRemoved("---\ntags: [a]\nrepo: x/y\n---\nbody"), /^tags: \[a, repo\/verwijderd\]$/m);
  assert.match(markRemoved("---\ntag: [a]\nrepo: x/y\n---\nbody"), /^tag: \[a, repo\/verwijderd\]$/m);
  assert.match(markRemoved("---\nrepo: x/y\n---\nbody"), /^tags:\n  - repo\/verwijderd$/m);
  const once = markRemoved("---\nrepo: x/y\n---\nbody");
  assert.equal(markRemoved(once), once);
});

test("onlyIds limits writes but still refreshes the index", async () => {
  const root = scratch("only");
  const vault = fsVault(root);
  await syncStoreToVault(storeOf(), vault, OPTIONS);
  const store = storeOf();
  store.repos.forEach((r) => (r.stars = 9));
  const r = await syncStoreToVault(store, vault, { ...OPTIONS, onlyIds: new Set(["x/agent-kit"]) });
  assert.equal(r.updated, 1);
  assert.equal(r.unchanged, 0);
  assert.match(fs.readFileSync(path.join(root, "Repo Notebook", "browser-use", "browser-use.md"), "utf8"), /^stars: 61234$/m);
});

test("store: read/write/patch/upsert are atomic with backup", async () => {
  const dir = scratch("store");
  await writeStore(dir, storeOf());
  assert.ok(fs.existsSync(path.join(dir, "notebook.json")));
  const mtime = await storeMtime(dir);
  assert.ok(mtime > 0);
  const loaded = await readStore(dir);
  assert.equal(loaded.repos.length, 3);

  const patched = await patchRepoMeta(dir, "x/agent-kit", { status: "keep", category: "  Agents  ", note: "n".repeat(3000) });
  assert.equal(patched?.status, "keep");
  assert.equal(patched?.category, "Agents");
  assert.equal(patched?.note?.length, 2000);
  assert.ok(fs.existsSync(path.join(dir, "notebook.json.bak")));
  await assert.rejects(patchRepoMeta(dir, "x/agent-kit", { status: "bogus" }), /Ongeldige status/);
  assert.equal(await patchRepoMeta(dir, "nope/nope", { status: "keep" }), null);

  const { existed } = await upsertRepo(dir, sampleRepo({ id: "new/one", owner: "new", name: "one", fullName: "new/one" }));
  assert.equal(existed, false);
  const { existed: again } = await upsertRepo(dir, sampleRepo({ id: "new/one", owner: "new", name: "one", fullName: "new/one", stars: 1 }));
  assert.equal(again, true);
  assert.equal((await readStore(dir)).repos.length, 4);

  // Corrupt primary → backup wins, never empty.
  fs.writeFileSync(path.join(dir, "notebook.json"), "{corrupt", "utf8");
  const recovered = await readStore(dir);
  assert.ok(recovered.repos.length >= 3);

  assert.equal(await readServerInfo(dir), null);
  fs.writeFileSync(path.join(dir, "server.json"), JSON.stringify({ port: 5188, pid: 1, startedAt: "x" }), "utf8");
  assert.equal((await readServerInfo(dir))?.port, 5188);
  await assert.rejects(readStore(path.join(dir, "missing")), /niet gevonden/);
});
