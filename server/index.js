import express from "express";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = process.env.RN_DATA_DIR
  || (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "RepoNotebook", "data")
    : path.join(root, "data"));
const storePath = path.join(dataDir, "notebook.json");
const clonesDir = path.join(dataDir, "clones");
const runsDir = path.join(dataDir, "runs");
const production = process.argv.includes("--production") || process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 5188);
const running = new Map();
let trendingCache = { fetchedAt: "", repos: [] };

const app = express();

// --- Localhost guard -------------------------------------------------------
// This app clones, installs and RUNS arbitrary code, so it must only ever be
// driven by you on this machine — never by a website you happen to visit.
//   * Host allowlist  → blocks DNS-rebinding (a hostile domain re-pointed at
//     127.0.0.1 still sends its own Host header, which we reject).
//   * Origin check     → blocks cross-site CSRF POSTs (browsers attach Origin
//     to cross-origin state-changing requests; same-origin/no-origin pass).
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
app.use((req, res, next) => {
  if (!allowedHosts.has(req.headers.host)) {
    return res.status(403).json({ error: "Forbidden host." });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({ error: "Forbidden origin." });
    }
  }
  next();
});

app.use(express.json({ limit: "1mb" }));

const repoPart = /^[A-Za-z0-9._-]+$/;
const ownerPart = /^[A-Za-z0-9-]+$/;
const ALLOWED_STATUS = new Set(["", "todo", "installed", "keep", "archive"]);

const apiHeaders = () => ({
  Accept: "application/vnd.github+json",
  "User-Agent": "repo-notebook-local-app",
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
});

const safeName = (value) => value.replace(/[^A-Za-z0-9._-]/g, "-");
const commandSpec = (cmd, args) => {
  if (cmd === "npm" && process.env.npm_execpath) {
    return { cmd: process.execPath, args: [process.env.npm_execpath, ...args] };
  }
  return { cmd, args };
};

const assertRepo = (owner, repo) => {
  if (!ownerPart.test(owner) || !repoPart.test(repo)) throw new Error("Invalid GitHub repository name.");
};

const ensureData = async () => {
  await fs.mkdir(clonesDir, { recursive: true });
  await fs.mkdir(runsDir, { recursive: true });
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

// Serialize writes within this process and make each write atomic (temp file +
// rename) with a rolling .bak. A crash mid-write can no longer truncate
// notebook.json, and a recoverable copy is always kept. The app and the MCP
// server are separate processes sharing this file; atomic rename means it is
// always a complete valid file — worst case a rare simultaneous write is
// last-writer-wins, never corrupt.
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
    throw new Error("Paste a valid GitHub repository URL.");
  }

  if (parsed.hostname.replace(/^www\./, "").toLowerCase() !== "github.com") {
    throw new Error("Only github.com repository URLs are supported.");
  }

  const [owner, repoRaw] = parsed.pathname.split("/").filter(Boolean);
  const repo = repoRaw?.replace(/\.git$/i, "");
  if (!owner || !repo) throw new Error("The URL must include an owner and repository name.");
  assertRepo(owner, repo);
  return { owner, repo };
};

const gh = async (url, options = {}) => {
  const res = await fetch(url, { ...options, headers: { ...apiHeaders(), ...options.headers } });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub request failed (${res.status}). ${detail.slice(0, 180)}`);
  }
  return res.json();
};

const isoDaysAgo = (days) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

const normalizeTrending = (repo) => ({
  id: repo.full_name.toLowerCase(),
  owner: repo.owner?.login || repo.full_name.split("/")[0],
  name: repo.name,
  fullName: repo.full_name,
  description: repo.description || "",
  htmlUrl: repo.html_url,
  cloneUrl: repo.clone_url,
  language: repo.language || "",
  topics: Array.isArray(repo.topics) ? repo.topics : [],
  stars: repo.stargazers_count || 0,
  forks: repo.forks_count || 0,
  updatedAt: repo.updated_at,
  createdAt: repo.created_at
});

const searchRepos = async (query) => {
  const data = await gh(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=10`);
  return Array.isArray(data.items) ? data.items : [];
};

