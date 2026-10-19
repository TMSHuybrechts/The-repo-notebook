// Bilingual support: message map consistency, English note rendering that
// leaves every identifier untouched, and language switches that never touch
// the user's notes region.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { localize, messages, normalizeLang, placeholders, translate } from "../src/core/i18n";
import { NOTES_END, NOTES_START, renderBase, renderIndexNote, renderRepoNote } from "../src/core/render";
import { parseExistingNote } from "../src/core/merge";
import { markRemoved, syncStoreToVault } from "../src/core/sync";
import { fsVault } from "../src/core/fs-vault";
import { splitFrontmatter } from "../src/core/yaml";
import { hashText } from "../src/core/util";
import { resolveLanguage, setLanguage, t } from "../src/lang";
import RepoNotebookPlugin from "../src/main";
import { VIEW_TYPE } from "../src/view";
import { App, FakeEl } from "./fake-obsidian";
import { sampleRepo } from "./fixtures";

(globalThis as any).window = Object.assign(globalThis as any, { open: () => 0 });

const NOW = Date.parse("2026-08-19T12:00:00Z");
const BASE_OPTIONS = {
  folder: "Repo Notebook",
  includeReadme: true,
  readmeMaxChars: 30000,
  includeRelated: true,
  includeFiles: true,
  includeVerdict: true,
  now: NOW
};
const SYNC_OPTIONS = { ...BASE_OPTIONS, maxRelated: 6, writeIndex: true, writeBase: true, serverOnline: false };

