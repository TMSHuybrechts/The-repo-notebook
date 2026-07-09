// MCP server for Repo Notebook.
//
// Lets an AI assistant (e.g. Claude Code) drive the same GitHub repo shelf as
// the desktop app: list, save, clone, browse trending. It reads and writes the
// SAME data dir (%LOCALAPPDATA%\RepoNotebook), so the app and this server stay
// in sync — save a repo here and it shows up in the app, and vice versa.
//
// Transport: stdio. Register via `.mcp.json` or `claude mcp add`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const baseDir =
  process.env.RN_DATA_DIR ||
  (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "RepoNotebook", "data")
    : path.join(process.env.HOME || ".", "RepoNotebook", "data"));
const storePath = path.join(baseDir, "notebook.json");
const clonesDir = path.join(baseDir, "clones");

const ownerPart = /^[A-Za-z0-9-]+$/;
const repoPart = /^[A-Za-z0-9._-]+$/;
const safeName = (value) => value.replace(/[^A-Za-z0-9._-]/g, "-");

const apiHeaders = () => ({
  Accept: "application/vnd.github+json",
  "User-Agent": "repo-notebook-mcp",
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
});

const ensureData = async () => {
  await fs.mkdir(clonesDir, { recursive: true });
  try {
    await fs.access(storePath);
  } catch {
    await fs.writeFile(storePath, JSON.stringify({ repos: [] }, null, 2));
  }
};

const readStore = async () => {
  await ensureData();
  try {
    const data = JSON.parse(await fs.readFile(storePath, "utf8"));
    return { repos: Array.isArray(data.repos) ? data.repos : [] };
  } catch {
    // Primary store unreadable — fall back to the rolling backup rather than
    // returning an empty list, which a later write would persist and wipe the store.
    try {
      const backup = JSON.parse(await fs.readFile(`${storePath}.bak`, "utf8"));
      if (Array.isArray(backup.repos)) return { repos: backup.repos };
    } catch {
      /* no usable backup */
    }
    throw new Error("notebook.json is unreadable and no valid backup exists — refusing to overwrite the store.");
  }
};

// Atomic, serialized writes with a rolling .bak (see server/index.js for the
// rationale — app and MCP share this file across processes).
let writeLock = Promise.resolve();
const writeStore = (store) =>
  (writeLock = writeLock.catch(() => {}).then(async () => {
    await ensureData();
    const payload = `${JSON.stringify(store, null, 2)}\n`;
    const tmp = `${storePath}.tmp-${process.pid}`;
    await fs.writeFile(tmp, payload);
    try {
      await fs.copyFile(storePath, `${storePath}.bak`);
    } catch {
      /* first write — nothing to back up yet */
    }
    await fs.rename(tmp, storePath);
  }));

const parseRepo = (input) => {
  const raw = String(input || "").trim();
  const urlish = raw.includes("://") ? raw : `https://github.com/${raw}`;
  let parsed;
  try {
    parsed = new URL(urlish);
  } catch {
    throw new Error("Provide a valid GitHub URL or owner/repo.");
  }
  if (parsed.hostname.replace(/^www\./, "").toLowerCase() !== "github.com") {
    throw new Error("Only github.com repositories are supported.");
  }
  const [owner, repoRaw] = parsed.pathname.split("/").filter(Boolean);
  const repo = repoRaw?.replace(/\.git$/i, "");
  if (!owner || !repo) throw new Error("Include both owner and repository name.");
  if (!ownerPart.test(owner) || !repoPart.test(repo)) throw new Error("Invalid GitHub repository name.");
  return { owner, repo };
};

const gh = async (url) => {
  const res = await fetch(url, { headers: apiHeaders() });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub request failed (${res.status}). ${detail.slice(0, 180)}`);
  }
  return res.json();
};

const isoDaysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

const fetchRepo = async (owner, repo, savedAt) => {
  const meta = await gh(`https://api.github.com/repos/${owner}/${repo}`);
  const branch = meta.default_branch || "main";
  const files = await gh(`https://api.github.com/repos/${owner}/${repo}/contents?ref=${encodeURIComponent(branch)}`)
    .then((items) => (Array.isArray(items) ? items : []))
    .catch(() => []);
  const readme = await gh(`https://api.github.com/repos/${owner}/${repo}/readme?ref=${encodeURIComponent(branch)}`)
    .then((data) => (data.content ? Buffer.from(data.content, "base64").toString("utf8") : ""))
    .catch(() => "");

  return {
    id: meta.full_name.toLowerCase(),
    owner: meta.owner?.login || owner,
    name: meta.name || repo,
    fullName: meta.full_name,
    description: meta.description || "",
    htmlUrl: meta.html_url,
    cloneUrl: meta.clone_url,
    sshUrl: meta.ssh_url,
    homepage: meta.homepage || "",
    visibility: meta.private ? "Private" : "Public",
    defaultBranch: branch,
    language: meta.language || "",
    topics: Array.isArray(meta.topics) ? meta.topics : [],
    license: meta.license?.spdx_id || meta.license?.name || "",
    stars: meta.stargazers_count || 0,
    forks: meta.forks_count || 0,
    watchers: meta.subscribers_count || 0,
    openIssues: meta.open_issues_count || 0,
    updatedAt: meta.updated_at,
    pushedAt: meta.pushed_at,
    savedAt: savedAt || new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    files: files.slice(0, 30).map((item) => ({
      name: item.name,
      path: item.path,
      type: item.type,
      size: item.size || 0,
      htmlUrl: item.html_url
    })),
    readme
  };
};