const trendingRepos = async () => {
  if (trendingCache.repos.length && Date.now() - Date.parse(trendingCache.fetchedAt) < 600000) return trendingCache;

  let repos = await searchRepos(`created:>${isoDaysAgo(14)} stars:>20`).catch(() => []);
  if (!repos.length) repos = await searchRepos(`pushed:>${isoDaysAgo(7)} stars:>1000`);
  trendingCache = { fetchedAt: new Date().toISOString(), repos: repos.slice(0, 10).map(normalizeTrending) };
  return trendingCache;
};

// Build a stored record from a GitHub repo object. Used both by the full
// fetch (with files + readme) and by lighter bulk paths (stars import) that
// only have the metadata and skip the extra per-repo API calls.
const recordFromMeta = (meta, { savedAt, files = [], readme = "" } = {}) => ({
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
});

const fetchRepo = async (owner, repo, savedAt) => {
  assertRepo(owner, repo);
  const meta = await gh(`https://api.github.com/repos/${owner}/${repo}`);
  const branch = meta.default_branch || "main";
  const files = await gh(`https://api.github.com/repos/${owner}/${repo}/contents?ref=${encodeURIComponent(branch)}`)
    .then((items) => (Array.isArray(items) ? items : []))
    .catch(() => []);
  const readme = await gh(`https://api.github.com/repos/${owner}/${repo}/readme?ref=${encodeURIComponent(branch)}`)
    .then((data) => (data.content ? Buffer.from(data.content, "base64").toString("utf8") : ""))
    .catch(() => "");
  return recordFromMeta(meta, { savedAt, files, readme });
};

const findRepo = (store, owner, repo) =>
  store.repos.find((item) => item.owner.toLowerCase() === owner.toLowerCase() && item.name.toLowerCase() === repo.toLowerCase());

const upsertRepo = async (repo) => {
  const store = await readStore();
  const i = store.repos.findIndex((item) => item.id === repo.id);
  const existed = i >= 0;
  store.repos = existed
    ? store.repos.map((item, idx) => (idx === i ? { ...item, ...repo, savedAt: item.savedAt } : item))
    : [...store.repos, repo];
  await writeStore(store);
  return { repo: store.repos.find((item) => item.id === repo.id), existed };
};

const patchRepo = async (repo, patch) => {
  const store = await readStore();
  let next;
  store.repos = store.repos.map((item) => {
    if (item.id !== repo.id) return item;
    next = { ...item, ...patch };
    return next;
  });
  await writeStore(store);
  return next;
};

const cloneTarget = (repo) => {
  const target = path.resolve(clonesDir, safeName(repo.owner), safeName(repo.name));
  const rootWithSep = `${path.resolve(clonesDir)}${path.sep}`;
  if (target !== path.resolve(clonesDir) && target.startsWith(rootWithSep)) return target;
  throw new Error("Clone path escaped the app data directory.");
};

const fileExists = (target) => fs.access(target).then(() => true).catch(() => false);

const logPath = (repo) => path.join(runsDir, `${safeName(repo.owner)}-${safeName(repo.name)}.log`);

const tailLog = async (repo) => {
  try {
    const text = await fs.readFile(logPath(repo), "utf8");
    return text.slice(-9000);
  } catch {
    return "";
  }
};

