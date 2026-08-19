// Reads what the user owns in an existing repo note so a re-render can keep
// it: the notes region, their own frontmatter properties, extra tags/aliases
// and the hash of the last app-side note we synced.

import { NOTES_END, NOTES_START, OWN_KEYS, isOwnTag } from "./render";
import { frontmatterValue, readScalar, splitFrontmatter, splitFrontmatterEntries } from "./yaml";

export interface ExistingNote {
  /** null when the markers are missing — the note must not be overwritten. */
  notesRegion: string | null;
  noteHash: string;
  extraFrontmatter: string[];
  userTags: string[];
  userAliases: string[];
  status: string;
  category: string;
  removed: boolean;
}

/** Read a YAML list entry (block `- a` lines or inline `[a, b]`). */
export const readList = (entryText: string): string[] => {
  const lines = entryText.split(/\r?\n/);
  const head = lines[0];
  const inline = head.slice(head.indexOf(":") + 1).trim();
  if (inline.startsWith("[")) {
    const inner = inline.replace(/^\[/, "").replace(/\]\s*$/, "");
    return inner
      .split(",")
      .map((v) => readScalar(v))
      .filter(Boolean);
  }
  if (inline && inline !== "|" && inline !== ">") return [readScalar(inline)].filter(Boolean);
  return lines
    .slice(1)
    .map((line) => /^\s*-\s*(.*)$/.exec(line)?.[1] ?? "")
    .map((v) => readScalar(v))
    .filter(Boolean);
};

export const extractRegion = (body: string, start: string, end: string): string | null => {
  const a = body.indexOf(start);
  if (a < 0) return null;
  const b = body.indexOf(end, a + start.length);
  if (b < 0) return null;
  return body.slice(a + start.length, b).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
};

export const parseExistingNote = (content: string): ExistingNote => {
  const { frontmatter, body } = splitFrontmatter(content);
  const raw = frontmatter || "";
  const entries = splitFrontmatterEntries(raw);
  const own = new Set(OWN_KEYS);
  const extraFrontmatter = entries.filter((e) => e.key && !own.has(e.key)).map((e) => e.text);
  const tagsEntry = entries.find((e) => e.key === "tags" || e.key === "tag");
  const aliasEntry = entries.find((e) => e.key === "aliases" || e.key === "alias");
  const userTags = tagsEntry ? readList(tagsEntry.text).map((t) => t.replace(/^#/, "")).filter((t) => !isOwnTag(t)) : [];
  const userAliases = aliasEntry ? readList(aliasEntry.text) : [];
  return {
    notesRegion: extractRegion(body, NOTES_START, NOTES_END),
    noteHash: frontmatterValue(raw, "rn_note_hash") || "",
    extraFrontmatter,
    userTags,
    userAliases,
    status: frontmatterValue(raw, "status") || "",
    category: frontmatterValue(raw, "category") || "",
    removed: (frontmatterValue(raw, "rn_removed") || "").toLowerCase() === "true"
  };
};

/**
 * Decide what the notes region should contain after a sync, given the app's
 * current note, the vault's region and the hash of the last synced app note.
 * Vault edits win; app edits flow in only when the vault region is untouched.
 */
export const mergeNotes = (
  appNote: string,
  vaultRegion: string | null,
  lastHash: string,
  hash: (text: string) => string
): { region: string; hash: string; conflict?: string } => {
  const appHash = hash(appNote);
  if (vaultRegion === null) return { region: appNote, hash: appHash };
  const vault = vaultRegion.trim();
  const app = appNote.trim();
  if (vault === app) return { region: vaultRegion, hash: appHash };
  if (appHash === lastHash || (!lastHash && !app)) return { region: vaultRegion, hash: appHash === lastHash ? lastHash : appHash };
  // App note changed since last sync.
  if (hash(vaultRegion) === lastHash || hash(vault) === lastHash || !vault) return { region: appNote, hash: appHash };
  // Both sides changed: keep the vault, surface the app's text.
  return { region: vaultRegion, hash: lastHash, conflict: appNote };
};
