// Store → vault synchronisation. Obsidian-agnostic: the caller provides a
// tiny VaultLike adapter, so the whole engine runs (and is tested) in Node.

import type { Graph, GraphCluster, RepoRecord, Store } from "./types";
import { buildGraph } from "./graph-engine";
import { hashText } from "./util";
import { mergeNotes, parseExistingNote } from "./merge";
import {
  indexPath,
  linkTo,
  noteHashFor,
  notePath,
  renderBase,
  renderIndexNote,
  renderRepoNote,
  type RelatedLink,
  type RenderOptions
} from "./render";
import { splitFrontmatter, splitFrontmatterEntries, frontmatterValue } from "./yaml";

export interface VaultLike {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  create(path: string, content: string): Promise<void>;
  /** Atomic read-modify-write; fn returns new content (or the same string to leave untouched). */
  update(path: string, fn: (current: string) => string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  /** All markdown file paths under a folder, recursive. */
  listMarkdown(folder: string): Promise<string[]>;
  /** True when the note is being edited right now and should be left alone this round. */
  isBusy?(path: string): boolean;
}

export interface SyncOptions extends RenderOptions {
  maxRelated: number;
  writeIndex: boolean;
  writeBase: boolean;
  /** Only touch these repo ids (after "add repo"); index is always refreshed. */
  onlyIds?: Set<string>;
  serverOnline: boolean;
  /** Hashes of note texts this plugin pushed to the app (id → hash), to avoid self-inflicted conflicts. */
  pushedNoteHashes?: Map<string, string>;
}

export interface SyncResult {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  deferred: string[];
  deferredIds: string[];
  skippedNoMarkers: string[];
  conflicts: string[];
  removedMarked: number;
  graph: Graph;
  durationMs: number;
}

export const relatedFor = (graph: Graph, byId: Map<string, RepoRecord>, max: number): Map<string, RelatedLink[]> => {
  const out = new Map<string, RelatedLink[]>();
  for (const edge of graph.edges) {
    for (const [self, otherId] of [
      [edge.source, edge.target],
      [edge.target, edge.source]
    ]) {
      const other = byId.get(otherId);
      if (!other) continue;
      out.set(self, [...(out.get(self) || []), { repo: other, edge }]);
    }
  }
  for (const [id, list] of out) {
    list.sort((a, b) => b.edge.score - a.edge.score || a.repo.name.localeCompare(b.repo.name));
    out.set(id, list.slice(0, max));
  }
  return out;
};

export const clusterFor = (graph: Graph): Map<string, GraphCluster | null> => {
  const clusters = new Map(graph.clusters.map((c) => [c.id, c]));
  const out = new Map<string, GraphCluster | null>();
  for (const node of graph.nodes) out.set(node.id, clusters.get(node.cluster) || null);
  return out;
};

/** Mark a note whose repo vanished from the app store (keeps the user's text). */
export const markRemoved = (content: string): string => {
  const { frontmatter, body } = splitFrontmatter(content);
  if (frontmatter === null) return content;
  if ((frontmatterValue(frontmatter, "rn_removed") || "").toLowerCase() === "true") return content;
  const entries = splitFrontmatterEntries(frontmatter);
  const lines: string[] = [];
  let hadTags = false;
  for (const entry of entries) {
    if (entry.key === "tags" || entry.key === "tag") {
      hadTags = true;
      const firstLine = entry.text.split("\n")[0];
      const inline = firstLine.slice(firstLine.indexOf(":") + 1).trim();
      if (inline.startsWith("[")) {
        lines.push(`${entry.key}: ${inline.replace(/\]\s*$/, inline === "[]" ? "repo/verwijderd]" : ", repo/verwijderd]")}`);
      } else {
        lines.push(entry.text, "  - repo/verwijderd");
      }
      continue;
    }
    lines.push(entry.text);
  }
  if (!hadTags) lines.push("tags:", "  - repo/verwijderd");
  lines.push("rn_removed: true");
  const warning = "> [!warning] Niet meer in Repo Notebook\n> Deze repo is uit de app verwijderd; de note blijft staan voor je eigen notities.\n\n";
  return `---\n${lines.join("\n")}\n---\n\n${warning}${body.replace(/^\n+/, "")}`;
};

export const syncStoreToVault = async (store: Store, vault: VaultLike, options: SyncOptions): Promise<SyncResult> => {
  const started = Date.now();
  const repos = store.repos.filter((r) => r && r.id && r.owner && r.name);
  const byId = new Map(repos.map((r) => [r.id, r]));
  const graph = buildGraph(repos);
  const related = relatedFor(graph, byId, options.maxRelated);
  const clusters = clusterFor(graph);

  const result: SyncResult = {
    total: repos.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    deferred: [],
    deferredIds: [],
    skippedNoMarkers: [],
    conflicts: [],
    removedMarked: 0,
    graph,
    durationMs: 0
  };

  await vault.mkdir(options.folder);
  const ownerFolders = new Set<string>();

  for (const repo of repos) {
    if (options.onlyIds && !options.onlyIds.has(repo.id)) continue;
    const path = notePath(options.folder, repo);
    const ownerFolder = path.slice(0, path.lastIndexOf("/"));
    if (!ownerFolders.has(ownerFolder)) {
      await vault.mkdir(ownerFolder);
      ownerFolders.add(ownerFolder);
    }
    const base = {
      repo,
      related: options.includeRelated ? related.get(repo.id) || [] : [],
      cluster: clusters.get(repo.id) || null
    };
    const appNote = String(repo.note || "");

    if (!(await vault.exists(path))) {
      const content = renderRepoNote(
        { ...base, notesRegion: appNote, noteHash: noteHashFor(repo), extraFrontmatter: [], userTags: [], userAliases: [] },
        options
      );
      await vault.create(path, content);
      result.created++;
      continue;
    }

    if (vault.isBusy?.(path)) {
      result.deferred.push(path);
      result.deferredIds.push(repo.id);
      continue;
    }

    let outcome = "unchanged" as "updated" | "unchanged" | "skipped";
    let conflict = false;
    await vault.update(path, (current) => {
      const existing = parseExistingNote(current);
      if (existing.notesRegion === null) {
        outcome = "skipped";
        return current;
      }
      // A note we pushed ourselves counts as "already synced" — no conflict.
      const pushed = options.pushedNoteHashes?.get(repo.id);
      const lastHash = pushed && pushed === hashText(appNote) ? pushed : existing.noteHash;
      const merged = mergeNotes(appNote, existing.notesRegion, lastHash, hashText);
      if (merged.conflict) conflict = true;
      const next = renderRepoNote(
        {
          ...base,
          notesRegion: merged.region,
          noteHash: merged.hash,
          extraFrontmatter: existing.extraFrontmatter,
          userTags: existing.userTags,
          userAliases: existing.userAliases,
          conflictNote: merged.conflict
        },
        options
      );
      if (next === current) {
        outcome = "unchanged";
        return current;
      }
      outcome = "updated";
      return next;
    });
    if (conflict) result.conflicts.push(path);
    if (outcome === "skipped") result.skippedNoMarkers.push(path);
    else if (outcome === "updated") result.updated++;
    else result.unchanged++;
  }

  // Notes whose repo no longer exists in the app: keep them, flag them.
  let removedTotal = 0;
  if (!options.onlyIds) {
    const indexFile = indexPath(options.folder);
    for (const path of await vault.listMarkdown(options.folder)) {
      if (path === indexFile) continue;
      const content = await vault.read(path).catch(() => "");
      const { frontmatter } = splitFrontmatter(content);
      if (frontmatter === null) continue;
      const repoRef = frontmatterValue(frontmatter, "repo");
      if (!repoRef) continue;
      if (frontmatterValue(frontmatter, "rn_note_hash") === undefined) continue; // not one of ours
      if (byId.has(repoRef.toLowerCase())) continue;
      removedTotal++;
      if ((frontmatterValue(frontmatter, "rn_removed") || "").toLowerCase() === "true") continue;
      if (vault.isBusy?.(path)) continue;
      const changed = await vault.update(path, (current) => markRemoved(current));
      if (changed) result.removedMarked++;
    }
  }

  if (options.writeIndex) {
    const index = renderIndexNote({ repos, graph, serverOnline: options.serverOnline, removedCount: removedTotal }, options);
    const path = indexPath(options.folder);
    if (await vault.exists(path)) await vault.update(path, () => index);
    else await vault.create(path, index);
  }
  if (options.writeBase) {
    const path = `${options.folder}/Repos.base`;
    const base = renderBase(options.folder);
    if (await vault.exists(path)) await vault.update(path, (current) => (current === base ? current : base));
    else await vault.create(path, base);
  }

  result.durationMs = Date.now() - started;
  return result;
};

export { linkTo, notePath, indexPath };