const detectRuntime = async (target) => {
  const pkgPath = path.join(target, "package.json");
  if (await fileExists(pkgPath)) {
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    const scripts = pkg.scripts || {};
    const script = scripts.dev ? "dev" : scripts.start ? "start" : scripts.serve ? "serve" : scripts.preview ? "preview" : "";
    return {
      type: "Node",
      install: { cmd: "npm", args: ["install"], label: "npm install" },
      start: script ? { cmd: "npm", args: script === "start" ? ["start"] : ["run", script], label: script === "start" ? "npm start" : `npm run ${script}` } : null
    };
  }

  if (await fileExists(path.join(target, "requirements.txt"))) {
    const pyEntry = await fileExists(path.join(target, "main.py"))
      ? "main.py"
      : await fileExists(path.join(target, "app.py"))
        ? "app.py"
        : await fileExists(path.join(target, "server.py"))
          ? "server.py"
          : "";
    return {
      type: "Python",
      install: { cmd: "python", args: ["-m", "pip", "install", "-r", "requirements.txt"], label: "pip install -r requirements.txt" },
      start: pyEntry ? { cmd: "python", args: [pyEntry], label: `python ${pyEntry}` } : null
    };
  }

  if (await fileExists(path.join(target, "pyproject.toml"))) {
    return {
      type: "Python",
      install: { cmd: "python", args: ["-m", "pip", "install", "-e", "."], label: "pip install -e ." },
      start: null
    };
  }

  if (await fileExists(path.join(target, "Cargo.toml"))) {
    return {
      type: "Rust",
      install: { cmd: "cargo", args: ["build"], label: "cargo build" },
      start: { cmd: "cargo", args: ["run"], label: "cargo run" }
    };
  }

  if (await fileExists(path.join(target, "go.mod"))) {
    return {
      type: "Go",
      install: { cmd: "go", args: ["mod", "download"], label: "go mod download" },
      start: { cmd: "go", args: ["run", "."], label: "go run ." }
    };
  }

  if (
    (await fileExists(path.join(target, "docker-compose.yml"))) ||
    (await fileExists(path.join(target, "docker-compose.yaml"))) ||
    (await fileExists(path.join(target, "compose.yaml")))
  ) {
    return {
      type: "Docker Compose",
      install: null,
      start: { cmd: "docker", args: ["compose", "up"], label: "docker compose up" }
    };
  }

  if (await fileExists(path.join(target, "Makefile"))) {
    return {
      type: "Make",
      install: null,
      start: { cmd: "make", args: [], label: "make" }
    };
  }

  return { type: "Onbekend", install: null, start: null };
};

const runtimeFor = async (repo) => {
  const target = cloneTarget(repo);
  if (!(await fileExists(target))) return { cloned: false, running: false, log: "" };
  const run = running.get(repo.id);
  return {
    cloned: true,
    localPath: target,
    commands: await detectRuntime(target),
    installStatus: repo.installStatus || "",
    installedAt: repo.installedAt || "",
    running: Boolean(run),
    pid: run?.child.pid || null,
    startedAt: run?.startedAt || "",
    url: run?.url || "",
    log: await tailLog(repo)
  };
};

const runGit = (args, cwd = root) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, shell: false });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("git timed out after 5 minutes."));
    }, 300000);

    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve({ out, err }) : reject(new Error((err || out || `git exited with ${code}`).slice(0, 1200)));
    });
  });

const appendLog = async (repo, text) => {
  await fs.mkdir(runsDir, { recursive: true });
  await fs.appendFile(logPath(repo), text);
};