const scratch = (name: string): string => {
  const base = process.env.RN_TEST_SCRATCH || os.tmpdir();
  const dir = path.join(base, `rn-i18n-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const withLocalStorage = (value: string | null, fn: () => void): void => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const previous = (globalThis as any).localStorage;
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: (k: string) => (k === "language" ? value : null) }, configurable: true, writable: true });
  try {
    fn();
  } finally {
    if (had) Object.defineProperty(globalThis, "localStorage", { value: previous, configurable: true, writable: true });
    else delete (globalThis as any).localStorage;
  }
};

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));

test("i18n: every message keeps the same {n} placeholders in both languages", () => {
  const entries = Object.entries(messages);
  assert.ok(entries.length > 150, `message count ${entries.length}`);
  for (const [nl, en] of entries) {
    assert.ok(en.trim(), `empty English for ${nl}`);
    assert.deepEqual(placeholders(en), placeholders(nl), `placeholders differ: ${nl}`);
  }
});

test("i18n: every literal passed to t()/tr()/translate() in src exists in the map", () => {
  const re = /\b(?:t|tr|translate)\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  const missing: string[] = [];
  for (const file of sourceFiles(path.resolve("src"))) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(re)) {
      const key = JSON.parse(m[1].startsWith("'") ? `"${m[1].slice(1, -1).replace(/"/g, '\\"')}"` : m[1]);
      if (!Object.prototype.hasOwnProperty.call(messages, key)) missing.push(`${path.basename(file)}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("i18n: translate, localize and language detection", () => {
  assert.equal(translate("Bestanden ({0})", [3], "nl"), "Bestanden (3)");
  assert.equal(translate("Bestanden ({0})", [3], "en"), "Files (3)");
  assert.equal(translate("Bestanden ({0})", [3]), "Files (3)", "English is the default");
  assert.equal(translate("not a known message {0}", ["x"], "en"), "not a known message x");
  // interpolated core errors
  assert.equal(localize("notebook.json niet gevonden in C:\\data", "en"), "notebook.json not found in C:\\data");
  assert.equal(localize("GitHub gaf 500: oops: more", "en"), "GitHub returned 500: oops: more");
  assert.equal(localize("GitHub gaf 500: oops", "nl"), "GitHub gaf 500: oops");
  assert.equal(localize("something unrelated", "en"), "something unrelated");
  for (const v of ["nl", "NL", "nl-BE", "nl_NL"]) assert.equal(normalizeLang(v), "nl", v);
  for (const v of [null, undefined, "", "en", "de", "nlx"]) assert.equal(normalizeLang(v), "en", String(v));
  withLocalStorage("nl", () => assert.equal(resolveLanguage("auto"), "nl"));
  withLocalStorage(null, () => assert.equal(resolveLanguage("auto"), "en"));
  withLocalStorage("fr", () => assert.equal(resolveLanguage(undefined), "en"));
  withLocalStorage("nl", () => assert.equal(resolveLanguage("en"), "en"));
  withLocalStorage(null, () => assert.equal(resolveLanguage("nl"), "nl"));
  setLanguage("en");
  assert.equal(t("{0} nieuw", [2]), "2 new");
  setLanguage("nl");
  assert.equal(t("{0} nieuw", [2]), "2 nieuw");
  setLanguage("en");
});

test("i18n: English render translates headings but keeps markers, tags and frontmatter keys", () => {
  const repo = sampleRepo({ aiVerdict: "Yes.", aiProvider: "ollama", localPath: "C:/x", archived: true });
  const other = sampleRepo({ id: "x/y", owner: "x", name: "y", fullName: "x/y" });
  const input = {
    repo,
    related: [{ repo: other, edge: { source: repo.id, target: other.id, score: 0.5, hidden: true, sharedTopics: [], sharedTerms: ["agents"], sameCategory: true, sameOwner: false, sameLanguage: true } }],
    cluster: { id: 0, label: "ai · agents", size: 2 },
    notesRegion: "my own words",
    noteHash: "deadbeef",
    extraFrontmatter: ["rating: 5"],
    userTags: ["mine"],
    userAliases: [],
    conflictNote: "other text"
  };
  const en = renderRepoNote(input, { ...BASE_OPTIONS, readmeMaxChars: 20, lang: "en" });
  const nl = renderRepoNote(input, { ...BASE_OPTIONS, readmeMaxChars: 20, lang: "nl" });
  for (const heading of ["## Notes", "## AI verdict", "> [!tip] Is it worth trying?", "## Related repos", "> [!example]- Files (2)", "words: agents", "same category", "_hidden link_", "💾 cloned", "Archived", "**To try**", "README truncated", "differs from your vault note"]) {
    assert.ok(en.includes(heading), `English output lacks: ${heading}`);
  }
  // Body only: the frontmatter keeps Dutch tag paths such as repo/gekloond on purpose.
  const enBody = splitFrontmatter(en).body;
  for (const dutch of ["## Notities", "AI-oordeel", "moeite", "Verwante", "Bestanden", "woorden", "zelfde", "verborgen", "gekloond", "ingekort", "verschilt", "Gearchiveerd", "Te proberen"]) {
    assert.ok(!enBody.includes(dutch), `English output still contains: ${dutch}`);
  }
  assert.ok(en.includes(`${NOTES_START}\nmy own words\n${NOTES_END}`), "notes markers intact");
  // Frontmatter (keys, tag paths, values) is language-independent.
  assert.equal(splitFrontmatter(en).frontmatter, splitFrontmatter(nl).frontmatter);
  assert.match(en, /^  - repo\/taal\/python$/m);
  assert.match(en, /^  - repo\/status\/todo$/m);
  assert.match(en, /^  - repo\/gekloond$/m);
  assert.match(en, /^status: todo$/m);
  // Both languages parse back to the same user-owned state.
  assert.deepEqual(parseExistingNote(en), parseExistingNote(nl));

  const index = renderIndexNote({ repos: [repo], graph: null, serverOnline: true, removedCount: 2 }, { ...BASE_OPTIONS, lang: "en" });
  assert.match(index, /\*\*1\*\* repos · \*\*1\*\* cloned/);
  assert.match(index, /## By status\n\n### To try\n/);
  assert.match(index, /Synced 2026-08-19 12:00 · app online · 2 removed notes kept/);
  assert.match(index, /^  - repo-notebook\/index$/m);
  const base = renderBase("Repo Notebook", "en");
  assert.match(base, /displayName: Language/);
  assert.match(base, /name: To try\n {4}filters:\n {6}and:\n {8}- 'status == "todo"'/);
  assert.match(base, /file\.hasTag\("repo-notebook"\)/);
  const removed = markRemoved("---\nrepo: a/b\n---\nbody", "en");
  assert.match(removed, /^tags:\n  - repo\/verwijderd$/m);
  assert.match(removed, /> \[!warning\] No longer in Repo Notebook/);
});

test("i18n: switching the render language keeps the user's notes region intact", async () => {
  const root = scratch("switch");
  const vault = fsVault(root);
  const store = { repos: [sampleRepo({ note: "from the app" }), sampleRepo({ id: "x/agent-kit", owner: "x", name: "agent-kit", fullName: "x/agent-kit", topics: ["ai"] })] };
  const nlOptions = { ...SYNC_OPTIONS, lang: "nl" as const };
  const enOptions = { ...SYNC_OPTIONS, lang: "en" as const };
  await syncStoreToVault(store, vault, nlOptions);
  const file = path.join(root, "Repo Notebook", "browser-use", "browser-use.md");
  const other = path.join(root, "Repo Notebook", "x", "agent-kit.md");
  // User edits their notes in the vault (Dutch note).
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(`${NOTES_START}\nfrom the app\n${NOTES_END}`, `${NOTES_START}\nmijn eigen tekst\n\n- punt\n${NOTES_END}`));
  fs.writeFileSync(other, fs.readFileSync(other, "utf8").replace(`${NOTES_START}\n\n${NOTES_END}`, `${NOTES_START}\nnotitie twee\n${NOTES_END}`));
  const dutchAfterEdit = fs.readFileSync(file, "utf8");

  const toEnglish = await syncStoreToVault(store, vault, enOptions);
  assert.equal(toEnglish.conflicts.length, 0);
  assert.equal(toEnglish.skippedNoMarkers.length, 0);
  assert.equal(toEnglish.updated, 2, "every note is rewritten once after a language switch");
  const english = fs.readFileSync(file, "utf8");
  assert.match(english, /## Notes\n<!-- rn:notes -->\nmijn eigen tekst\n\n- punt\n<!-- \/rn:notes -->/);
  assert.equal(parseExistingNote(english).notesRegion, "mijn eigen tekst\n\n- punt");
  assert.equal(parseExistingNote(english).noteHash, hashText("from the app"));
  assert.equal(parseExistingNote(fs.readFileSync(other, "utf8")).notesRegion, "notitie twee");
  assert.doesNotMatch(english, /verschilt|differs/);

  const again = await syncStoreToVault(store, vault, enOptions);
  assert.equal(again.updated, 0, "stable in the new language");

  const backToDutch = await syncStoreToVault(store, vault, nlOptions);
  assert.equal(backToDutch.conflicts.length, 0);
  assert.equal(fs.readFileSync(file, "utf8"), dutchAfterEdit, "round trip nl → en → nl is lossless");
});

test("i18n: plugin follows Obsidian's language and old settings keep working", async () => {
  const dataDir = scratch("data");
  const run = async (stored: Record<string, unknown>) => {
    const plugin = new RepoNotebookPlugin(new App(scratch("vault")) as any);
    plugin.data = { dataDir, folder: "Repo Notebook", watchStore: false, ...stored };
    await plugin.onload();
    return plugin;
  };
  let plugin!: RepoNotebookPlugin;
  // Saved settings from before the language setting existed, Obsidian in English.
  await (async () => {
    delete (globalThis as any).localStorage;
    plugin = await run({});
  })();
  assert.equal(plugin.settings.language, "auto");
  assert.equal(plugin.commands["sync-all"].name, "Sync all repos to the vault");
  const view: any = plugin.views[VIEW_TYPE]({} as any);
  await view.onOpen();
  const root: FakeEl = view.contentEl;
  assert.deepEqual(root.find("rn-chip").map((c) => c.text), ["All", "To try", "Installed", "Keep", "Archive", "Cloned", "Running"]);
  // Manual override to Dutch applies to the open panel without reopening it.
  plugin.settings.language = "nl";
  plugin.applyLanguage();
  assert.deepEqual(root.find("rn-chip").map((c) => c.text), ["Alle", "Te proberen", "Geïnstalleerd", "Bevalt", "Archief", "Gekloond", "Draait"]);
  await view.onClose();
  plugin.onunload();

  // Obsidian set to Dutch → automatic picks Dutch command names.
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: (k: string) => (k === "language" ? "nl" : null) }, configurable: true, writable: true });
  try {
    plugin = await run({ language: "auto" });
    assert.equal(plugin.commands["sync-all"].name, "Synchroniseer alle repos naar de vault");
    plugin.onunload();
    plugin = await run({ language: "en" });
    assert.equal(plugin.commands["sync-all"].name, "Sync all repos to the vault");
    plugin.onunload();
    plugin = await run({ language: "bogus" });
    assert.equal(plugin.settings.language, "auto");
    plugin.onunload();
  } finally {
    delete (globalThis as any).localStorage;
  }
});
