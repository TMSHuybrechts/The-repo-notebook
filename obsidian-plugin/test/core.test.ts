import { test } from "node:test";
import assert from "node:assert/strict";
import { yamlString, yamlEntries, splitFrontmatterEntries, frontmatterValue, splitFrontmatter } from "../src/core/yaml";
import { slugify, safeSegment, hashText, repoHealth, parseRepoRef, extractRepoRefs, shortNumber, isoDate } from "../src/core/util";
import { normalizeReadme } from "../src/core/readme";
import { mergeNotes, parseExistingNote, readList } from "../src/core/merge";
import { renderRepoNote, renderIndexNote, repoTags, notePath, linkTo, NOTES_START, NOTES_END, renderBase } from "../src/core/render";
import { recordFromMeta } from "../src/core/github";
import { sampleRepo } from "./fixtures";

const NOW = Date.parse("2026-08-19T12:00:00Z");

const OPTIONS = {
  folder: "Repo Notebook",
  includeReadme: true,
  readmeMaxChars: 30000,
  includeRelated: true,
  includeFiles: true,
  includeVerdict: true,
  now: NOW
};

test("yamlString quotes only when needed", () => {
  assert.equal(yamlString("browser-use"), "browser-use");
  assert.equal(yamlString("Make websites accessible"), "Make websites accessible");
  assert.equal(yamlString("https://x.y/z"), '"https://x.y/z"');
  assert.equal(yamlString("2048"), '"2048"');
  assert.equal(yamlString("true"), '"true"');
  assert.equal(yamlString("a: b"), '"a: b"');
  assert.equal(yamlString('say "hi"'), '"say \\"hi\\""');
  assert.equal(yamlString("2026-08-19"), "2026-08-19");
  assert.equal(yamlString(""), '""');
  assert.equal(yamlString("- dash"), '"- dash"');
});

test("yamlEntries renders lists and scalars", () => {
  const lines = yamlEntries([
    ["stars", 12],
    ["archived", false],
    ["topics", ["ai", "c++"]],
    ["empty", []],
    ["name", "x"]
  ]);
  assert.deepEqual(lines, ["stars: 12", "archived: false", "topics:", "  - ai", '  - "c++"', "empty: []", "name: x"]);
});

test("splitFrontmatterEntries keeps multi-line entries verbatim", () => {
  const raw = 'title: Hi\ntags:\n  - a\n  - b\nrating: 5\nnested:\n  key: value';
  const entries = splitFrontmatterEntries(raw);
  assert.deepEqual(entries.map((e) => e.key), ["title", "tags", "rating", "nested"]);
  assert.equal(entries[1].text, "tags:\n  - a\n  - b");
  assert.equal(frontmatterValue(raw, "rating"), "5");
  assert.equal(frontmatterValue(raw, "missing"), undefined);
});

test("splitFrontmatter handles CRLF and missing frontmatter", () => {
  assert.deepEqual(splitFrontmatter("---\r\na: 1\r\n---\r\nbody"), { frontmatter: "a: 1", body: "body" });
  assert.deepEqual(splitFrontmatter("plain"), { frontmatter: null, body: "plain" });
});