const runCommand = async (repo, target, command, timeoutMs = 900000) => {
  await appendLog(repo, `\n\n$ ${command.label}\n`);
  return new Promise((resolve, reject) => {
    const spec = commandSpec(command.cmd, command.args);
    let child;
    try {
      child = spawn(spec.cmd, spec.args, { cwd: target, shell: false });
    } catch (error) {
      reject(error);
      return;
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command.label} timed out.`));
    }, timeoutMs);

    child.stdout.on("data", async (chunk) => {
      const text = chunk.toString();
      out += text;
      await appendLog(repo, text);
    });
    child.stderr.on("data", async (chunk) => {
      const text = chunk.toString();
      err += text;
      await appendLog(repo, text);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve({ out, err }) : reject(new Error((err || out || `${command.label} exited with ${code}`).slice(0, 1400)));
    });
  });
};

const startCommand = async (repo, target, command) => {
  await appendLog(repo, `\n\n$ ${command.label}\n`);
  const spec = commandSpec(command.cmd, command.args);
  let child;
  try {
    child = spawn(spec.cmd, spec.args, { cwd: target, shell: false });
  } catch (error) {
    await appendLog(repo, `\n[start error] ${error.message}\n`);
    throw error;
  }
  const startedAt = new Date().toISOString();
  const entry = { child, startedAt, command, url: "" };
  running.set(repo.id, entry);

  // Sniff the child's output for the dev-server URL so the UI can offer
  // "Open in browser" without you hunting for the port.
  const detectUrl = (text) => {
    if (entry.url) return;
    const match = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s"'`)]*/i);
    if (match) entry.url = match[0].replace("0.0.0.0", "localhost");
  };
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    detectUrl(text);
    appendLog(repo, text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    detectUrl(text);
    appendLog(repo, text);
  });
  child.on("error", (error) => appendLog(repo, `\n[start error] ${error.message}\n`));
  child.on("close", async (code) => {
    running.delete(repo.id);
    await appendLog(repo, `\n[process exited with ${code}]\n`);
  });

  return { pid: child.pid, startedAt };
};

