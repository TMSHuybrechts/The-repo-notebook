// Fetches a repository from the GitHub API and builds the same record shape
// the desktop app stores (server/index.js → recordFromMeta). Used when the
// app isn't running so "add repo" still works straight from Obsidian.

import type { RepoFile, RepoRecord } from "./types";

export type JsonFetcher = (url: string, headers: Record<string, string>) => Promise<{ status: number; json: unknown; text: string }>;

export const githubHeaders = (token?: string): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  "User-Agent": "repo-notebook-obsidian",
  ...(token ? { Authorization: `Bearer ${token}` } : {})
});

interface GitHubRepoMeta {
  full_name: string;
  name: string;
  owner?: { login?: string };
  description?: string | null;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  homepage?: string | null;
  private?: boolean;
  default_branch?: string;
  language?: string | null;
  topics?: string[];
  license?: { spdx_id?: string; name?: string } | null;
  stargazers_count?: number;
  forks_count?: number;
  subscribers_count?: number;
  open_issues_count?: number;
  archived?: boolean;
  updated_at?: string;
  pushed_at?: string;
}

export const recordFromMeta = (
  meta: GitHubRepoMeta,
  extra: { savedAt?: string; files?: Array<Record<string, unknown>>; readme?: string; now?: Date } = {}
): RepoRecord => {
  const now = (extra.now || new Date()).toISOString();
  const files: RepoFile[] = (extra.files || []).slice(0, 30).map((item) => ({
    name: String(item.name || ""),
    path: String(item.path || ""),
    type: String(item.type || ""),
    size: Number(item.size || 0),
    htmlUrl: String(item.html_url || "")
  }));
  return {
    id: meta.full_name.toLowerCase(),
    owner: meta.owner?.login || meta.full_name.split("/")[0],
    name: meta.name,
    fullName: meta.full_name,
    description: meta.description || "",
    htmlUrl: meta.html_url,
    cloneUrl: meta.clone_url,
    sshUrl: meta.ssh_url,
    homepage: meta.homepage || "",
    visibility: meta.private ? "Private" : "Public",
    defaultBranch: meta.default_branch || "main",
    language: meta.language || "",
    topics: Array.isArray(meta.topics) ? meta.topics : [],
    license: meta.license?.spdx_id || meta.license?.name || "",
    stars: meta.stargazers_count || 0,
    forks: meta.forks_count || 0,
    watchers: meta.subscribers_count || 0,
    openIssues: meta.open_issues_count || 0,
    archived: meta.archived === true,
    updatedAt: meta.updated_at,
    pushedAt: meta.pushed_at,
    savedAt: extra.savedAt || now,
    fetchedAt: now,
    files,
    readme: extra.readme || ""
  };
};

const decodeBase64 = (value: string): string => {
  const clean = String(value || "").replace(/\s+/g, "");
  if (typeof Buffer !== "undefined") return Buffer.from(clean, "base64").toString("utf8");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

export const fetchGitHubRepo = async (
  owner: string,
  name: string,
  fetchJson: JsonFetcher,
  options: { token?: string; savedAt?: string } = {}
): Promise<RepoRecord> => {
  const headers = githubHeaders(options.token);
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const metaRes = await fetchJson(base, headers);
  if (metaRes.status === 404) throw new Error(`GitHub kent ${owner}/${name} niet (404).`);
  if (metaRes.status === 403 || metaRes.status === 429) throw new Error("GitHub rate limit bereikt — zet GITHUB_TOKEN of wacht even.");
  if (metaRes.status >= 400) throw new Error(`GitHub gaf ${metaRes.status}: ${metaRes.text.slice(0, 140)}`);
  const meta = metaRes.json as GitHubRepoMeta;
  const branch = meta.default_branch || "main";

  const files = await fetchJson(`${base}/contents?ref=${encodeURIComponent(branch)}`, headers)
    .then((res) => (res.status < 400 && Array.isArray(res.json) ? (res.json as Array<Record<string, unknown>>) : []))
    .catch(() => []);
  const readme = await fetchJson(`${base}/readme?ref=${encodeURIComponent(branch)}`, headers)
    .then((res) => {
      const data = res.json as { content?: string } | null;
      return res.status < 400 && data?.content ? decodeBase64(data.content) : "";
    })
    .catch(() => "");

  return recordFromMeta(meta, { savedAt: options.savedAt, files, readme });
};