test("util helpers", () => {
  assert.equal(slugify("C++"), "cpp");
  assert.equal(slugify("Jupyter Notebook"), "jupyter");
  assert.equal(slugify("ai · agents"), "ai-agents");
  assert.equal(slugify("  LLM / RAG  "), "llm-rag");
  assert.equal(safeSegment("con"), "con_");
  assert.equal(safeSegment("a:b*c"), "a-b-c");
  assert.equal(safeSegment("name."), "name");
  assert.equal(hashText("x"), hashText("x"));
  assert.notEqual(hashText("x"), hashText("y"));
  assert.equal(hashText("").length, 8);
  assert.equal(repoHealth(sampleRepo(), NOW)?.key, "active");
  assert.equal(repoHealth(sampleRepo({ pushedAt: "2026-01-01T00:00:00Z" }), NOW)?.key, "quiet");
  assert.equal(repoHealth(sampleRepo({ pushedAt: "2024-01-01T00:00:00Z" }), NOW)?.key, "stale");
  assert.equal(repoHealth(sampleRepo({ archived: true }), NOW)?.key, "archived");
  assert.deepEqual(parseRepoRef("https://github.com/a/b.git"), { owner: "a", name: "b" });
  assert.deepEqual(parseRepoRef("a/b"), { owner: "a", name: "b" });
  assert.deepEqual(parseRepoRef("git@github.com:a/b.git"), { owner: "a", name: "b" });
  assert.equal(parseRepoRef("https://gitlab.com/a/b"), null);
  assert.equal(parseRepoRef("nonsense"), null);
  assert.deepEqual(extractRepoRefs("see github.com/a/b and https://github.com/c/d.git, plus github.com/a/b again"), ["a/b", "c/d"]);
  assert.equal(shortNumber(61234), "61.2k");
  assert.equal(shortNumber(999), "999");
  assert.equal(isoDate("2026-08-10T10:00:00Z"), "2026-08-10");
  assert.equal(isoDate("nope"), "");
});

