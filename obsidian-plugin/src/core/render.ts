// Renders one repo note (frontmatter + body) and the index note. Pure
// functions — no Obsidian imports — so they can be unit-tested in Node.

import type { Graph, GraphCluster, GraphEdge, RepoRecord } from "./types";
import { STATUS_LABELS, STATUS_ORDER } from "./types";
import { hashText, isoDate, repoHealth, repoLetter, safeSegment, shortNumber, slugify, sortRepos } from "./util";
import { normalizeReadme } from "./readme";
import { yamlEntries, type YamlValue } from "./yaml";
import { translate, type Lang } from "./i18n";

export const NOTES_START = "<!-- rn:notes -->";
export const NOTES_END = "<!-- /rn:notes -->";
export const README_START = "<!-- rn:readme -->";
export const README_END = "<!-- /rn:readme -->";
export const BASE_TAG = "repo-notebook";
export const TAG_PREFIX = "repo/";

/** Frontmatter keys owned by the plugin (rewritten on every sync). */
export const OWN_KEYS = [
  "repo", "url", "owner", "name", "description", "homepage", "language", "stars", "forks", "watchers",
  "open_issues", "topics", "license", "default_branch", "archived", "health", "status", "category", "cluster",
  "cloned", "local_path", "pushed_at", "saved_at", "fetched_at", "ai_verdict_at", "tags", "aliases",
  "rn_synced", "rn_note_hash", "rn_removed" // rn_synced: legacy, dropped from repo notes (index only)
];

export interface RenderOptions {
  folder: string;
  includeReadme: boolean;
  readmeMaxChars: number;
  includeRelated: boolean;
  includeFiles: boolean;
  includeVerdict: boolean;
  now: number;
  /** Language of generated headings/labels (identifiers never change). Default English. */
  lang?: Lang;
}

export interface RelatedLink {
  repo: RepoRecord;
  edge: GraphEdge;
}

export interface NoteInput {
  repo: RepoRecord;
  related: RelatedLink[];
  cluster: GraphCluster | null;
  /** Text between the notes markers (user-owned). */
  notesRegion: string;
  /** Hash of the app-side note value this region was last synced with. */
  noteHash: string;
  /** User-added frontmatter entries, verbatim (from the existing note). */
  extraFrontmatter: string[];
  /** User tags / aliases to keep (not ours). */
  userTags: string[];
  userAliases: string[];
  /** Repo no longer exists in the app store. */
  removed?: boolean;
  /** App-side note text that conflicts with the vault region. */
  conflictNote?: string;
}

export const notePath = (folder: string, repo: Pick<RepoRecord, "owner" | "name">): string =>
  `${folder}/${safeSegment(repo.owner)}/${safeSegment(repo.name)}.md`;

export const linkTo = (folder: string, repo: Pick<RepoRecord, "owner" | "name" | "fullName">): string =>
  `[[${notePath(folder, repo).replace(/\.md$/, "")}|${repo.fullName || `${repo.owner}/${repo.name}`}]]`;

export const indexPath = (folder: string): string => `${folder}/${folder.split("/").pop()}.md`;

const oneLine = (text: string | undefined): string => String(text || "").replace(/\s+/g, " ").trim();

const statusLabel = (status: string | undefined, lang?: Lang): string =>
  status && STATUS_LABELS[status] ? translate(STATUS_LABELS[status], [], lang) : "";

/** Callout lines written on notes whose repo was removed from the app. */
export const removedCallout = (lang?: Lang): [string, string] => [
  `> [!warning] ${translate("Niet meer in Repo Notebook", [], lang)}`,
  `> ${translate("Deze repo is uit de app verwijderd; de note blijft staan voor je eigen notities.", [], lang)}`
];

export const repoTags = (repo: RepoRecord, cluster: GraphCluster | null, removed = false): string[] => {
  const tags = [BASE_TAG];
  if (repo.language) tags.push(`${TAG_PREFIX}taal/${slugify(repo.language)}`);
  if (repo.status && STATUS_LABELS[repo.status]) tags.push(`${TAG_PREFIX}status/${repo.status}`);
  if (repo.category) tags.push(`${TAG_PREFIX}categorie/${slugify(repo.category)}`);
  if (cluster && cluster.label) tags.push(`${TAG_PREFIX}cluster/${slugify(cluster.label.replace(/·/g, " "))}`);
  const health = repoHealth(repo);
  if (health) tags.push(`${TAG_PREFIX}gezondheid/${health.key}`);
  if (repo.cloneStatus || repo.localPath) tags.push(`${TAG_PREFIX}gekloond`);
  if (removed) tags.push(`${TAG_PREFIX}verwijderd`);
  return tags.filter((tag, i, all) => all.indexOf(tag) === i);
};