const findRepo = (store, owner, repo) =>
  store.repos.find(
    (item) => item.owner.toLowerCase() === owner.toLowerCase() && item.name.toLowerCase() === repo.toLowerCase()
  );

const cloneTarget = (repo) => {
  const target = path.resolve(clonesDir, safeName(repo.owner), safeName(repo.name));
  const rootWithSep = `${path.resolve(clonesDir)}${path.sep}`;
  if (target !== path.resolve(clonesDir) && target.startsWith(rootWithSep)) return target;
  throw new Error("Clone path escaped the data directory.");
};

const runGit = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { shell: false });
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("git clone timed out after 5 minutes."));
    }, 300000);
    child.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(err.slice(0, 800) || `git exited with ${code}`));
    });
  });

const searchRepos = async (query) => {
  const data = await gh(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=10`
  );
  return Array.isArray(data.items) ? data.items : [];
};

const text = (value) => ({ content: [{ type: "text", text: value }] });

const server = new McpServer({ name: "repo-notebook", version: "0.1.0" });

server.tool(
  "list_saved_repos",
  "List every GitHub repository saved in Repo Notebook (name, stars, language, clone status).",
  {},
  async () => {
    const { repos } = await readStore();
    if (!repos.length) return text("No repositories saved yet.");
    const lines = repos
      .slice()
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map(
        (r) =>
          `- ${r.fullName} — ★${r.stars} ${r.language || ""}` +
          `${r.status ? ` <${r.status}>` : ""}${r.category ? ` {${r.category}}` : ""}` +
          `${r.localPath ? " [cloned]" : ""}${r.description ? ` — ${r.description}` : ""}`
      );
    return text(`${repos.length} saved repositories:\n${lines.join("\n")}`);
  }
);

server.tool(
  "save_repo",
  "Save a GitHub repository into Repo Notebook. Accepts a full URL or owner/repo.",
  { repo: z.string().describe("GitHub URL or owner/repo, e.g. https://github.com/vercel/next.js or vercel/next.js") },
  async ({ repo }) => {
    const { owner, repo: name } = parseRepo(repo);
    const store = await readStore();
    const existing = findRepo(store, owner, name);
    const record = await fetchRepo(owner, name, existing?.savedAt);
    const i = store.repos.findIndex((item) => item.id === record.id);
    store.repos =
      i >= 0
        ? store.repos.map((item, idx) => (idx === i ? { ...item, ...record, savedAt: item.savedAt } : item))
        : [...store.repos, record];
    await writeStore(store);
    return text(
      `${existing ? "Already saved — refreshed" : "Saved"}: ${record.fullName} (★${record.stars}, ${record.language || "unknown"}).`
    );
  }
);

server.tool(
  "clone_repo",
  "Clone a saved repository to local disk (data/clones/owner/repo). Save it first if needed.",
  {
    repo: z.string().describe("GitHub URL or owner/repo"),
    method: z.enum(["https", "ssh"]).optional().describe("Clone protocol, default https")
  },
  async ({ repo, method }) => {
    const { owner, repo: name } = parseRepo(repo);
    const store = await readStore();
    const record = findRepo(store, owner, name);
    if (!record) throw new Error(`${owner}/${name} is not saved yet — call save_repo first.`);
    const target = cloneTarget(record);
    try {
      await fs.access(target);
      return text(`Already cloned at: ${target}`);
    } catch {
      /* not cloned yet */
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await runGit(["clone", method === "ssh" ? record.sshUrl : record.cloneUrl, target]);
    store.repos = store.repos.map((item) =>
      item.id === record.id ? { ...item, cloneStatus: "cloned", localPath: target, clonedAt: new Date().toISOString() } : item
    );
    await writeStore(store);
    return text(`Cloned ${record.fullName} to: ${target}`);
  }
);

server.tool(
  "trending_repos",
  "Get the current GitHub Top 10 trending repositories.",
  {},
  async () => {
    let repos = await searchRepos(`created:>${isoDaysAgo(14)} stars:>20`).catch(() => []);
    if (!repos.length) repos = await searchRepos(`pushed:>${isoDaysAgo(7)} stars:>1000`);
    const lines = repos
      .slice(0, 10)
      .map(
        (r, i) =>
          `${i + 1}. ${r.full_name} — ★${r.stargazers_count} ${r.language || ""}${r.description ? ` — ${r.description}` : ""}`
      );
    return text(lines.length ? `GitHub Top 10:\n${lines.join("\n")}` : "Trending is not available right now.");
  }
);

server.tool(
  "remove_repo",
  "Remove a repository from Repo Notebook. Does not delete any files already cloned to disk.",
  { repo: z.string().describe("GitHub URL or owner/repo") },
  async ({ repo }) => {
    const { owner, repo: name } = parseRepo(repo);
    const store = await readStore();
    const before = store.repos.length;
    store.repos = store.repos.filter(
      (item) => !(item.owner.toLowerCase() === owner.toLowerCase() && item.name.toLowerCase() === name.toLowerCase())
    );
    await writeStore(store);
    return text(before === store.repos.length ? `${owner}/${name} was not in the notebook.` : `Removed ${owner}/${name}.`);
  }
);

server.tool(
  "set_repo_meta",
  "Set the collection/category, status and/or note on a saved repo. status is one of: todo, installed, keep, archive (or empty to clear).",
  {
    repo: z.string().describe("GitHub URL or owner/repo"),
    category: z.string().optional().describe("Collection/category label, e.g. AI or Hacking"),
    status: z.enum(["todo", "installed", "keep", "archive", ""]).optional().describe("Try/installed/keep/archive"),
    note: z.string().optional().describe("Free-text note")
  },
  async ({ repo, category, status, note }) => {
    const { owner, repo: name } = parseRepo(repo);
    const store = await readStore();
    const record = findRepo(store, owner, name);
    if (!record) throw new Error(`${owner}/${name} is not saved yet — call save_repo first.`);
    const patch = {};
    if (typeof category === "string") patch.category = category.trim().slice(0, 60);
    if (typeof status === "string") patch.status = status;
    if (typeof note === "string") patch.note = note.slice(0, 2000);
    if (!Object.keys(patch).length) throw new Error("Provide at least one of: category, status, note.");
    store.repos = store.repos.map((item) => (item.id === record.id ? { ...item, ...patch } : item));
    await writeStore(store);
    const summary = Object.entries(patch)
      .map(([key, value]) => `${key}=${value === "" ? "(cleared)" : value}`)
      .join(", ");
    return text(`Updated ${record.fullName}: ${summary}.`);
  }
);

server.tool(
  "search_github",
  "Search GitHub for repositories by keyword (sorted by stars). Use to discover repos worth saving.",
  { query: z.string().describe("Search terms, e.g. 'local LLM agent'") },
  async ({ query }) => {
    const items = await searchRepos(query);
    if (!items.length) return text(`No results for "${query}".`);
    const lines = items
      .slice(0, 10)
      .map((r, i) => `${i + 1}. ${r.full_name} — ★${r.stargazers_count} ${r.language || ""}${r.description ? ` — ${r.description}` : ""}`);
    return text(`Top results for "${query}":\n${lines.join("\n")}`);
  }
);

server.tool(
  "bulk_save",
  "Save every github.com/owner/repo mentioned in a block of text (e.g. a social-media caption) into Repo Notebook.",
  { text: z.string().describe("Any text containing GitHub URLs or owner/repo slugs") },
  async ({ text: input }) => {
    const found = [...String(input || "").matchAll(/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/gi)].map(
      (m) => `${m[1]}/${m[2].replace(/\.git$/i, "")}`
    );
    const slugs = [...new Set(found)].slice(0, 40);
    if (!slugs.length) return text("No github.com repositories found in that text.");
    const added = [];
    const failed = [];
    for (const slug of slugs) {
      try {
        const { owner, repo: name } = parseRepo(slug);
        const record = await fetchRepo(owner, name);
        const store = await readStore();
        const i = store.repos.findIndex((it) => it.id === record.id);
        store.repos =
          i >= 0
            ? store.repos.map((it, idx) => (idx === i ? { ...it, ...record, savedAt: it.savedAt } : it))
            : [...store.repos, record];
        await writeStore(store);
        added.push(record.fullName);
      } catch (error) {
        failed.push(`${slug} (${error.message})`);
      }
    }
    return text(`Saved ${added.length}: ${added.join(", ") || "-"}.${failed.length ? ` Failed: ${failed.join("; ")}` : ""}`);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
