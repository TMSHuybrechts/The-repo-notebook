import express from "express";
import fs from "node:fs/promises";
import { createReadStream, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildGraph } from "./graph.js";
import { createRepoNotebookMcpServer, MCP_VERSION } from "../mcp/server.js";

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
const terminalSessions = new Map();
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
// app://obsidian.md = the Obsidian plugin (obsidian-plugin/). A plugin already
// has full Node access on this machine, so allowing its origin adds no new
// exposure — it only lets the plugin's POSTs pass the CSRF check.
const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, "app://obsidian.md"]);
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

// --- MCP over HTTP ----------------------------------------------------------
// The same tools as mcp/server.js (stdio), served as stateless MCP Streamable
// HTTP on /mcp. It sits behind the localhost host/origin guard above, so only
// local clients (Claude Code, Codex CLI, a tunnel you start yourself) reach it.
const mcpEndpoint = `http://127.0.0.1:${port}/mcp`;
app.get("/api/mcp/status", (_req, res) => {
  res.json({
    enabled: true,
    name: "repo-notebook",
    version: MCP_VERSION,
    transports: ["streamable-http", "stdio"],
    endpoint: mcpEndpoint,
    stdio: `node ${path.join(root, "mcp", "server.js")}`,
    localOnly: true
  });
});