export const isOwnTag = (tag: string): boolean => tag === BASE_TAG || tag.startsWith(TAG_PREFIX);

const calloutLines = (text: string): string =>
  String(text || "")
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");

const describeEdge = (edge: GraphEdge, lang?: Lang): string => {
  const tr = (m: string, v: Array<string | number> = []) => translate(m, v, lang);
  const parts: string[] = [];
  if (edge.sharedTopics?.length) parts.push(`topics: ${edge.sharedTopics.slice(0, 4).join(", ")}`);
  if (edge.sharedTerms?.length) parts.push(tr("woorden: {0}", [edge.sharedTerms.slice(0, 4).join(", ")]));
  if (edge.sameCategory) parts.push(tr("zelfde categorie"));
  if (edge.sameOwner) parts.push(tr("zelfde maker"));
  if (edge.sameLanguage && !edge.sharedTopics?.length && !edge.sharedTerms?.length) parts.push(tr("zelfde taal"));
  if (edge.hidden) parts.push(`_${tr("verborgen link")}_`);
  parts.push(`score ${edge.score.toFixed(2)}`);
  return parts.join(" · ");
};

export const renderRepoNote = (input: NoteInput, options: RenderOptions): string => {
  const { repo, related, cluster } = input;
  const lang = options.lang;
  const tr = (m: string, v: Array<string | number> = []) => translate(m, v, lang);
  const health = repoHealth(repo, options.now);
  const cloned = Boolean(repo.cloneStatus || repo.localPath);
  const fullName = repo.fullName || `${repo.owner}/${repo.name}`;
  const tags = [...repoTags(repo, cluster, input.removed), ...input.userTags.filter((t) => !isOwnTag(t))];
  const aliases = [fullName, ...input.userAliases.filter((a) => a !== fullName)];

  const entries: Array<[string, YamlValue]> = [
    ["repo", fullName],
    ["url", repo.htmlUrl || `https://github.com/${fullName}`],
    ["owner", repo.owner],
    ["name", repo.name],
    ["description", oneLine(repo.description)],
    ["homepage", repo.homepage || ""],
    ["language", repo.language || ""],
    ["stars", Number(repo.stars || 0)],
    ["forks", Number(repo.forks || 0)],
    ["watchers", Number(repo.watchers || 0)],
    ["open_issues", Number(repo.openIssues || 0)],
    ["topics", (repo.topics || []).map(String)],
    ["license", repo.license || ""],
    ["default_branch", repo.defaultBranch || "main"],
    ["archived", Boolean(repo.archived)],
    ["health", health?.key || ""],
    ["status", (repo.status as string) || ""],
    ["category", repo.category || ""],
    ["cluster", cluster?.label || ""],
    ["cloned", cloned],
    ["local_path", repo.localPath || ""],
    ["pushed_at", isoDate(repo.pushedAt)],
    ["saved_at", isoDate(repo.savedAt)],
    ["fetched_at", isoDate(repo.fetchedAt)],
    ["ai_verdict_at", isoDate(repo.aiVerdictAt)],
    ["tags", tags],
    ["aliases", aliases],
    ["rn_note_hash", input.noteHash]
  ];
  if (input.removed) entries.push(["rn_removed", true]);

  // Keep status/category even when empty (they are the editable hooks for the
  // app); drop other empty optionals so the Properties panel stays tidy.
  const OPTIONAL_EMPTY = new Set(["description", "homepage", "language", "license", "local_path", "ai_verdict_at", "cluster"]);
  const kept = entries.filter(([key, value]) => !(OPTIONAL_EMPTY.has(key) && value === ""));
  const fm = ["---", ...input.extraFrontmatter, ...yamlEntries(kept), "---"];

  const facts: string[] = [];
  facts.push(`[GitHub](${repo.htmlUrl || `https://github.com/${fullName}`})`);
  if (repo.homepage) facts.push(`[Homepage](${repo.homepage})`);
  facts.push(`⭐ ${shortNumber(repo.stars)}`);
  facts.push(`🍴 ${shortNumber(repo.forks)}`);
  if (repo.language) facts.push(repo.language);
  if (repo.license) facts.push(repo.license);
  if (repo.pushedAt) facts.push(`push ${isoDate(repo.pushedAt)}`);
  if (health) facts.push(tr(health.label));
  if (statusLabel(repo.status as string, lang)) facts.push(`**${statusLabel(repo.status as string, lang)}**`);
  if (repo.category) facts.push(`📂 ${repo.category}`);
  if (cloned) facts.push(`💾 ${tr("gekloond")}`);

  const body: string[] = [];
  if (input.removed) {
    body.push(...removedCallout(lang), "");
  }
  body.push(`> [!abstract] ${fullName}`);
  if (repo.description) body.push(`> ${oneLine(repo.description)}`, ">");
  body.push(`> ${facts.join(" · ")}`);
  if (repo.topics?.length) body.push(">", `> ${repo.topics.map((t) => `\`${t}\``).join(" ")}`);
  body.push("");

  body.push(`## ${tr("Notities")}`, NOTES_START, input.notesRegion.replace(/^\n+|\n+$/g, ""), NOTES_END, "");
  if (input.conflictNote) {
    body.push(`> [!warning] ${tr("Notitie in de Repo Notebook-app verschilt van je vault-notitie")}`, calloutLines(input.conflictNote), "");
  }

  if (options.includeVerdict && repo.aiVerdict) {
    const meta = [repo.aiProvider, isoDate(repo.aiVerdictAt)].filter(Boolean).join(" · ");
    body.push(`## ${tr("AI-oordeel")}`, `> [!tip] ${tr("Is dit de moeite?")}${meta ? ` (${meta})` : ""}`, calloutLines(repo.aiVerdict), "");
  }

  if (options.includeRelated && related.length) {
    body.push(`## ${tr("Verwante repos")}`);
    for (const { repo: other, edge } of related) {
      body.push(`- ${linkTo(options.folder, other)} — ${describeEdge(edge, lang)}`);
    }
    body.push("");
  }

  if (options.includeFiles && repo.files?.length) {
    const names = repo.files.map((f) => `\`${f.type === "dir" ? `${f.name}/` : f.name}\``);
    body.push(`> [!example]- ${tr("Bestanden ({0})", [repo.files.length])}`, `> ${names.join(" · ")}`, "");
  }

  if (options.includeReadme && repo.readme) {
    const readme = normalizeReadme(repo.readme, {
      owner: repo.owner,
      name: repo.name,
      branch: repo.defaultBranch || "main",
      maxChars: options.readmeMaxChars,
      lang
    });
    body.push("## README", README_START, readme, README_END, "");
  }

  return `${fm.join("\n")}\n\n${body.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
};

export const noteHashFor = (repo: RepoRecord): string => hashText(String(repo.note || ""));

export interface IndexInput {
  repos: RepoRecord[];
  graph: Graph | null;
  serverOnline: boolean;
  removedCount: number;
}

export const renderIndexNote = (input: IndexInput, options: RenderOptions): string => {
  const { repos, graph } = input;
  const lang = options.lang;
  const tr = (m: string, v: Array<string | number> = []) => translate(m, v, lang);
  const sorted = sortRepos(repos);
  const byId = new Map(repos.map((r) => [r.id, r]));
  const cloned = repos.filter((r) => r.cloneStatus || r.localPath).length;
  const statusCounts = STATUS_ORDER.map((key) => [key, repos.filter((r) => r.status === key).length] as const).filter(([, n]) => n > 0);
  const hidden = graph ? graph.edges.filter((e) => e.hidden).length : 0;

  const lines: string[] = [
    "---",
    ...yamlEntries([
      ["tags", [BASE_TAG, `${BASE_TAG}/index`]],
      ["repos", repos.length],
      ["cloned", cloned],
      ["rn_synced", new Date(options.now).toISOString()]
    ]),
    "---",
    "",
    `> [!abstract] Repo Notebook`,
    `> ${tr("**{0}** repos · **{1}** gekloond", [repos.length, cloned])}${graph ? ` · ${tr("**{0}** links ({1} verborgen)", [graph.edges.length, hidden])} · **${graph.clusters.length}** clusters` : ""}`,
    `> ${statusCounts.length ? statusCounts.map(([key, n]) => `${statusLabel(key, lang)} ${n}`).join(" · ") : tr("nog geen statussen")}`,
    `> ${tr("Gesynct {0} · app {1}", [new Date(options.now).toISOString().slice(0, 16).replace("T", " "), input.serverOnline ? "online" : "offline"])}${input.removedCount ? ` · ${tr("{0} verwijderde notes bewaard", [input.removedCount])}` : ""}`,
    ""
  ];

  const entry = (repo: RepoRecord): string => {
    const bits = [repo.language, repo.stars ? `⭐ ${shortNumber(repo.stars)}` : "", statusLabel(repo.status as string, lang)].filter(Boolean);
    const desc = oneLine(repo.description);
    return `- ${linkTo(options.folder, repo)}${bits.length ? ` (${bits.join(" · ")})` : ""}${desc ? ` — ${desc.length > 110 ? `${desc.slice(0, 107)}…` : desc}` : ""}`;
  };

  if (graph && graph.clusters.length) {
    lines.push(`## ${tr("Clusters (kennisgraaf)")}`, "");
    const members = new Map<number, RepoRecord[]>();
    for (const node of graph.nodes) {
      const repo = byId.get(node.id);
      if (!repo) continue;
      members.set(node.cluster, [...(members.get(node.cluster) || []), repo]);
    }
    for (const cluster of graph.clusters) {
      const list = sortRepos(members.get(cluster.id) || []);
      if (!list.length) continue;
      lines.push(`### ${cluster.label} (${list.length})`);
      for (const repo of list) lines.push(entry(repo));
      lines.push("");
    }
  }

  if (statusCounts.length) {
    lines.push(`## ${tr("Per status")}`, "");
    for (const [key] of statusCounts) {
      lines.push(`### ${statusLabel(key, lang)}`);
      for (const repo of sorted.filter((r) => r.status === key)) lines.push(entry(repo));
      lines.push("");
    }
  }

  lines.push("## A–Z", "");
  let letter = "";
  for (const repo of sorted) {
    const l = repoLetter(repo);
    if (l !== letter) {
      letter = l;
      lines.push(`### ${letter}`);
    }
    lines.push(entry(repo));
  }
  lines.push("");
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
};

