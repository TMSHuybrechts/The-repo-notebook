import type { Health, RepoRecord } from "./types";

// Windows reserved device names can't be used as file names — a repo called
// "con" or "aux" would otherwise break the vault. GitHub allows such names.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** File-system-safe segment for a vault path (owner or repo name). */
export const safeSegment = (value: string): string => {
  let out = String(value || "")
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");
  if (!out) out = "_";
  if (WINDOWS_RESERVED.test(out)) out = `${out}_`;
  return out;
};

const LANGUAGE_TAGS: Record<string, string> = {
  "c++": "cpp",
  "c#": "csharp",
  "f#": "fsharp",
  "objective-c": "objective-c",
  "objective-c++": "objective-cpp",
  "jupyter notebook": "jupyter",
  "vim script": "vimscript"
};

/** Tag-safe slug: lowercase, [a-z0-9_-] plus unicode letters, '-' separated. */
export const slugify = (value: string): string => {
  const raw = String(value || "").trim().toLowerCase();
  const mapped = LANGUAGE_TAGS[raw] || raw;
  return mapped
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
};

/** FNV-1a 32-bit hash as 8 hex chars. Cheap change detection, not security. */
export const hashText = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/** Same rule as the app UI: last push age + archived flag. */
export const repoHealth = (repo: RepoRecord, now = Date.now()): Health | null => {
  if (repo.archived) return { key: "archived", label: "Gearchiveerd" };
  if (!repo.pushedAt) return null;
  const days = (now - Date.parse(repo.pushedAt)) / 86400000;
  if (days <= 90) return { key: "active", label: "Actief" };
  if (days <= 365) return { key: "quiet", label: "Stil" };
  return { key: "stale", label: "Verouderd" };
};

export const shortNumber = (value: number | undefined): string => {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
};

export const isoDate = (value: string | undefined): string => {
  if (!value) return "";
  const t = Date.parse(value);
  if (Number.isNaN(t)) return "";
  return new Date(t).toISOString().slice(0, 10);
};

export const repoLetter = (repo: RepoRecord): string => {
  const ch = (repo.name || "?").charAt(0).toUpperCase();
  return /[A-Z]/.test(ch) ? ch : "#";
};

export const sortRepos = (repos: RepoRecord[]): RepoRecord[] =>
  [...repos].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.owner.localeCompare(b.owner));

/** Parse "owner/name", a github.com URL, or a git URL into its parts. */
export const parseRepoRef = (input: string): { owner: string; name: string } | null => {
  const raw = String(input || "").trim();
  if (!raw) return null;
  let pathname = "";
  if (raw.includes("://")) {
    try {
      const url = new URL(raw);
      if (url.hostname.replace(/^www\./, "").toLowerCase() !== "github.com") return null;
      pathname = url.pathname;
    } catch {
      return null;
    }
  } else if (/^git@github\.com:/i.test(raw)) {
    pathname = raw.replace(/^git@github\.com:/i, "/");
  } else {
    pathname = `/${raw}`;
  }
  const [owner, nameRaw] = pathname.split("/").filter(Boolean);
  const name = nameRaw?.replace(/\.git$/i, "");
  if (!owner || !name) return null;
  if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name)) return null;
  return { owner, name };
};

/** Every github.com/owner/repo mention in a blob of text (bulk add). */
export const extractRepoRefs = (text: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text || "")))) {
    const name = m[2].replace(/\.git$/i, "").replace(/[.,;:!?)]+$/, "");
    const id = `${m[1]}/${name}`.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(`${m[1]}/${name}`);
  }
  return out;
};

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