const openPath = (target) => {
  const opener = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [target], { detached: true, shell: false, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
};

app.get("/api/notebook", async (_req, res) => {
  res.json(await readStore());
});

app.get("/api/trending", async (_req, res) => {
  try {
    res.json(await trendingRepos());
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/notebook", async (req, res) => {
  try {
    const { owner, repo } = parseRepo(req.body?.url);
    const { repo: saved, existed } = await upsertRepo(await fetchRepo(owner, repo));
    res.json({ repo: saved, existed });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/notebook/:owner/:repo/refresh", async (req, res) => {
  try {
    const store = await readStore();
    const existing = findRepo(store, req.params.owner, req.params.repo);
    if (!existing) return res.status(404).json({ error: "Repository is not saved yet." });
    const { repo } = await upsertRepo(await fetchRepo(existing.owner, existing.name, existing.savedAt));
    res.json({ repo });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/notebook/:owner/:repo/meta", async (req, res) => {
  try {
    const store = await readStore();
    const existing = findRepo(store, req.params.owner, req.params.repo);
    if (!existing) return res.status(404).json({ error: "Repository is not saved yet." });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const patch = {};
    if (typeof body.category === "string") patch.category = body.category.trim().slice(0, 60);
    if (typeof body.note === "string") patch.note = body.note.slice(0, 2000);
    if (typeof body.status === "string") {
      if (!ALLOWED_STATUS.has(body.status)) return res.status(400).json({ error: "Invalid status." });
      patch.status = body.status;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: "No category, status or note provided." });

    const updated = await patchRepo(existing, patch);
    res.json({ repo: updated });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/notebook/:owner/:repo", async (req, res) => {
  const store = await readStore();
  const repos = store.repos.filter(
    (item) => !(item.owner.toLowerCase() === req.params.owner.toLowerCase() && item.name.toLowerCase() === req.params.repo.toLowerCase())
  );
  await writeStore({ repos });
  res.json({ repos });
});

app.post("/api/notebook/:owner/:repo/clone", async (req, res) => {
  try {
    const store = await readStore();
    const repo = findRepo(store, req.params.owner, req.params.repo);
    if (!repo) return res.status(404).json({ error: "Repository is not saved yet." });

    const target = cloneTarget(repo);
    try {
      await fs.access(target);
      const updated = await patchRepo(repo, { cloneStatus: "exists", localPath: target, clonedAt: repo.clonedAt || new Date().toISOString() });
      return res.json({ status: "exists", path: target, repo: updated });
    } catch {
      await fs.mkdir(path.dirname(target), { recursive: true });
    }

    await runGit(["clone", req.body?.method === "ssh" ? repo.sshUrl : repo.cloneUrl, target]);
    const updated = await patchRepo(repo, { cloneStatus: "cloned", localPath: target, clonedAt: new Date().toISOString() });
    res.json({ status: "cloned", path: target, repo: updated });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/notebook/:owner/:repo/open-local", async (req, res) => {
  try {
    const store = await readStore();
    const repo = findRepo(store, req.params.owner, req.params.repo);
    if (!repo) return res.status(404).json({ error: "Repository is not saved yet." });

    const target = cloneTarget(repo);
    try {
      await fs.access(target);
    } catch {
      return res.status(404).json({ error: "Repository is not cloned yet." });
    }

    openPath(target);
    res.json({ status: "opened", path: target });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/notebook/:owner/:repo/runtime", async (req, res) => {
  try {
    const store = await readStore();
    const repo = findRepo(store, req.params.owner, req.params.repo);
    if (!repo) return res.status(404).json({ error: "Repository is not saved yet." });
    res.json(await runtimeFor(repo));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/notebook/:owner/:repo/log", async (req, res) => {
  try {
    const store = await readStore();
    const repo = findRepo(store, req.params.owner, req.params.repo);
    if (!repo) return res.status(404).json({ error: "Repository is not saved yet." });
    res.json({ log: await tailLog(repo) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/notebook/:owner/:repo/install", async (req, res) => {
  try {
    const store = await readStore();
    const repo = findRepo(store, req.params.owner, req.params.repo);
    if (!repo) return res.status(404).json({ error: "Repository is not saved yet." });
    const target = cloneTarget(repo);
    if (!(await fileExists(target))) return res.status(404).json({ error: "Repository is not cloned yet." });

    const commands = await detectRuntime(target);
    if (!commands.install) return res.status(400).json({ error: "No install command detected." });
    await runCommand(repo, target, commands.install);
    const updated = await patchRepo(repo, { installStatus: "installed", installedAt: new Date().toISOString() });
    res.json({ status: "installed", repo: updated, runtime: await runtimeFor(updated) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/notebook/:owner/:repo/start", async (req, res) => {
  try {
    const store = await readStore();
    const repo = findRepo(store, req.params.owner, req.params.repo);
    if (!repo) return res.status(404).json({ error: "Repository is not saved yet." });
    if (running.has(repo.id)) return res.json({ status: "running", runtime: await runtimeFor(repo) });

    const target = cloneTarget(repo);
    if (!(await fileExists(target))) return res.status(404).json({ error: "Repository is not cloned yet." });
    const commands = await detectRuntime(target);
    if (!commands.start) return res.status(400).json({ error: "No start command detected." });

    const started = await startCommand(repo, target, commands.start);
    const updated = await patchRepo(repo, { lastStartCommand: commands.start.label, lastStartedAt: started.startedAt });
    res.json({ status: "started", pid: started.pid, repo: updated, runtime: await runtimeFor(updated) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/notebook/:owner/:repo/stop", async (req, res) => {
  try {
    const store = await readStore();
    const repo = findRepo(store, req.params.owner, req.params.repo);
    if (!repo) return res.status(404).json({ error: "Repository is not saved yet." });
    const run = running.get(repo.id);
    if (!run) return res.json({ status: "stopped", runtime: await runtimeFor(repo) });

    if (process.platform === "win32") {
      spawn("taskkill.exe", ["/PID", String(run.child.pid), "/T", "/F"], { shell: false });
    } else {
      run.child.kill("SIGTERM");
    }
    running.delete(repo.id);
    await appendLog(repo, "\n[stopped from Repo Notebook]\n");
    res.json({ status: "stopped", runtime: await runtimeFor(repo) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --- AI provider: a local Ollama model by default (no tokens burned), or
// Anthropic / OpenAI when a key is set. Force one with RN_AI_PROVIDER, pick a
// model with RN_AI_MODEL. Auto-order prefers a running local Ollama. ---
const ollamaHost = () => {
  let raw = process.env.RN_OLLAMA_URL || process.env.OLLAMA_HOST || "127.0.0.1:11434";
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "http://127.0.0.1:11434";
  }
  // OLLAMA_HOST is the server *bind* address; a client cannot connect to
  // 0.0.0.0 / :: — those mean "all interfaces", so dial loopback instead.
  let hostname = url.hostname;
  if (hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]") hostname = "127.0.0.1";
  return `${url.protocol}//${hostname}:${url.port || "11434"}`;
};

const ollamaModels = async () => {
  try {
    const res = await fetch(`${ollamaHost()}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.models) ? data.models.map((m) => m.name).filter(Boolean) : [];
  } catch {
    return null;
  }
};

const resolveAi = async () => {
  const forced = (process.env.RN_AI_PROVIDER || "").toLowerCase();
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasOpenai = Boolean(process.env.OPENAI_API_KEY);
  if (forced === "anthropic") return { provider: "anthropic", available: hasAnthropic };
  if (forced === "openai") return { provider: "openai", available: hasOpenai };
  if (forced === "ollama") {
    const models = await ollamaModels();
    return { provider: "ollama", available: Array.isArray(models) && models.length > 0, models: models || [] };
  }
  // auto: prefer a running local Ollama (free), then a configured key
  const models = await ollamaModels();
  if (Array.isArray(models) && models.length) return { provider: "ollama", available: true, models };
  if (hasAnthropic) return { provider: "anthropic", available: true };
  if (hasOpenai) return { provider: "openai", available: true };
  return { provider: "ollama", available: false, models: [] };
};

const callAi = async (prompt) => {
  const ai = await resolveAi();
  if (!ai.available) return { available: false, provider: ai.provider };

  if (ai.provider === "ollama") {
    // Prefer a genuinely local model over any ":cloud" entry (those can bill).
    const model = process.env.RN_AI_MODEL || (ai.models || []).find((m) => !/:cloud$/i.test(m)) || ai.models?.[0] || "llama3.2";
    const res = await fetch(`${ollamaHost()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false, options: { temperature: 0.4 }, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(120000)
    });
    if (!res.ok) throw new Error(`Ollama-fout (${res.status}). Model '${model}' beschikbaar?`);
    const data = await res.json();
    return { available: true, provider: "ollama", model, text: (data.message?.content || "").trim() };
  }

  if (ai.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.RN_AI_MODEL || "claude-3-5-haiku-latest", max_tokens: 500, messages: [{ role: "user", content: prompt }] })
    });
    if (!res.ok) throw new Error(`Anthropic-fout (${res.status}). ${(await res.text().catch(() => "")).slice(0, 150)}`);
    const data = await res.json();
    return { available: true, provider: "anthropic", model: process.env.RN_AI_MODEL || "claude-3-5-haiku-latest", text: (data.content?.[0]?.text || "").trim() };
  }

  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.RN_AI_MODEL || "gpt-4o-mini", max_tokens: 500, messages: [{ role: "user", content: prompt }] })
  });
  if (!res.ok) throw new Error(`OpenAI-fout (${res.status}). ${(await res.text().catch(() => "")).slice(0, 150)}`);
  const data = await res.json();
  return { available: true, provider: "openai", model: process.env.RN_AI_MODEL || "gpt-4o-mini", text: (data.choices?.[0]?.message?.content || "").trim() };
};

// --- Capabilities the UI needs to know about (which AI is usable, GH rate limit) ---
app.get("/api/config", async (_req, res) => {
  const ai = await resolveAi();
  res.json({ ai: ai.available, aiProvider: ai.provider, token: Boolean(process.env.GITHUB_TOKEN) });
});

// --- Bulk add: paste any text (e.g. an Instagram caption) and save every
// github.com/owner/repo it mentions in one go. ---
app.post("/api/notebook/bulk", async (req, res) => {
  try {
    const text = String(req.body?.text || "");
    const explicit = Array.isArray(req.body?.urls) ? req.body.urls : [];
    const found = [...text.matchAll(/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/gi)].map(
      (m) => `${m[1]}/${m[2].replace(/\.git$/i, "")}`
    );
    const slugs = [...new Set([...explicit, ...found].map((s) => String(s).trim()).filter(Boolean))].slice(0, 40);
    const added = [];
    const existed = [];
    const failed = [];
    for (const slug of slugs) {
      try {
        const { owner, repo } = parseRepo(slug);
        const result = await upsertRepo(await fetchRepo(owner, repo));
        (result.existed ? existed : added).push(result.repo.fullName);
      } catch (error) {
        failed.push({ slug, error: error.message });
      }
    }
    res.json({ added, existed, failed, repos: (await readStore()).repos });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --- Import a user's public GitHub stars as a starter shelf (new repos only,
// never overwriting a repo you already curated). ---
app.post("/api/import-stars", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    if (!ownerPart.test(username)) return res.status(400).json({ error: "Invalid GitHub username." });

    const collected = [];
    for (let page = 1; page <= 4; page++) {
      const items = await gh(`https://api.github.com/users/${username}/starred?per_page=100&page=${page}`).catch(() => []);
      if (!Array.isArray(items) || !items.length) break;
      collected.push(...items);
      if (items.length < 100) break;
    }

    const store = await readStore();
    const have = new Set(store.repos.map((r) => r.id));
    let added = 0;
    let existed = 0;
    for (const meta of collected) {
      const id = meta.full_name?.toLowerCase();
      if (!id) continue;
      if (have.has(id)) {
        existed += 1;
        continue;
      }
      try {
        await upsertRepo(recordFromMeta(meta));
        have.add(id);
        added += 1;
      } catch {
        /* skip malformed */
      }
    }
    res.json({ added, existed, total: collected.length, repos: (await readStore()).repos });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --- Merge an exported notebook (adds repos not already present). ---
app.post("/api/import", async (req, res) => {
  try {
    const incoming = Array.isArray(req.body?.repos) ? req.body.repos : [];
    const store = await readStore();
    const have = new Set(store.repos.map((r) => r.id));
    const clean = [];
    for (const r of incoming) {
      if (!r || typeof r.id !== "string" || typeof r.fullName !== "string" || typeof r.owner !== "string" || typeof r.name !== "string") continue;
      if (have.has(r.id)) continue;
      have.add(r.id);
      clean.push(r);
    }
    if (clean.length) await writeStore({ repos: [...store.repos, ...clean] });
    res.json({ added: clean.length, repos: (await readStore()).repos });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --- git pull a cloned repo (fast-forward only). ---
app.post("/api/notebook/:owner/:repo/pull", async (req, res) => {
  try {
    const store = await readStore();
    const repo = findRepo(store, req.params.owner, req.params.repo);
    if (!repo) return res.status(404).json({ error: "Repository is not saved yet." });
    const target = cloneTarget(repo);
    if (!(await fileExists(target))) return res.status(404).json({ error: "Repository is not cloned yet." });

    await appendLog(repo, "\n\n$ git pull --ff-only\n");
    const { out, err } = await runGit(["pull", "--ff-only"], target);
    await appendLog(repo, (out || "") + (err || ""));
    const updated = await patchRepo(repo, { pulledAt: new Date().toISOString() });
    res.json({ status: "pulled", output: (out || err || "").slice(-2000), repo: updated, runtime: await runtimeFor(updated) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --- How many commits is the local clone behind its remote? ---
app.get("/api/notebook/:owner/:repo/updates", async (req, res) => {
  try {
    const store = await readStore();
    const repo = findRepo(store, req.params.owner, req.params.repo);
    if (!repo) return res.status(404).json({ error: "Repository is not saved yet." });
    const target = cloneTarget(repo);
    if (!(await fileExists(target))) return res.json({ cloned: false, behind: 0 });
    await runGit(["fetch", "--quiet"], target).catch(() => {});
    const { out } = await runGit(["rev-list", "--count", "HEAD..@{u}"], target).catch(() => ({ out: "0" }));
    res.json({ cloned: true, behind: parseInt(String(out).trim(), 10) || 0 });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --- On-disk size of a clone (walked on demand, not on every poll). ---
const dirSize = async (dir) => {
  let total = 0;
  const walk = async (d) => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else {
        try {
          total += (await fs.stat(p)).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  await walk(dir);
  return total;
};

app.get("/api/notebook/:owner/:repo/size", async (req, res) => {
  try {
    const store = await readStore();
    const repo = findRepo(store, req.params.owner, req.params.repo);
    if (!repo) return res.status(404).json({ error: "Repository is not saved yet." });
    const target = cloneTarget(repo);
    if (!(await fileExists(target))) return res.json({ bytes: 0 });
    res.json({ bytes: await dirSize(target) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --- Delete the cloned files (frees disk) but keep the saved entry. ---
app.post("/api/notebook/:owner/:repo/delete-clone", async (req, res) => {
  try {
    const store = await readStore();
    const repo = findRepo(store, req.params.owner, req.params.repo);
    if (!repo) return res.status(404).json({ error: "Repository is not saved yet." });
    const target = cloneTarget(repo); // guarded: cannot escape the data dir
    const run = running.get(repo.id);
    if (run) {
      if (process.platform === "win32") spawn("taskkill.exe", ["/PID", String(run.child.pid), "/T", "/F"], { shell: false });
      else run.child.kill("SIGTERM");
      running.delete(repo.id);
    }
    await fs.rm(target, { recursive: true, force: true });
    const updated = await patchRepo(repo, { cloneStatus: "", localPath: "", installStatus: "" });
    res.json({ status: "deleted", repo: updated, runtime: await runtimeFor(updated) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --- AI "is this worth trying?" verdict (only when ANTHROPIC_API_KEY is set). ---
const buildVerdictPrompt = (repo) => `Je helpt beslissen of een GitHub-repo de moeite is om te proberen. Wees eerlijk en beknopt.

Repo: ${repo.fullName}
Beschrijving: ${repo.description || "(geen)"}
Taal: ${repo.language || "?"} | Sterren: ${repo.stars} | Forks: ${repo.forks} | Open issues: ${repo.openIssues}
Laatste push: ${repo.pushedAt || "?"} | Gearchiveerd: ${repo.archived ? "ja" : "nee"}
Topics: ${(repo.topics || []).join(", ") || "(geen)"}

README (ingekort):
${(repo.readme || "(geen readme)").slice(0, 4000)}

Antwoord in het Nederlands, max 6 zinnen:
1. Wat doet dit precies? (1-2 zinnen)
2. Voor wie / wanneer nuttig?
3. Indruk van kwaliteit/activiteit (onderhouden? af?).
4. Eindoordeel: de moeite om te proberen? (ja / misschien / eerder niet) + 1 reden.`;

app.post("/api/notebook/:owner/:repo/verdict", async (req, res) => {
  try {
    const store = await readStore();
    const repo = findRepo(store, req.params.owner, req.params.repo);
    if (!repo) return res.status(404).json({ error: "Repository is not saved yet." });
    if (repo.aiVerdict && !req.body?.refresh) {
      return res.json({ available: true, verdict: repo.aiVerdict, provider: repo.aiProvider || "", cached: true });
    }

    const result = await callAi(buildVerdictPrompt(repo));
    if (!result.available) return res.json({ available: false, provider: result.provider });

    const verdict = result.text;
    const updated = await patchRepo(repo, { aiVerdict: verdict, aiVerdictAt: new Date().toISOString(), aiProvider: result.provider });
    res.json({ available: true, verdict, provider: result.provider, model: result.model || "", repo: updated });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

if (production) {
  const dist = path.join(root, "dist");
  app.use(express.static(dist));
  app.get("*", (_req, res) => createReadStream(path.join(dist, "index.html")).pipe(res));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({ root, appType: "spa", server: { middlewareMode: true } });
  app.use(vite.middlewares);
}

await ensureData();
app.listen(port, "127.0.0.1", () => {
  console.log(`Repo Notebook running at http://127.0.0.1:${port}`);
});