app.post("/mcp", async (req, res) => {
  const server = createRepoNotebookMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal MCP error" }, id: null });
    }
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

for (const method of ["get", "delete"]) {
  app[method]("/mcp", (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });
}

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

  // Python installs go into a venv inside the clone — never the global
  // site-packages, so a repo can't pollute or break the system Python.
  const venvPy = process.platform === "win32"
    ? path.join(target, ".venv", "Scripts", "python.exe")
    : path.join(target, ".venv", "bin", "python");
  const pythonPlan = async (installArgs, installLabel) => {
    const hasVenv = await fileExists(venvPy);
    const steps = [];
    if (!hasVenv) steps.push({ cmd: "python", args: ["-m", "venv", ".venv"], label: "python -m venv .venv" });
    steps.push({ cmd: venvPy, args: ["-m", "pip", "install", ...installArgs], label: `(.venv) pip install ${installLabel}` });
    return {
      hasVenv,
      install: { steps, label: hasVenv ? `(.venv) pip install ${installLabel}` : `venv aanmaken + pip install ${installLabel}` }
    };
  };

  if (await fileExists(path.join(target, "requirements.txt"))) {
    const pyEntry = await fileExists(path.join(target, "main.py"))
      ? "main.py"
      : await fileExists(path.join(target, "app.py"))
        ? "app.py"
        : await fileExists(path.join(target, "server.py"))
          ? "server.py"
          : "";
    const plan = await pythonPlan(["-r", "requirements.txt"], "-r requirements.txt");
    return {
      type: "Python",
      install: plan.install,
      start: pyEntry
        ? plan.hasVenv
          ? { cmd: venvPy, args: [pyEntry], label: `(.venv) python ${pyEntry}` }
          : { cmd: "python", args: [pyEntry], label: `python ${pyEntry}` }
        : null
    };
  }

  if (await fileExists(path.join(target, "pyproject.toml"))) {
    const plan = await pythonPlan(["-e", "."], "-e .");
    return {
      type: "Python",
      install: plan.install,
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
    mode: run?.mode || "",
    log: await tailLog(repo)
  };
};

const runGit = (args, cwd = root, timeoutMs = 300000) =>
  new Promise((resolve, reject) => {
    // Nooit om credentials vragen: een fetch op een verwijderde/private repo
    // moet snel falen, niet blijven hangen op een onzichtbare prompt.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_ASKPASS: "" };
    const child = spawn("git", args, { cwd, shell: false, env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`git timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

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

const startCommand = async (repo, target, command, opts = {}) => {
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
  const entry = { child, startedAt, command, url: "", mode: opts.mode || "", containerName: opts.containerName || "" };
  running.set(repo.id, entry);

  // Sniff the child's output for the dev-server URL so the UI can offer
  // "Open in browser" without you hunting for the port. The port is also
  // remembered on the repo record so the port guard can warn next time.
  const detectUrl = (text) => {
    if (entry.url) return;
    const match = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s"'`)]*/i);
    if (!match) return;
    entry.url = match[0].replace("0.0.0.0", "localhost");
    try {
      const parsed = new URL(entry.url);
      entry.port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    } catch {
      entry.port = "";
    }
    patchRepo(repo, { lastUrl: entry.url, lastPort: entry.port }).catch(() => {});
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

// --- Embedded terminal per clone ------------------------------------------
// One persistent shell per repo, rooted in its clone folder. Output is kept in
// memory (capped) and polled by the UI; input is plain lines to the shell's
// stdin. Commands run with the same trust as install/start: your own machine,
// your own choice. Only reachable through the localhost guard.
const TERMINAL_MAX_OUTPUT = 200000;
const TERMINAL_KEEP_OUTPUT = 160000;

const terminalShell = () => {
  if (process.platform === "win32") {
    const pwsh = process.env.RN_TERMINAL_SHELL || "powershell.exe";
    return { cmd: pwsh, args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "-"] };
  }
  const cmd = process.env.RN_TERMINAL_SHELL || process.env.SHELL || "/bin/bash";
  return { cmd, args: cmd.endsWith("bash") ? ["--noprofile", "--norc"] : [] };
};

const terminalSnapshot = (repo) => {
  const session = terminalSessions.get(repo.id);
  return {
    running: Boolean(session?.running),
    pid: session?.child.pid || null,
    startedAt: session?.startedAt || "",
    updatedAt: session?.updatedAt || "",
    output: session?.output || "",
    shell: session?.shell || "",
    cwd: session?.cwd || ""
  };
};

const appendTerminalOutput = (session, chunk) => {
  session.output += chunk.toString();
  if (session.output.length > TERMINAL_MAX_OUTPUT) session.output = session.output.slice(-TERMINAL_KEEP_OUTPUT);
  session.updatedAt = new Date().toISOString();
};

const startTerminalSession = async (repo, target) => {
  const existing = terminalSessions.get(repo.id);
  if (existing?.running) return existing;

  const shell = terminalShell();
  const child = spawn(shell.cmd, shell.args, {
    cwd: target,
    shell: false,
    windowsHide: true,
    env: { ...process.env, TERM: process.env.TERM || "xterm-256color", GIT_TERMINAL_PROMPT: "0" }
  });
  const session = {
    child,
    running: true,
    shell: path.basename(shell.cmd),
    cwd: target,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    output: `Repo Notebook terminal\nWerkmap: ${target}\nShell: ${path.basename(shell.cmd)}\n\n`
  };
  terminalSessions.set(repo.id, session);
  child.stdout.on("data", (chunk) => appendTerminalOutput(session, chunk));
  child.stderr.on("data", (chunk) => appendTerminalOutput(session, chunk));
  child.on("error", (error) => {
    appendTerminalOutput(session, `\n[terminalfout] ${error.message}\n`);
    session.running = false;
  });
  child.on("close", (code) => {
    appendTerminalOutput(session, `\n[terminal afgesloten met code ${code}]\n`);
    session.running = false;
  });

  if (process.platform === "win32") {
    child.stdin.write("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $OutputEncoding = [System.Text.UTF8Encoding]::new()\n");
  }
  return session;
};

const stopTerminalSession = (repo) => {
  const session = terminalSessions.get(repo.id);
  if (!session) return;
  if (session.running) {
    if (process.platform === "win32") {
      spawn("taskkill.exe", ["/PID", String(session.child.pid), "/T", "/F"], { shell: false, windowsHide: true });
    } else {
      session.child.kill("SIGTERM");
    }
  }
  session.running = false;
};

const stopAllTerminals = () => {
  for (const [id] of terminalSessions) stopTerminalSession({ id });
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

// --- Knowledge graph over the saved repos. Recomputed only when a repo is
// added/removed/refreshed or its category changes (readme tokenizing is the
// expensive part, so key the cache on exactly what feeds the graph). ---
// key starts null (not "") so an empty store — whose real key is "" — still
// differs from the initial state and gets built instead of returning null.
let graphCache = { key: null, graph: null };
app.get("/api/graph", async (_req, res) => {
  try {
    const store = await readStore();
    const key = store.repos.map((r) => `${r.id}|${r.fetchedAt}|${r.category || ""}`).join(";");
    if (graphCache.key !== key) {
      graphCache = { key, graph: buildGraph(store.repos) };
    }
    res.json(graphCache.graph);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
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
    if (typeof body.containerMode === "boolean") patch.containerMode = body.containerMode;
    if (typeof body.containerGpu === "boolean") patch.containerGpu = body.containerGpu;
    if (typeof body.containerPort === "string") {
      const port = body.containerPort.trim();
      if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
        return res.status(400).json({ error: "Ongeldige poort." });
      }
      patch.containerPort = port;
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

// --- Docker: containermodus per repo. Docker Desktop wordt on-demand
// gestart (Thomas houdt hem bewust uit voor RAM) en kan vanuit de app weer
// afgesloten worden zodra er geen rn-containers meer draaien. ---
const DOCKER_DESKTOP_EXE = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
const CONTAINER_IMAGES = { Node: "node:22", Python: "python:3.12", Go: "golang:1.23", Rust: "rust:1" };

const containerName = (repo) => `rn-${safeName(repo.owner)}-${safeName(repo.name)}`.toLowerCase();

const runQuick = (cmd, args, timeoutMs = 10000) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { shell: false });
    } catch {
      return resolve({ ok: false, out: "" });
    }
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, out });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (out += chunk.toString()));
    child.stderr.on("data", (chunk) => (out += chunk.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, out });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out });
    });
  });