/** The Bases file: a native table over all repo notes (Obsidian 1.9+). */
export const renderBase = (folder: string, lang?: Lang): string => {
  const tr = (m: string) => translate(m, [], lang);
  return [
    "filters:",
    "  and:",
    `    - file.hasTag("${BASE_TAG}")`,
    `    - 'file.ext == "md"'`,
    `    - '!file.hasTag("${BASE_TAG}/index")'`,
    "properties:",
    "  note.repo:",
    "    displayName: Repo",
    "  note.language:",
    `    displayName: ${tr("Taal")}`,
    "  note.stars:",
    "    displayName: Stars",
    "  note.status:",
    "    displayName: Status",
    "  note.category:",
    `    displayName: ${tr("Categorie")}`,
    "  note.cluster:",
    "    displayName: Cluster",
    "  note.health:",
    `    displayName: ${tr("Gezondheid")}`,
    "  note.pushed_at:",
    `    displayName: ${tr("Laatste push")}`,
    "  note.cloned:",
    `    displayName: ${tr("Gekloond")}`,
    "  note.description:",
    `    displayName: ${tr("Omschrijving")}`,
    "views:",
    "  - type: table",
    `    name: ${tr("Alle repos")}`,
    "    order:",
    "      - file.name",
    "      - note.owner",
    "      - note.language",
    "      - note.stars",
    "      - note.status",
    "      - note.category",
    "      - note.cluster",
    "      - note.health",
    "      - note.pushed_at",
    "      - note.description",
    "    sort:",
    "      - property: note.stars",
    "        direction: DESC",
    "  - type: table",
    `    name: ${tr("Te proberen")}`,
    "    filters:",
    "      and:",
    `        - 'status == "todo"'`,
    "    order:",
    "      - file.name",
    "      - note.language",
    "      - note.stars",
    "      - note.description",
    "  - type: table",
    `    name: ${tr("Gekloond")}`,
    "    filters:",
    "      and:",
    "        - cloned == true",
    "    order:",
    "      - file.name",
    "      - note.language",
    "      - note.status",
    "      - note.local_path",
    "  - type: table",
    `    name: ${tr("Per cluster")}`,
    "    groupBy:",
    "      property: note.cluster",
    "      direction: ASC",
    "    order:",
    "      - file.name",
    "      - note.language",
    "      - note.stars",
    "      - note.description",
    "  - type: cards",
    `    name: ${tr("Kaarten")}`,
    "    order:",
    "      - file.name",
    "      - note.description",
    "      - note.language",
    "      - note.stars",
    ""
  ].join("\n");
};