test("normalizeReadme shifts headings, rewrites relative links, escapes tags", () => {
  const out = normalizeReadme(sampleRepo().readme!, { owner: "o", name: "n", branch: "main", maxChars: 0 });
  assert.match(out, /^### Browser Use/m);
  assert.match(out, /\[docs\]\(https:\/\/github\.com\/o\/n\/blob\/main\/docs\/index\.md\)/);
  assert.match(out, /!\[logo\]\(https:\/\/raw\.githubusercontent\.com\/o\/n\/main\/static\/logo\.png\)/);
  assert.match(out, /# not a heading/); // untouched inside fence
  assert.doesNotMatch(out, /^### not a heading/m);
  assert.match(out, /Try \\#hashtag/);
  assert.match(out, /\\\[\[wiki\]\]/);
});

test("normalizeReadme converts setext headings and truncates", () => {
  const out = normalizeReadme("Title\n=====\n\nSub\n---\n\ntext", { owner: "o", name: "n", branch: "dev", maxChars: 0 });
  assert.match(out, /^### Title/m);
  assert.match(out, /^#### Sub/m);
  const short = normalizeReadme("a".repeat(100), { owner: "o", name: "n", branch: "dev", maxChars: 10 });
  assert.match(short, /README ingekort/);
  assert.match(short, /blob\/dev\/README\.md/);
});

test("normalizeReadme: inline ```code``` spans are not fences; fences close on matching marker", () => {
  const src = "Run ```pip install x``` first.\n\n# After\n\n````md\n```\ninner\n```\n````\n\n# Tail #tag";
  const out = normalizeReadme(src, { owner: "o", name: "n", branch: "main", maxChars: 0 });
  assert.match(out, /^### After$/m);
  assert.match(out, /^### Tail \\#tag$/m);
  assert.match(out, /````md\n```\ninner\n```\n````/);
});

test("normalizeReadme rewrites html img/a and leaves absolute urls", () => {
  const out = normalizeReadme('<p><img src="./img/a.png"><a href="CONTRIBUTING.md">x</a><a href="https://x.y">y</a></p>', {
    owner: "o",
    name: "n",
    branch: "main",
    maxChars: 0
  });
  assert.match(out, /src="https:\/\/raw\.githubusercontent\.com\/o\/n\/main\/img\/a\.png"/);
  assert.match(out, /href="https:\/\/github\.com\/o\/n\/blob\/main\/CONTRIBUTING\.md"/);
  assert.match(out, /href="https:\/\/x\.y"/);
});

test("readList handles block and inline lists", () => {
  assert.deepEqual(readList("tags:\n  - a\n  - b"), ["a", "b"]);
  assert.deepEqual(readList("tags: [a, b]"), ["a", "b"]);
  assert.deepEqual(readList('tags: ["x y", z]'), ["x y", "z"]);
  assert.deepEqual(readList("tags: single"), ["single"]);
  assert.deepEqual(readList("tags: []"), []);
});

test("mergeNotes: vault wins, app flows in when vault untouched, conflict otherwise", () => {
  const h = hashText;
  // fresh note
  assert.deepEqual(mergeNotes("app", null, "", h), { region: "app", hash: h("app") });
  // in sync
  assert.deepEqual(mergeNotes("same", "same", h("same"), h), { region: "same", hash: h("same") });
  // vault edited, app unchanged → keep vault
  assert.deepEqual(mergeNotes("old", "mine", h("old"), h), { region: "mine", hash: h("old") });
  // app edited, vault untouched → take app
  assert.deepEqual(mergeNotes("new", "old", h("old"), h), { region: "new", hash: h("new") });
  // app edited, vault empty → take app
  assert.deepEqual(mergeNotes("new", "", h("old"), h), { region: "new", hash: h("new") });
  // both edited → keep vault, surface conflict
  const r = mergeNotes("theirs", "mine", h("old"), h);
  assert.equal(r.region, "mine");
  assert.equal(r.conflict, "theirs");
  assert.equal(r.hash, h("old"));
  // legacy note without hash, app empty → keep vault
  assert.deepEqual(mergeNotes("", "mine", "", h), { region: "mine", hash: h("") });
});

test("renderRepoNote produces frontmatter, markers and related links", () => {
  const repo = sampleRepo();
  const other = sampleRepo({ id: "x/y", owner: "x", name: "y", fullName: "x/y" });
  const content = renderRepoNote(
    {
      repo,
      related: [
        {
          repo: other,
          edge: { source: repo.id, target: other.id, score: 0.42, hidden: true, sharedTopics: [], sharedTerms: ["agents", "browser"], sameCategory: false, sameOwner: false, sameLanguage: true }
        }
      ],
      cluster: { id: 0, label: "ai · agents", size: 3 },
      notesRegion: "my thoughts",
      noteHash: "deadbeef",
      extraFrontmatter: ["rating: 5"],
      userTags: ["mine", "repo/status/todo"],
      userAliases: ["BU"]
    },
    OPTIONS
  );
  assert.ok(content.startsWith("---\nrating: 5\nrepo: browser-use/browser-use\n"));
  assert.match(content, /^stars: 61234$/m);
  assert.match(content, /^health: active$/m);
  assert.match(content, /^cluster: "ai · agents"$/m);
  assert.match(content, /^tags:\n(  - .*\n)*  - repo\/cluster\/ai-agents\n/m);
  assert.match(content, /  - mine\n/);
  assert.equal((content.match(/repo\/status\/todo/g) || []).length, 1, "own tag not duplicated");
  assert.match(content, /^aliases:\n  - browser-use\/browser-use\n  - BU$/m);
  assert.match(content, /^rn_note_hash: deadbeef$/m);
  assert.match(content, new RegExp(`## Notities\\n${NOTES_START}\\nmy thoughts\\n${NOTES_END}`));
  assert.match(content, /## Verwante repos\n- \[\[Repo Notebook\/x\/y\|x\/y\]\] — woorden: agents, browser · _verborgen link_ · score 0\.42/);
  assert.match(content, /## README\n<!-- rn:readme -->\n### Browser Use/);
  assert.match(content, /> \[!example\]- Bestanden \(2\)\n> `src\/` · `README.md`/);
  assert.doesNotMatch(content, /rn_synced/);
});

test("render → parse → render is stable (idempotent)", () => {
  const repo = sampleRepo({ note: "from app" });
  const first = renderRepoNote(
    { repo, related: [], cluster: null, notesRegion: "from app", noteHash: hashText("from app"), extraFrontmatter: [], userTags: [], userAliases: [] },
    OPTIONS
  );
  const parsed = parseExistingNote(first);
  assert.equal(parsed.notesRegion, "from app");
  assert.equal(parsed.noteHash, hashText("from app"));
  assert.deepEqual(parsed.extraFrontmatter, []);
  assert.deepEqual(parsed.userTags, []);
  assert.deepEqual(parsed.userAliases, ["browser-use/browser-use"]); // own alias, filtered again on render
  assert.equal(parsed.status, "todo");
  assert.equal(parsed.category, "agents");
  const second = renderRepoNote(
    { repo, related: [], cluster: null, notesRegion: parsed.notesRegion!, noteHash: parsed.noteHash, extraFrontmatter: parsed.extraFrontmatter, userTags: parsed.userTags, userAliases: parsed.userAliases },
    OPTIONS
  );
  assert.equal(second, first);
});

test("parseExistingNote returns null region when markers are missing", () => {
  const parsed = parseExistingNote("---\nrepo: a/b\n---\n\nno markers here");
  assert.equal(parsed.notesRegion, null);
});

test("repoTags and paths", () => {
  const tags = repoTags(sampleRepo({ language: "C#", localPath: "x" }), { id: 1, label: "llm · rag", size: 2 });
  assert.deepEqual(tags, ["repo-notebook", "repo/taal/csharp", "repo/status/todo", "repo/categorie/agents", "repo/cluster/llm-rag", "repo/gezondheid/active", "repo/gekloond"]);
  assert.equal(notePath("Repo Notebook", { owner: "a", name: "con" }), "Repo Notebook/a/con_.md");
  assert.equal(linkTo("Repo Notebook", { owner: "a", name: "b", fullName: "a/b" }), "[[Repo Notebook/a/b|a/b]]");
});

test("renderIndexNote lists clusters, statuses and A–Z", () => {
  const repos = [sampleRepo(), sampleRepo({ id: "x/zeta", owner: "x", name: "zeta", fullName: "x/zeta", status: "keep", language: "Go" })];
  const graph = {
    generatedAt: "",
    nodes: repos.map((r, i) => ({ id: r.id, name: r.name, fullName: r.fullName, owner: r.owner, description: "", language: "", category: "", status: "", stars: 0, topics: [], cluster: i, degree: 0 })),
    edges: [],
    clusters: [
      { id: 0, label: "ai · agents", size: 1 },
      { id: 1, label: "go", size: 1 }
    ]
  };
  const index = renderIndexNote({ repos, graph, serverOnline: false, removedCount: 1 }, OPTIONS);
  assert.match(index, /\*\*2\*\* repos/);
  assert.match(index, /### ai · agents \(1\)\n- \[\[Repo Notebook\/browser-use\/browser-use\|browser-use\/browser-use\]\]/);
  assert.match(index, /### Bevalt\n- \[\[Repo Notebook\/x\/zeta\|x\/zeta\]\]/);
  assert.match(index, /## A–Z\n\n### B\n- \[\[Repo Notebook\/browser-use/);
  assert.match(index, /### Z\n- \[\[Repo Notebook\/x\/zeta/);
  assert.match(index, /1 verwijderde notes bewaard/);
  assert.match(renderBase("Repo Notebook"), /file\.hasTag\("repo-notebook"\)/);
});

test("recordFromMeta mirrors the app's record shape", () => {
  const rec = recordFromMeta(
    {
      full_name: "Owner/Name",
      name: "Name",
      owner: { login: "Owner" },
      description: null,
      html_url: "https://github.com/Owner/Name",
      clone_url: "https://github.com/Owner/Name.git",
      ssh_url: "git@github.com:Owner/Name.git",
      default_branch: "dev",
      language: "Rust",
      topics: ["t"],
      license: { spdx_id: "MIT" },
      stargazers_count: 5,
      subscribers_count: 2,
      archived: false,
      pushed_at: "2026-01-01T00:00:00Z"
    },
    { files: [{ name: "a", path: "a", type: "dir", size: 0, html_url: "u" }], readme: "hi", now: new Date(NOW) }
  );
  assert.equal(rec.id, "owner/name");
  assert.equal(rec.fullName, "Owner/Name");
  assert.equal(rec.defaultBranch, "dev");
  assert.equal(rec.watchers, 2);
  assert.equal(rec.license, "MIT");
  assert.equal(rec.visibility, "Public");
  assert.deepEqual(rec.files, [{ name: "a", path: "a", type: "dir", size: 0, htmlUrl: "u" }]);
  assert.equal(rec.readme, "hi");
  assert.equal(rec.fetchedAt, new Date(NOW).toISOString());
});