const dockerStatus = async () => {
  const version = await runQuick("docker", ["--version"], 6000);
  if (!version.ok) return { installed: false, running: false };
  const info = await runQuick("docker", ["info", "--format", "{{.ServerVersion}}"], 6000);
  return { installed: true, running: info.ok && Boolean(info.out.trim()), version: info.ok ? info.out.trim() : "" };
};

const runningContainers = () =>
  [...running.values()].filter((entry) => entry.mode === "container").length;

app.get("/api/docker", async (_req, res) => res.json(await dockerStatus()));

app.post("/api/docker/start", async (_req, res) => {
  try {
    const status = await dockerStatus();
    if (!status.installed) return res.status(400).json({ error: "Docker Desktop is niet geïnstalleerd." });
    if (status.running) return res.json({ ...status, started: false });

    const child = spawn(DOCKER_DESKTOP_EXE, [], { detached: true, shell: false, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    // Poll tot de daemon antwoordt (image-engine opstarten duurt 20-60s).
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const check = await dockerStatus();
      if (check.running) return res.json({ ...check, started: true });
    }
    res.status(400).json({ error: "Docker-daemon kwam niet online binnen 90s. Kijk of Docker Desktop opstart." });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/docker/stop", async (_req, res) => {
  try {
    if (runningContainers() > 0) {
      return res.status(400).json({ error: "Er draaien nog containers vanuit Repo Notebook — stop die eerst." });
    }
    spawn("taskkill.exe", ["/IM", "Docker Desktop.exe", "/F"], { shell: false }).on("error", () => {});
    // WSL-backend meteen afbouwen, anders blijft de RAM bezet.
    setTimeout(() => {
      spawn("wsl.exe", ["--terminate", "docker-desktop"], { shell: false }).on("error", () => {});
    }, 2000);
    res.json({ stopped: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Bouw het docker-run-plan voor een repo: install + start gebeuren BINNEN de
// container (install is het echte risicomoment). Named volumes houden
// node_modules/pip-cache gescheiden van de host én versnellen herstarts.
const containerPlan = async (repo, target) => {
  const commands = await detectRuntime(target);
  if (commands.type === "Docker Compose") {
    return { command: { cmd: "docker", args: ["compose", "up"], label: "docker compose up" } };
  }
  const image = CONTAINER_IMAGES[commands.type];
  if (!image) return { error: `Containermodus ondersteunt nog geen ${commands.type}-repos.` };

  const name = containerName(repo);
  const port = String(repo.containerPort || repo.lastPort || "").trim();
  const inner = [];
  if (commands.type === "Node") {
    const script = commands.start?.label?.replace(/^npm /, "") || "";
    if (!script) return { error: "Geen startcommando gedetecteerd." };
    inner.push("npm install", `npm ${script}`);
  } else if (commands.type === "Python") {
    const hasReq = await fileExists(path.join(target, "requirements.txt"));
    inner.push(hasReq ? "pip install -r requirements.txt" : "pip install -e .");
    const entry = commands.start?.args?.[commands.start.args.length - 1];
    if (!entry || !/\.py$/.test(entry)) return { error: "Geen Python-startbestand (main/app/server.py) gevonden." };
    inner.push(`python ${entry}`);
  } else if (commands.type === "Go") {
    inner.push("go run .");
  } else if (commands.type === "Rust") {
    inner.push("cargo run");
  }

  const args = ["run", "--rm", "--name", name, "-v", `${target}:/app`, "-w", "/app", "-e", "HOST=0.0.0.0"];
  if (commands.type === "Node") args.push("-v", `${name}-modules:/app/node_modules`);
  if (commands.type === "Python") args.push("-v", `${name}-pip:/root/.cache/pip`);
  if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) < 65536) args.push("-p", `${port}:${port}`);
  if (repo.containerGpu) args.push("--gpus", "all");
  args.push(image, "sh", "-c", inner.join(" && "));
  return { command: { cmd: "docker", args, label: `docker run ${image} (${inner.join(" && ")})` }, name };
};

app.post("/api/notebook/:owner/:repo/start-container", async (req, res) => {
  try {
    const store = await readStore();
    const repo = findRepo(store, req.params.owner, req.params.repo);
    if (!repo) return res.status(404).json({ error: "Repository is not saved yet." });
    if (running.has(repo.id)) return res.json({ status: "running", runtime: await runtimeFor(repo) });
    const target = cloneTarget(repo);
    if (!(await fileExists(target))) return res.status(404).json({ error: "Repository is not cloned yet." });

    const docker = await dockerStatus();
    if (!docker.installed) return res.status(400).json({ error: "Docker Desktop is niet geïnstalleerd." });
    if (!docker.running) return res.status(400).json({ error: "Docker draait niet.", needsDocker: true });

    const plan = await containerPlan(repo, target);
    if (plan.error) return res.status(400).json({ error: plan.error });

    // Restje van een vorige run met dezelfde naam opruimen (best effort).
    if (plan.name) await runQuick("docker", ["rm", "-f", plan.name], 8000);

    const started = await startCommand(repo, target, plan.command, { mode: "container", containerName: plan.name });
    const updated = await patchRepo(repo, { lastStartCommand: plan.command.label, lastStartedAt: started.startedAt });
    res.json({ status: "started", pid: started.pid, repo: updated, runtime: await runtimeFor(updated) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --- .env per repo: lezen/schrijven in de clone-map, met .env.example als
// template. Pad ligt vast op <clone>/.env — geen traversal mogelijk. ---
const ENV_MAX_BYTES = 100000;
const ENV_EXAMPLE_NAMES = [".env.example", ".env.sample", ".env.template", "env.example"];

app.get("/api/notebook/:owner/:repo/env", async (req, res) => {
  try {
    const store = await readStore();
    const repo = findRepo(store, req.params.owner, req.params.repo);
    if (!repo) return res.status(404).json({ error: "Repository is not saved yet." });
    const target = cloneTarget(repo);
    if (!(await fileExists(target))) return res.status(404).json({ error: "Repository is not cloned yet." });

    const content = await fs.readFile(path.join(target, ".env"), "utf8").catch(() => null);
    let example = null;
    for (const name of ENV_EXAMPLE_NAMES) {
      const text = await fs.readFile(path.join(target, name), "utf8").catch(() => null);
      if (text !== null) {
        example = { name, content: text.slice(0, ENV_MAX_BYTES) };
        break;
      }
    }
    res.json({ exists: content !== null, content: content || "", example });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/notebook/:owner/:repo/env", async (req, res) => {
  try {
    const store = await readStore();
    const repo = findRepo(store, req.params.owner, req.params.repo);
    if (!repo) return res.status(404).json({ error: "Repository is not saved yet." });
    const target = cloneTarget(repo);
    if (!(await fileExists(target))) return res.status(404).json({ error: "Repository is not cloned yet." });

    const content = req.body?.content;
    if (typeof content !== "string") return res.status(400).json({ error: "content (string) is verplicht." });
    if (Buffer.byteLength(content, "utf8") > ENV_MAX_BYTES) return res.status(400).json({ error: ".env is te groot (max 100 KB)." });
    await fs.writeFile(path.join(target, ".env"), content, "utf8");
    res.json({ saved: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --- Bulk overzicht voor de Snelstart-tab: alle clones, wat draait waar. ---
app.get("/api/runtimes", async (_req, res) => {
  try {
    const store = await readStore();
    const items = [];
    for (const repo of store.repos) {
      const target = cloneTarget(repo);
      if (!(await fileExists(target))) continue;
      const commands = await detectRuntime(target);
      const run = running.get(repo.id);
      items.push({
        id: repo.id,
        owner: repo.owner,
        name: repo.name,
        fullName: repo.fullName,
        language: repo.language || "",
        category: repo.category || "",
        status: repo.status || "",
        localPath: target,
        type: commands.type,
        canStart: Boolean(commands.start),
        startLabel: commands.start?.label || "",
        installLabel: commands.install?.label || "",
        installStatus: repo.installStatus || "",
        installedAt: repo.installedAt || "",
        running: Boolean(run),
        pid: run?.child.pid || null,
        startedAt: run?.startedAt || "",
        url: run?.url || "",
        port: run?.port || "",
        mode: run?.mode || "",
        lastPort: repo.lastPort || "",
        lastUrl: repo.lastUrl || "",
        containerMode: Boolean(repo.containerMode),
        terminal: Boolean(terminalSessions.get(repo.id)?.running)
      });
    }
    items.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
    res.json({ items });
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

// --- Terminal endpoints ---
const terminalRepo = async (req, res) => {
  const store = await readStore();
  const repo = findRepo(store, req.params.owner, req.params.repo);
  if (!repo) {
    res.status(404).json({ error: "Repository is not saved yet." });
    return null;
  }
  const target = cloneTarget(repo); // guarded: cannot escape the data dir
  if (!(await fileExists(target))) {
    res.status(404).json({ error: "Repository is not cloned yet." });
    return null;
  }
  return { repo, target };
};

app.get("/api/notebook/:owner/:repo/terminal", async (req, res) => {
  try {
    const found = await terminalRepo(req, res);
    if (!found) return;
    res.json(terminalSnapshot(found.repo));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/notebook/:owner/:repo/terminal/start", async (req, res) => {
  try {
    const found = await terminalRepo(req, res);
    if (!found) return;
    await startTerminalSession(found.repo, found.target);
    res.json(terminalSnapshot(found.repo));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/notebook/:owner/:repo/terminal/input", async (req, res) => {
  try {
    const found = await terminalRepo(req, res);
    if (!found) return;
    const input = typeof req.body?.input === "string" ? req.body.input : "";
    if (!input.trim()) return res.status(400).json({ error: "Typ een commando." });
    if (input.length > 8000 || input.includes("\0")) return res.status(400).json({ error: "Terminal-invoer is ongeldig of te lang." });
    const session = await startTerminalSession(found.repo, found.target);
    if (!session.running) return res.status(409).json({ error: "De terminal is gestopt — open hem opnieuw." });
    appendTerminalOutput(session, `\n$ ${input}\n`);
    session.child.stdin.write(`${input}\n`);
    res.json(terminalSnapshot(found.repo));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/notebook/:owner/:repo/terminal/clear", async (req, res) => {
  try {
    const found = await terminalRepo(req, res);
    if (!found) return;
    const session = terminalSessions.get(found.repo.id);
    if (session) session.output = "";
    res.json(terminalSnapshot(found.repo));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/notebook/:owner/:repo/terminal/stop", async (req, res) => {
  try {
    const found = await terminalRepo(req, res);
    if (!found) return;
    stopTerminalSession(found.repo);
    res.json(terminalSnapshot(found.repo));
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
    for (const step of commands.install.steps || [commands.install]) {
      await runCommand(repo, target, step);
    }
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

    // Port guard: warn (niet blokkeren) als een andere draaiende repo de
    // laatst bekende poort van deze repo al bezet.
    let portWarning = "";
    if (repo.lastPort) {
      for (const [otherId, run] of running) {
        if (otherId !== repo.id && run.port && run.port === repo.lastPort) {
          const other = store.repos.find((item) => item.id === otherId);
          portWarning = `Let op: poort ${repo.lastPort} is al in gebruik door ${other?.fullName || otherId} — deze start pakt mogelijk een andere poort of faalt.`;
        }
      }
    }

    const started = await startCommand(repo, target, commands.start);
    const updated = await patchRepo(repo, { lastStartCommand: commands.start.label, lastStartedAt: started.startedAt });
    res.json({ status: "started", pid: started.pid, portWarning, repo: updated, runtime: await runtimeFor(updated) });
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

    // Container: de docker-client killen stopt de container niet — netjes
    // docker stop sturen (de --rm ruimt hem daarna zelf op).
    if (run.mode === "container" && run.containerName) {
      await runQuick("docker", ["stop", "-t", "5", run.containerName], 20000);
    }
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
    await runGit(["-c", "credential.helper=", "-c", "credential.interactive=false", "fetch", "--quiet"], target, 30000).catch(() => {});
    const { out } = await runGit(["rev-list", "--count", "HEAD..@{u}"], target).catch(() => ({ out: "0" }));
    res.json({ cloned: true, behind: parseInt(String(out).trim(), 10) || 0 });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --- Eén klik: alle clones fetchen en tellen wie achterloopt (cap 4 parallel). ---
app.get("/api/updates-all", async (_req, res) => {
  try {
    const store = await readStore();
    const cloned = [];
    for (const repo of store.repos) {
      const target = cloneTarget(repo);
      if (await fileExists(target)) cloned.push({ repo, target });
    }
    const results = [];
    let index = 0;
    const worker = async () => {
      while (index < cloned.length) {
        const item = cloned[index++];
        try {
          // 30s per fetch: één corrupte of tergend trage clone mag de rest
          // niet ophouden (fetch is normaal 1-2s).
          await runGit(["-c", "credential.helper=", "-c", "credential.interactive=false", "fetch", "--quiet"], item.target, 30000);
          const { out } = await runGit(["rev-list", "--count", "HEAD..@{u}"], item.target, 15000).catch(() => ({ out: "0" }));
          results.push({ id: item.repo.id, behind: parseInt(String(out).trim(), 10) || 0 });
        } catch (error) {
          results.push({ id: item.repo.id, behind: 0, error: error.message.slice(0, 120) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, cloned.length) }, worker));
    res.json({ items: results, checkedAt: new Date().toISOString() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --- Dubbel-detectie: staat een opgeslagen repo óók ergens anders gekloond
// (bv. in een eigen clones-map, opgegeven via RN_EXTRA_CLONE_DIRS)? Match op
// de remote-URL in .git/config, met mapnaam als fallback. Cache 10 min. ---
const extraCloneDirs = () =>
  (process.env.RN_EXTRA_CLONE_DIRS || "")
    .split(";")
    .map((dir) => dir.trim())
    .filter(Boolean);

let externalCloneCache = { at: 0, map: null };
const scanExternalClones = async () => {
  if (externalCloneCache.map && Date.now() - externalCloneCache.at < 600000) return externalCloneCache.map;
  const map = new Map();
  for (const dir of extraCloneDirs()) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const repoPath = path.join(dir, entry.name);
      const config = await fs.readFile(path.join(repoPath, ".git", "config"), "utf8").catch(() => "");
      const match = config.match(/github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/);
      if (match) {
        map.set(`${match[1]}/${match[2].replace(/\.git$/i, "")}`.toLowerCase(), repoPath);
      } else {
        map.set(`*/${entry.name.toLowerCase()}`, repoPath);
      }
    }
  }
  externalCloneCache = { at: Date.now(), map };
  return map;
};

app.get("/api/duplicates", async (_req, res) => {
  try {
    const store = await readStore();
    const map = await scanExternalClones();
    const items = [];
    for (const repo of store.repos) {
      const hit = map.get(repo.id) || map.get(`*/${repo.name.toLowerCase()}`);
      if (hit) items.push({ id: repo.id, path: hit });
    }
    res.json({ items, dirs: extraCloneDirs() });
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
    stopTerminalSession(repo);
    terminalSessions.delete(repo.id);
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

// --- Bulk-AI: werk alle repos zonder oordeel af, sequentieel via de lokale
// provider (Ollama gratis). Achtergrondjob; GET geeft de voortgang. Stopt
// zichzelf na 5 fouten op rij zodat een platte provider geen 60 fouten stapelt. ---
let bulkVerdict = { running: false, total: 0, done: 0, current: "", errors: [], provider: "", startedAt: "" };

app.get("/api/verdicts/bulk", (_req, res) => res.json(bulkVerdict));

app.post("/api/verdicts/bulk", async (req, res) => {
  try {
    if (bulkVerdict.running) return res.json(bulkVerdict);
    const store = await readStore();
    const missing = store.repos.filter((repo) => !repo.aiVerdict);
    if (!missing.length) return res.json({ ...bulkVerdict, running: false, total: 0, done: 0 });
    const ai = await resolveAi();
    if (!ai.available) return res.status(400).json({ error: "Geen AI beschikbaar — start Ollama of zet een API-key." });
    // Bulk = tientallen calls. Standaard enkel via de gratis lokale Ollama;
    // een betalende key gebruiken moet een bewuste keuze zijn (force: true).
    if (ai.provider !== "ollama" && !req.body?.force) {
      return res.status(400).json({ error: `Bulk zou nu via ${ai.provider} lopen (betalend). Start Ollama voor gratis lokale oordelen, of forceer bewust.`, needsForce: true });
    }

    bulkVerdict = { running: true, total: missing.length, done: 0, current: "", errors: [], provider: ai.provider, startedAt: new Date().toISOString() };
    (async () => {
      let consecutiveErrors = 0;
      for (const repo of missing) {
        bulkVerdict.current = repo.fullName;
        try {
          const result = await callAi(buildVerdictPrompt(repo));
          if (!result.available) throw new Error("AI-provider weggevallen");
          await patchRepo(repo, { aiVerdict: result.text, aiVerdictAt: new Date().toISOString(), aiProvider: result.provider });
          consecutiveErrors = 0;
        } catch (error) {
          consecutiveErrors += 1;
          bulkVerdict.errors.push(`${repo.fullName}: ${error.message.slice(0, 100)}`);
          if (consecutiveErrors >= 5) {
            bulkVerdict.errors.push("Gestopt na 5 fouten op rij.");
            break;
          }
        }
        bulkVerdict.done += 1;
      }
      bulkVerdict.running = false;
      bulkVerdict.current = "";
    })();
    res.json(bulkVerdict);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Unknown /api/* paths get a JSON 404 instead of falling through to the SPA.
app.use("/api", (req, res) => {
  res.status(404).json({ error: `Unknown API route: ${req.method} /api${req.path}` });
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

// --- server.json: tells clients (the Obsidian plugin, scripts) where this
// server lives. The desktop app picks a free port at every start, so the port
// can't be hardcoded anywhere else. Removed again on a clean shutdown; a
// stale file after a hard kill is harmless (clients probe before trusting it).
const serverInfoPath = path.join(dataDir, "server.json");
const writeServerInfo = async () => {
  try {
    await fs.writeFile(
      serverInfoPath,
      `${JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString(), dataDir, mode: production ? "production" : "dev", mcp: mcpEndpoint }, null, 2)}\n`
    );
  } catch {
    /* non-fatal */
  }
};
const removeServerInfo = () => {
  try {
    const current = JSON.parse(readFileSync(serverInfoPath, "utf8"));
    if (current.pid === process.pid) unlinkSync(serverInfoPath);
  } catch {
    /* already gone or not ours */
  }
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stopAllTerminals();
    removeServerInfo();
    process.exit(0);
  });
}
process.on("exit", removeServerInfo);

app.listen(port, "127.0.0.1", () => {
  console.log(`Repo Notebook running at http://127.0.0.1:${port}`);
  void writeServerInfo();
});
