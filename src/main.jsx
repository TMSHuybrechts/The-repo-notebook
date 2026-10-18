import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Container,
  Copy,
  Download,
  ExternalLink,
  Eye,
  File,
  Folder,
  FolderOpen,
  GitBranch,
  GitFork,
  Github,
  Globe,
  GripHorizontal,
  HardDriveDownload,
  List,
  Loader2,
  Maximize2,
  Minus,
  Network,
  PackageCheck,
  Play,
  Plus,
  Radio,
  RefreshCcw,
  Search,
  Sparkles,
  Square,
  Star,
  Stethoscope,
  Terminal,
  Trash2,
  Upload,
  X,
  Zap
} from "lucide-react";
import { bulkSave, bulkVerdictStatus, checkUpdates, clearTerminal, cloneRepo, deleteClone, diagnoseRepo, dockerStart, dockerStatus, dockerStop, harvest, importNotebook, importStars, installRepo, loadConfig, loadDuplicates, loadEnv, loadGraph, loadLog, loadMcpStatus, loadNotebook, loadRuntime, loadSuggestions, loadTerminal, loadTrending, openLocalRepo, pullRepo, refreshRepo, removeRepo, repoSize, repoVerdict, saveEnv, saveRepo, sendTerminalInput, setRepoMeta, startBulkVerdicts, startContainer, startRepo, startTerminal, stopRepo, stopTerminal } from "./api";
import { GraphView, RelatedPanel } from "./graph-view.jsx";
import { QuickstartView } from "./quickstart.jsx";
import { fileSize, languageColor, letters, repoLetter, shortDate, shortNumber } from "./format";
import "./styles.css";

const STATUS = {
  todo: { label: "Te proberen", color: "#58a6ff" },
  installed: { label: "Geïnstalleerd", color: "#f0883e" },
  keep: { label: "Bevalt", color: "#4fd1a5" },
  archive: { label: "Archief", color: "#8b949e" }
};
const STATUS_ORDER = ["todo", "installed", "keep", "archive"];

const repoText = (repo) =>
  [repo.owner, repo.name, repo.fullName, repo.description, repo.language, repo.category, repo.note, repo.readme, ...(repo.topics || [])]
    .join(" ")
    .toLowerCase();

// Health from last-push age + archived flag — a quick "is this alive?" read.
const repoHealth = (repo) => {
  if (repo.archived) return { key: "archived", label: "Gearchiveerd", color: "#8b949e" };
  if (!repo.pushedAt) return null;
  const days = (Date.now() - Date.parse(repo.pushedAt)) / 86400000;
  if (days <= 90) return { key: "active", label: "Actief", color: "#4fd1a5" };
  if (days <= 365) return { key: "quiet", label: "Stil", color: "#f0b429" };
  return { key: "stale", label: "Verouderd", color: "#f0883e" };
};

const formatBytes = (bytes) => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
};

const escapeHtml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Minimal, XSS-safe markdown → HTML: every value is HTML-escaped first and only
// a safe subset of tags is re-introduced; links are restricted to http(s).
const renderReadme = (md) => {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let para = [];
  let list = null;
  let items = [];
  let inCode = false;
  let code = [];
  const inline = (text) =>
    escapeHtml(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list && items.length) html.push(`<${list}>${items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list}>`);
    list = null;
    items = [];
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith("```")) {
      flushPara();
      flushList();
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
        inCode = false;
      } else inCode = true;
      continue;
    }
    if (inCode) {
      code.push(raw);
      continue;
    }
    if (!t) {
      flushPara();
      flushList();
      continue;
    }
    const heading = t.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(heading[1].length, 6);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flushPara();
      flushList();
      html.push("<hr>");
      continue;
    }
    const quote = t.match(/^>\s?(.*)$/);
    if (quote) {
      flushPara();
      flushList();
      html.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    const ul = t.match(/^[-*+]\s+(.+)$/);
    if (ul) {
      flushPara();
      if (list && list !== "ul") flushList();
      list = "ul";
      items.push(ul[1]);
      continue;
    }
    const ol = t.match(/^\d+\.\s+(.+)$/);
    if (ol) {
      flushPara();
      if (list && list !== "ol") flushList();
      list = "ol";
      items.push(ol[1]);
      continue;
    }
    flushList();
    para.push(t);
  }
  if (inCode) html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  flushPara();
  flushList();
  return html.join("");
};

const repoSorter = new Intl.Collator("nl-BE", { numeric: true, sensitivity: "base" });

const sorted = (repos) =>
  [...repos].sort((a, b) => repoSorter.compare(a.name, b.name) || repoSorter.compare(a.owner, b.owner));

function App() {
  const [repos, setRepos] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [letter, setLetter] = useState("");
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [cloneFor, setCloneFor] = useState(null);
  const [trending, setTrending] = useState([]);
  const [trendingError, setTrendingError] = useState("");
  const [config, setConfig] = useState({ ai: false, token: false });
  const [addOpen, setAddOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [view, setView] = useState("list");
  const [graph, setGraph] = useState(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [suggestions, setSuggestions] = useState(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [dups, setDups] = useState({});
  const [aiJob, setAiJob] = useState(null);

  // Elders-gekloond-scan (repoget-map e.d.) + lopende bulk-AI-job oppikken.
  useEffect(() => {
    loadDuplicates()
      .then((data) => setDups(Object.fromEntries((data.items || []).map((item) => [item.id, item.path]))))
      .catch(() => {});
    bulkVerdictStatus()
      .then((status) => status.running && setAiJob(status))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!aiJob?.running) return undefined;
    const timer = setInterval(() => {
      bulkVerdictStatus()
        .then((status) => {
          setAiJob(status);
          if (!status.running) {
            loadNotebook().then(({ repos: fresh }) => setRepos(fresh)).catch(() => {});
          }
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [aiJob?.running]);

  const missingVerdicts = useMemo(() => repos.filter((repo) => !repo.aiVerdict).length, [repos]);

  const runBulkAi = async () => {
    setError("");
    try {
      setAiJob(await startBulkVerdicts());
    } catch (err) {
      setError(err.message);
    }
  };

  // Rebuild the knowledge map whenever the shelf changes (add/remove/refresh
  // or a category edit) — the server caches, so this is cheap when unchanged.
  const graphKey = useMemo(
    () => repos.map((repo) => `${repo.id}|${repo.fetchedAt}|${repo.category || ""}`).join(";"),
    [repos]
  );
  useEffect(() => {
    if (!repos.length) return;
    setGraphLoading(true);
    loadGraph()
      .then(setGraph)
      .catch(() => {})
      .finally(() => setGraphLoading(false));
  }, [graphKey]);

  // Deep link: /#repo=owner/name selects that repo (used by the Obsidian
  // plugin's "open in Repo Notebook"). Also reacts to later hash changes.
  const hashRepoId = () => {
    const m = /^#repo=(.+)$/.exec(window.location.hash || "");
    return m ? decodeURIComponent(m[1]).toLowerCase() : "";
  };
  useEffect(() => {
    loadNotebook()
      .then(({ repos }) => {
        setRepos(repos);
        const wanted = hashRepoId();
        const hit = wanted && repos.find((repo) => repo.id === wanted);
        setSelectedId(hit ? hit.id : repos[0]?.id || "");
      })
      .catch((err) => setError(err.message));
  }, []);
  useEffect(() => {
    const onHash = () => {
      const wanted = hashRepoId();
      if (!wanted) return;
      setRepos((items) => {
        if (items.some((repo) => repo.id === wanted)) {
          setLetter("");
          setCatFilter("");
          setStatusFilter("");
          setSelectedId(wanted);
          setView("list");
        }
        return items;
      });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const { repos } = await loadTrending();
        if (active) {
          setTrending(repos || []);
          setTrendingError("");
        }
      } catch (err) {
        if (active) setTrendingError(err.message);
      }
    };
    load();
    const timer = setInterval(load, 600000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    loadConfig().then(setConfig).catch(() => {});
  }, []);

  const groups = useMemo(
    () =>
      sorted(repos).reduce((map, repo) => {
        const key = repoLetter(repo);
        return { ...map, [key]: [...(map[key] || []), repo] };
      }, {}),
    [repos]
  );

  const categories = useMemo(
    () =>
      [...new Set(repos.map((repo) => (repo.category || "").trim()).filter(Boolean))].sort((a, b) =>
        repoSorter.compare(a, b)
      ),
    [repos]
  );

  const filtered = useMemo(
    () =>
      sorted(repos).filter(
        (repo) =>
          (!letter || repoLetter(repo) === letter) &&
          (!catFilter || (repo.category || "") === catFilter) &&
          (!statusFilter || (repo.status || "") === statusFilter) &&
          (!query.trim() || repoText(repo).includes(query.trim().toLowerCase()))
      ),
    [repos, letter, catFilter, statusFilter, query]
  );

  const selected = repos.find((repo) => repo.id === selectedId) || filtered[0] || repos[0];
  const updateRepo = (repo) => setRepos((items) => sorted(items.map((item) => (item.id === repo.id ? repo : item))));

  const saveUrl = async (input, options = {}) => {
    if (!input.trim()) return;
    setBusy(options.busy || "save");
    setError("");
    setNotice("");
    try {
      const { repo, existed } = await saveRepo(input.trim());
      setRepos((items) => sorted([repo, ...items.filter((item) => item.id !== repo.id)]));
      setSelectedId(repo.id);
      setLetter(repoLetter(repo));
      if (options.clear) setUrl("");
      setNotice(existed ? `Stond al in je notebook — bijgewerkt: ${repo.fullName}` : `Toegevoegd: ${repo.fullName}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const save = async (event) => {
    event.preventDefault();
    await saveUrl(url, { clear: true });
  };

  const saveTrending = (repo) => saveUrl(repo.htmlUrl, { busy: `trend:${repo.id}` });

  // Suggestions for the map: fetched lazily the first time the toggle goes on.
  const fetchSuggestions = async (refresh = false) => {
    if (suggestionsLoading) return;
    setSuggestionsLoading(true);
    setError("");
    try {
      setSuggestions(await loadSuggestions(refresh));
    } catch (err) {
      setError(err.message);
    } finally {
      setSuggestionsLoading(false);
    }
  };

  const saveSuggestion = (node) =>
    saveUrl(node.htmlUrl || `https://github.com/${node.fullName}`, { busy: `suggest:${node.id}` });

  const refresh = async () => {
    if (!selected) return;
    setBusy("refresh");
    setError("");
    try {
      const { repo } = await refreshRepo(selected);
      setRepos((items) => items.map((item) => (item.id === repo.id ? repo : item)));
      setSelectedId(repo.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const remove = async () => {
    if (!selected || !confirm(`${selected.fullName} verwijderen uit Repo Notebook?`)) return;
    setBusy("remove");
    setError("");
    try {
      const { repos } = await removeRepo(selected);
      setRepos(repos);
      setSelectedId(repos[0]?.id || "");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const openLocal = async () => {
    if (!selected) return;
    setBusy("open-local");
    setError("");
    try {
      await openLocalRepo(selected);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const openFromMap = (id) => {
    setCatFilter("");
    setStatusFilter("");
    setLetter("");
    setSelectedId(id);
    setView("list");
  };

  return (
    <main className="app">
      <TopBar busy={busy} error={error} notice={notice} openAdd={() => setAddOpen(true)} openMcp={() => setMcpOpen(true)} query={query} setQuery={setQuery} save={save} setUrl={setUrl} url={url} />
      <TrendingTicker busy={busy} error={trendingError} onSave={saveTrending} repos={trending} />
      <div className="viewbar">
        <div className="viewbar-tools">
          {((config.aiProvider === "ollama" && missingVerdicts > 0) || aiJob) && (
            <button className="ai-bulk" disabled={Boolean(aiJob?.running)} onClick={runBulkAi} title="Laat de lokale AI (Ollama) alle repos zonder oordeel afwerken — enkel zichtbaar als Ollama draait" type="button">
              {aiJob?.running ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />}
              {aiJob?.running
                ? `AI-oordelen: ${aiJob.done}/${aiJob.total}${aiJob.current ? ` — ${aiJob.current}` : ""}`
                : aiJob
                  ? `AI klaar (${aiJob.done}/${aiJob.total}${aiJob.errors?.length ? `, ${aiJob.errors.length} fouten` : ""})`
                  : `AI-oordelen aanvullen (${missingVerdicts})`}
            </button>
          )}
        </div>
        <div className="segment view-switch">
          <button className={view === "list" ? "active" : ""} onClick={() => setView("list")} type="button">
            <List size={15} /> Lijst
          </button>
          <button className={view === "map" ? "active" : ""} onClick={() => setView("map")} type="button">
            <Network size={15} /> Kaart
          </button>
          <button className={view === "run" ? "active" : ""} onClick={() => setView("run")} type="button">
            <Zap size={15} /> Snelstart
          </button>
          <button className={view === "harvest" ? "active" : ""} onClick={() => setView("harvest")} type="button">
            <Globe size={15} /> Oogst
          </button>
        </div>
      </div>
      {view === "map" ? (
        <section className="workspace map-mode">
          <GraphView
            busy={busy}
            graph={graph}
            loading={graphLoading}
            onLoadSuggestions={fetchSuggestions}
            onOpenRepo={openFromMap}
            onSaveSuggestion={saveSuggestion}
            suggestions={suggestions}
            suggestionsLoading={suggestionsLoading}
          />
        </section>
      ) : view === "run" ? (
        <section className="workspace map-mode">
          <QuickstartView dups={dups} onOpenRepo={openFromMap} />
        </section>
      ) : view === "harvest" ? (
        <section className="workspace map-mode">
          <HarvestView onRepos={(items) => setRepos(sorted(items))} repos={repos} setNotice={setNotice} />
        </section>
      ) : (
      <section className="workspace">
        <LetterRail groups={groups} letter={letter} setLetter={setLetter} />
        <NotebookList
          categories={categories}
          catFilter={catFilter}
          filtered={filtered}
          repos={repos}
          selected={selected}
          setCatFilter={setCatFilter}
          setLetter={setLetter}
          setSelectedId={setSelectedId}
          setStatusFilter={setStatusFilter}
          statusFilter={statusFilter}
        />
        <RepoDetail
          busy={busy}
          categories={categories}
          config={config}
          dupPath={selected ? dups[selected.id] : ""}
          graph={graph}
          refresh={refresh}
          remove={remove}
          openLocal={openLocal}
          onRepoUpdate={updateRepo}
          onSelectRepo={setSelectedId}
          repo={selected}
          setCloneFor={setCloneFor}
        />
      </section>
      )}
      {cloneFor && (
        <CloneDialog
          repo={cloneFor}
          onRepoUpdate={updateRepo}
          setCloneFor={setCloneFor}
        />
      )}
      {addOpen && (
        <AddModal
          hasToken={config.token}
          onClose={() => setAddOpen(false)}
          onRepos={(items) => setRepos(sorted(items))}
          repos={repos}
          setNotice={setNotice}
        />
      )}
      {mcpOpen && <McpDialog onClose={() => setMcpOpen(false)} />}
    </main>
  );
}

function looksLikeRepoUrl(text) {
  return /github\.com[/:][^/\s]+\/[^/\s]+/i.test(text || "");
}

function TopBar({ busy, error, notice, openAdd, openMcp, query, save, setQuery, setUrl, url }) {
  const autoPasteFromClipboard = async () => {
    if (url.trim()) return; // niet overschrijven wat er al staat
    try {
      const text = (await navigator.clipboard?.readText())?.trim();
      if (text && looksLikeRepoUrl(text)) setUrl(text);
    } catch {
      // klembord niet leesbaar (permissie/focus) — stil negeren
    }
  };
  // Ook auto-plakken zodra het venster terug focus krijgt (alt-tab / aanklikken),
  // niet enkel bij een klik in het veld. Klik blijft als vangnet.
  useEffect(() => {
    const onFocus = () => { autoPasteFromClipboard(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }); // elke render opnieuw: sluit correct over de actuele url-guard
  return (
    <header className="topbar">
      <div className="brand">
        <BookOpen size={24} />
        <span>Repo Notebook</span>
        <button className="mcp-chip" onClick={openMcp} title="MCP-server: koppel Claude Code, Codex of een andere agent" type="button">
          <span /> MCP
        </button>
      </div>
      <form className="save-form" onSubmit={save}>
        <input
          aria-label="GitHub repository URL"
          onChange={(event) => setUrl(event.target.value)}
          onClick={autoPasteFromClipboard}
          placeholder="GitHub repo-URL plakken (klik = auto-plak)"
          value={url}
        />
        <button className="primary" disabled={busy === "save"}>
          {busy === "save" ? <Loader2 className="spin" size={17} /> : <Github size={17} />}
          Repo opslaan
        </button>
      </form>
      <button className="ghost add-btn" onClick={openAdd} title="Bulk toevoegen, Stars importeren, import/export" type="button">
        <ClipboardList size={16} /> Toevoegen
      </button>
      <label className="search">
        <Search size={18} />
        <input
          aria-label="Zoek opgeslagen repositories"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Zoek opgeslagen repos..."
          value={query}
        />
      </label>
      {error && <div className="toast">{error}</div>}
      {!error && notice && <div className="toast notice">{notice}</div>}
    </header>
  );
}

const HARVEST_TAGS = {
  eigen: { label: "eigen repo", color: "#3fb950" },
  star: { label: "gestard", color: "#d29922" },
  zoek: { label: "gezocht", color: "#58a6ff" },
  link: { label: "link", color: "#bc8cff" }
};
const HARVEST_MODE_LABEL = {
  account: "Account → eigen repos + stars",
  links: "Links uit de tekst",
  search: "GitHub-zoek op naam",
  mixed: "Links + naam-zoek",
  page: "Pagina opgehaald → links eruit"
};

// Oogst: haal repos op uit een GitHub-account, uit geplakte tool-namen/tekst,
// of uit een pagina-URL — tijdelijk, kies wat je wilt, dan naar de notebook.
function HarvestView({ onRepos, repos, setNotice }) {
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [picked, setPicked] = useState(() => new Set());

  const have = useMemo(() => new Set((repos || []).map((r) => r.id)), [repos]);
  const candidates = result?.candidates || [];
  const freshIds = useMemo(() => candidates.filter((c) => !have.has(c.id)).map((c) => c.id), [candidates, have]);

  const run = async (event) => {
    event?.preventDefault?.();
    const src = source.trim();
    if (!src || loading) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const data = await harvest(src);
      setResult(data);
      setPicked(new Set((data.candidates || []).filter((c) => !have.has(c.id)).map((c) => c.id)));
    } catch (err) {
      setError(err.message || "Ophalen mislukt.");
    } finally {
      setLoading(false);
    }
  };

  const toggle = (id) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    const slugs = candidates.filter((c) => picked.has(c.id)).map((c) => `${c.owner}/${c.name}`);
    if (!slugs.length || saving) return;
    setSaving(true);
    setError("");
    try {
      const res = await bulkSave(slugs.join("\n"));
      onRepos(res.repos);
      setNotice(`Oogst binnen: ${res.added.length} nieuw${res.existed.length ? `, ${res.existed.length} bestonden al` : ""}${res.failed.length ? `, ${res.failed.length} mislukt` : ""}.`);
      setResult(null);
      setSource("");
      setPicked(new Set());
    } catch (err) {
      setError(err.message || "Bewaren mislukt.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="harvest">
      <style>{`
        .harvest { padding: 20px 24px; max-width: 1020px; margin: 0 auto; width: 100%; overflow-y: auto; color: #e6edf3; }
        .harvest-intro h2 { display:flex; align-items:center; gap:8px; margin:0 0 6px; font-size:1.15rem; }
        .harvest-intro p { margin:0 0 16px; color:#8b949e; line-height:1.55; font-size:.9rem; }
        .harvest-intro code { background:#161b22; border:1px solid #30363d; border-radius:5px; padding:1px 6px; color:#e6edf3; font-size:.85em; }
        .harvest-form { display:flex; gap:10px; align-items:flex-start; margin-bottom:14px; }
        .harvest-form textarea { flex:1; background:#0d1117; border:1px solid #30363d; border-radius:10px; color:#e6edf3; padding:10px 12px; font-family:inherit; font-size:.9rem; resize:vertical; min-height:66px; }
        .harvest-form textarea:focus { outline:none; border-color:#58a6ff; }
        .harvest-bar { display:flex; align-items:center; gap:10px; margin-bottom:10px; font-size:.85rem; color:#8b949e; flex-wrap:wrap; }
        .harvest-mode { background:rgba(31,111,235,.13); color:#58a6ff; border:1px solid rgba(31,111,235,.35); border-radius:20px; padding:3px 10px; font-weight:600; }
        .harvest-note { background:rgba(210,153,34,.12); border:1px solid rgba(210,153,34,.35); color:#e3b341; border-radius:8px; padding:8px 12px; margin-bottom:8px; font-size:.85rem; }
        .harvest-empty { color:#8b949e; }
        .harvest-list { list-style:none; margin:0 0 16px; padding:0; display:flex; flex-direction:column; gap:8px; }
        .harvest-item { display:flex; align-items:center; gap:12px; background:#0d1117; border:1px solid #30363d; border-radius:10px; padding:10px 14px; cursor:pointer; transition:border-color .12s, background .12s; }
        .harvest-item:hover { border-color:rgba(88,166,255,.5); background:#161b22; }
        .harvest-item.is-saved { opacity:.5; cursor:default; }
        .harvest-check { display:flex; color:#6e7681; flex:0 0 auto; }
        .harvest-main { flex:1; min-width:0; }
        .harvest-name { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
        .harvest-tag { font-size:.68rem; text-transform:uppercase; letter-spacing:.03em; border:1px solid; border-radius:20px; padding:1px 8px; font-weight:600; }
        .harvest-tag.saved { color:#3fb950; border-color:rgba(63,185,80,.4); }
        .harvest-desc { color:#8b949e; font-size:.83rem; margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:660px; }
        .harvest-meta { display:flex; align-items:center; gap:12px; color:#8b949e; font-size:.82rem; white-space:nowrap; flex:0 0 auto; }
        .harvest-meta span { display:flex; align-items:center; gap:4px; }
        .harvest-meta a { color:#8b949e; display:flex; }
        .harvest-meta a:hover { color:#58a6ff; }
        .harvest-actions { display:flex; gap:10px; position:sticky; bottom:0; padding:12px 0 4px; background:linear-gradient(transparent, #0b0e14 45%); }
      `}</style>
      <div className="harvest-intro">
        <h2><Globe size={18} /> Oogst</h2>
        <p>
          Plak een <strong>GitHub-account</strong> (bv. <code>hexsecteam</code>), <strong>tool-namen</strong> (één per lijn of met komma's, bv. <code>NHLauncher</code>), of een <strong>pagina-URL</strong> (blog, Medium, linktree — hij <strong>haalt de pagina op</strong> en trekt alle github-links eruit). Alle repos komen hier <strong>tijdelijk</strong> te staan — vink aan wat je wilt en ze gaan naar de notebook. Er wordt niks bewaard tot jij kiest.
        </p>
      </div>
      <form className="harvest-form" onSubmit={run}>
        <textarea
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run(e); }}
          placeholder={"hexsecteam\nof: NHLauncher, seeker, xeno-rat\nof: https://medium.com/@hexsectools/...  (pagina wordt opgehaald)"}
          rows={3}
          value={source}
        />
        <button className="primary" disabled={loading || !source.trim()} type="submit">
          {loading ? <Loader2 className="spin" size={16} /> : <Globe size={16} />}
          {loading ? "Oogsten…" : "Ophalen"}
        </button>
      </form>
      {error && <div className="toast" style={{ position: "static", margin: "0 0 12px" }}>{error}</div>}
      {result && (
        <>
          <div className="harvest-bar">
            <span className="harvest-mode">{HARVEST_MODE_LABEL[result.mode] || result.mode}</span>
            <span>{candidates.length} gevonden · {picked.size} gekozen</span>
            <span style={{ flex: 1 }} />
            <button className="ghost" onClick={() => setPicked(new Set(freshIds))} type="button">Alles</button>
            <button className="ghost" onClick={() => setPicked(new Set())} type="button">Geen</button>
          </div>
          {(result.notes || []).map((note, i) => (<div className="harvest-note" key={i}>{note}</div>))}
          {!candidates.length && <p className="harvest-empty">Niks gevonden. Probeer een andere bron of een pagina-URL.</p>}
          <ul className="harvest-list">
            {candidates.map((c) => {
              const already = have.has(c.id);
              const on = picked.has(c.id);
              const tag = HARVEST_TAGS[c.tag] || {};
              return (
                <li className={`harvest-item${already ? " is-saved" : ""}`} key={c.id} onClick={() => !already && toggle(c.id)}>
                  <span className="harvest-check">
                    {already ? <CheckCircle2 color="#3fb950" size={18} /> : on ? <CheckCircle2 color="#58a6ff" size={18} /> : <Square size={18} />}
                  </span>
                  <div className="harvest-main">
                    <div className="harvest-name">
                      <strong>{c.fullName}</strong>
                      {c.tag && <span className="harvest-tag" style={{ color: tag.color, borderColor: tag.color }}>{tag.label || c.tag}</span>}
                      {already && <span className="harvest-tag saved">al opgeslagen</span>}
                    </div>
                    {c.description && <div className="harvest-desc">{c.description}</div>}
                  </div>
                  <span className="harvest-meta">
                    {c.language && <span>{c.language}</span>}
                    <span><Star size={13} /> {c.stars}</span>
                    <a href={c.url} onClick={(e) => e.stopPropagation()} rel="noreferrer" target="_blank" title="Op GitHub openen"><ExternalLink size={14} /></a>
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="harvest-actions">
            <button className="primary" disabled={!picked.size || saving} onClick={save} type="button">
              {saving ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
              Bewaar geselecteerde ({picked.size})
            </button>
            <button className="ghost" onClick={() => { setResult(null); setSource(""); setPicked(new Set()); }} type="button">
              <X size={16} /> Wis
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function TrendingTicker({ busy, error, onSave, repos }) {
  if (!repos.length && !error) return null;
  const loop = repos.length > 1 ? [...repos, ...repos] : repos;
  const saveFromTicker = (event, repo) => {
    event.currentTarget.blur();
    onSave(repo);
  };

  return (
    <section className="ticker" aria-label="GitHub Top 10 lichtkrant">
      <div className="ticker-label">
        <Radio size={16} />
        <span>Top 10 nu</span>
      </div>
      {repos.length ? (
        <div className="ticker-track">
          <div className="ticker-strip">
            {loop.map((repo, index) => {
              const saving = busy === `trend:${repo.id}`;
              return (
                <article className="ticker-item" key={`${repo.id}-${index}`}>
                  <button className="ticker-link" disabled={saving} onClick={(event) => saveFromTicker(event, repo)} title="Opslaan in notebook" type="button">
                    <strong>{(index % repos.length) + 1}. {repo.fullName}</strong>
                    <span>{repo.description || "Net populair op GitHub"}</span>
                  </button>
                  <span className="ticker-meta">
                    <Star size={13} /> {shortNumber(repo.stars)}
                    {repo.language && <><i style={{ background: languageColor(repo.language) }} /> {repo.language}</>}
                  </span>
                  <a
                    aria-label={`Open ${repo.fullName} op GitHub`}
                    className="ticker-open"
                    href={repo.htmlUrl}
                    rel="noreferrer"
                    target="_blank"
                    title="Open op GitHub"
                  >
                    <ExternalLink size={14} />
                  </a>
                  <button disabled={saving} onClick={(event) => saveFromTicker(event, repo)} title="Opslaan in notebook" type="button">
                    {saving ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
                    Opslaan
                  </button>
                </article>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="ticker-empty">Top 10 niet bereikbaar</div>
      )}
      {error && <div className="ticker-error">{error}</div>}
    </section>
  );
}

function LetterRail({ groups, letter, setLetter }) {
  return (
    <nav className="letters" aria-label="Alfabetische navigatie">
      <button className={!letter ? "active" : ""} onClick={() => setLetter("")}>A-Z</button>
      {letters.map((item) => (
        <button
          className={letter === item ? "active" : ""}
          disabled={!groups[item]?.length}
          key={item}
          onClick={() => setLetter(item)}
          title={`${groups[item]?.length || 0} repositories`}
        >
          {item}
        </button>
      ))}
    </nav>
  );
}

function NotebookList({ categories, catFilter, filtered, repos, selected, setCatFilter, setLetter, setSelectedId, setStatusFilter, statusFilter }) {
  const grouped = filtered.reduce((map, repo) => {
    const key = repoLetter(repo);
    return { ...map, [key]: [...(map[key] || []), repo] };
  }, {});
  const activeFilters = catFilter || statusFilter;

  return (
    <aside className="notebook">
      <div className="list-head">
        <span>{filtered.length === repos.length ? `${repos.length} repositories` : `${filtered.length} / ${repos.length}`}</span>
        {activeFilters && (
          <button onClick={() => { setCatFilter(""); setStatusFilter(""); setLetter(""); }}>
            Wis filters <X size={13} />
          </button>
        )}
      </div>
      <div className="filterbar">
        <select aria-label="Filter op categorie" value={catFilter} onChange={(event) => setCatFilter(event.target.value)}>
          <option value="">Alle categorieën</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
        <select aria-label="Filter op status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="">Alle statussen</option>
          {STATUS_ORDER.map((key) => (
            <option key={key} value={key}>{STATUS[key].label}</option>
          ))}
        </select>
      </div>
      <div className="repo-list">
        {!filtered.length && <EmptyList />}
        {letters.filter((key) => grouped[key]?.length).map((key) => (
          <div className="letter-group" key={key}>
            <h2>{key}</h2>
            {grouped[key].map((repo) => {
              const health = repoHealth(repo);
              return (
                <button
                  className={`repo-row ${selected?.id === repo.id ? "selected" : ""}`}
                  key={repo.id}
                  onClick={() => setSelectedId(repo.id)}
                >
                  <RepoAvatar repo={repo} />
                  <span className="repo-copy">
                    <strong>{repo.name}</strong>
                    <small>{repo.owner}{repo.description ? ` - ${repo.description}` : ""}</small>
                    {(repo.status || repo.category || health) && (
                      <span className="row-tags">
                        {health && <span className="health-dot" style={{ background: health.color }} title={health.label} />}
                        {repo.status && STATUS[repo.status] && (
                          <span className="status-badge" style={{ color: STATUS[repo.status].color, borderColor: STATUS[repo.status].color }}>
                            {STATUS[repo.status].label}
                          </span>
                        )}
                        {repo.category && <span className="cat-chip">{repo.category}</span>}
                      </span>
                    )}
                  </span>
                  <span className="stars"><Star size={15} /> {shortNumber(repo.stars)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}

function EmptyList() {
  return (
    <div className="empty">
      <Github size={34} />
      <h2>Geen repos</h2>
    </div>
  );
}

function RepoDetail({ busy, categories, config, dupPath, graph, onRepoUpdate, onSelectRepo, openLocal, refresh, remove, repo, setCloneFor }) {
  const [tab, setTab] = useState("readme");
  const [terminalOpen, setTerminalOpen] = useState(false);

  useEffect(() => setTerminalOpen(false), [repo?.id]);

  if (!repo) {
    return (
      <section className="detail empty-detail">
        <Github size={56} />
        <h1>Geen repository geselecteerd</h1>
      </section>
    );
  }

  const health = repoHealth(repo);

  return (
    <section className="detail">
      <div className="detail-head">
        <div className="title-line">
          <RepoAvatar repo={repo} />
          <h1>{repo.owner} <span>/</span> {repo.name}</h1>
          <span className="badge">{repo.visibility}</span>
          {repo.status && STATUS[repo.status] && (
            <span className="badge status" style={{ background: STATUS[repo.status].color }}>{STATUS[repo.status].label}</span>
          )}
          {repo.category && <span className="badge cat">{repo.category}</span>}
          {health && (
            <span className="badge health" style={{ color: health.color, borderColor: health.color }}>
              <Activity size={12} /> {health.label}
            </span>
          )}
        </div>
        <div className="actions">
          <button onClick={() => setCloneFor(repo)}>
            <HardDriveDownload size={17} /> Klonen
          </button>
          {repo.localPath && (
            <>
              <button disabled={busy === "open-local"} onClick={openLocal}>
                {busy === "open-local" ? <Loader2 className="spin" size={16} /> : <FolderOpen size={17} />}
                Open map
              </button>
              <button className={terminalOpen ? "active" : ""} onClick={() => setTerminalOpen((open) => !open)} title="Terminal in de clone-map">
                <Terminal size={17} /> Terminal
              </button>
            </>
          )}
          <a href={repo.htmlUrl} rel="noreferrer" target="_blank">
            Open op GitHub <ExternalLink size={16} />
          </a>
          <button disabled={busy === "refresh"} onClick={refresh}>
            {busy === "refresh" ? <Loader2 className="spin" size={16} /> : <RefreshCcw size={16} />}
            Ververs
          </button>
          <button className="danger" disabled={busy === "remove"} onClick={remove} title="Verwijderen uit notebook">
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      <div className="tabs">
        {["readme", "files", "about"].map((item) => (
          <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>
            {item === "readme" ? "README" : item === "files" ? "Bestanden" : "Over"}
          </button>
        ))}
      </div>
      <Stats repo={repo} />
      <div className="detail-grid">
        <div className="main-panel">
          <MetaPanel categories={categories} onRepoUpdate={onRepoUpdate} repo={repo} />
          <VerdictPanel config={config} repo={repo} />
          {(tab === "readme" || tab === "files") && <Files repo={repo} />}
          <RuntimePanel onRepoUpdate={onRepoUpdate} repo={repo} />
          {(tab === "readme" || tab === "about") && <Readme repo={repo} />}
        </div>
        <div className="side-col">
          <About dupPath={dupPath} repo={repo} />
          <RelatedPanel graph={graph} onSelect={onSelectRepo} repo={repo} />
        </div>
      </div>
      {terminalOpen && repo.localPath && <TerminalDock onClose={() => setTerminalOpen(false)} repo={repo} />}
    </section>
  );
}

// Embedded shell rooted in the clone folder: one persistent session per repo
// on the server, polled here. Lets you run the odd command without leaving
// the app (git status, npm scripts, a quick ls) — same trust as start/install.
const DOCK_STORAGE_KEY = "rn.terminalDock";
const DOCK_MARGIN = 8;
const DOCK_MIN_WIDTH = 360;

function readDockPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) || "{}");
    return { minimized: Boolean(prefs.minimized), pos: prefs.pos && Number.isFinite(prefs.pos.x) ? prefs.pos : null };
  } catch {
    return { minimized: false, pos: null };
  }
}

function writeDockPrefs(prefs) {
  try {
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage blocked — the dock still works, it just forgets its place.
  }
}

// Keeps at least the title bar on screen so a dragged dock can always be grabbed back.
function clampDockPos(pos, height = 48) {
  const width = Math.min(pos.w, window.innerWidth - DOCK_MARGIN * 2);
  return {
    w: Math.max(DOCK_MIN_WIDTH, width),
    x: Math.min(Math.max(DOCK_MARGIN, pos.x), Math.max(DOCK_MARGIN, window.innerWidth - width - DOCK_MARGIN)),
    y: Math.min(Math.max(DOCK_MARGIN, pos.y), Math.max(DOCK_MARGIN, window.innerHeight - height - DOCK_MARGIN))
  };
}

function TerminalDock({ onClose, repo }) {
  const [terminal, setTerminal] = useState(null);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [minimized, setMinimized] = useState(() => readDockPrefs().minimized);
  const [pos, setPos] = useState(() => readDockPrefs().pos);
  const dockRef = useRef(null);
  const outputRef = useRef(null);
  const inputRef = useRef(null);
  const dragRef = useRef(null);

  useEffect(() => writeDockPrefs({ minimized, pos }), [minimized, pos]);

  useEffect(() => {
    const onResize = () => setPos((current) => (current ? clampDockPos(current, dockRef.current?.offsetHeight) : current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(""), 1400);
    return () => clearTimeout(timer);
  }, [notice]);

  // Drag by the title bar; buttons inside it keep working as buttons.
  const onDragStart = (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    const rect = dockRef.current.getBoundingClientRect();
    dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, w: rect.width };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onDragMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPos(clampDockPos({ x: event.clientX - drag.dx, y: event.clientY - drag.dy, w: drag.w }, dockRef.current?.offsetHeight));
  };

  const onDragEnd = () => {
    dragRef.current = null;
  };

  const resetPosition = (event) => {
    if (event.target.closest("button")) return;
    setPos(null);
  };

  const insertAtCaret = (text) => {
    const field = inputRef.current;
    const start = field?.selectionStart ?? command.length;
    const end = field?.selectionEnd ?? command.length;
    const next = command.slice(0, start) + text + command.slice(end);
    setCommand(next);
    requestAnimationFrame(() => {
      if (!field) return;
      field.focus();
      field.selectionStart = field.selectionEnd = start + text.length;
    });
  };

  // Classic console behaviour: right-click with a selection copies it, without one it pastes.
  const onContextMenu = async (event) => {
    event.preventDefault();
    const selected = window.getSelection()?.toString() || "";
    try {
      if (selected && event.target.closest(".terminal-output")) {
        await navigator.clipboard.writeText(selected);
        window.getSelection().removeAllRanges();
        setNotice("Gekopieerd");
        return;
      }
      if (!terminal?.running) return;
      const text = (await navigator.clipboard.readText()).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
      if (!text) return;
      insertAtCaret(text);
      setNotice(text.includes("\n") ? "Geplakt — Enter om uit te voeren" : "Geplakt");
    } catch {
      setError("Klembord niet bereikbaar — gebruik Ctrl+V.");
    }
  };

  useEffect(() => {
    let active = true;
    setTerminal(null);
    setCommand("");
    setError("");
    loadTerminal(repo)
      .then((data) => (data.running ? data : startTerminal(repo)))
      .then((data) => active && setTerminal(data))
      .catch((err) => active && setError(err.message));
    const timer = setInterval(() => {
      loadTerminal(repo).then((data) => active && setTerminal(data)).catch(() => {});
    }, 900);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [repo.id]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [terminal?.output]);

  useEffect(() => {
    if (terminal?.running) inputRef.current?.focus();
  }, [terminal?.running]);

  const act = async (name, fn) => {
    setBusy(name);
    setError("");
    try {
      setTerminal(await fn());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    const input = command.trim();
    if (!input) return;
    setCommand("");
    setHistory((items) => [input, ...items.filter((item) => item !== input)].slice(0, 50));
    setHistoryIndex(-1);
    await act("input", () => sendTerminalInput(repo, input));
  };

  const onKeyDown = (event) => {
    const multiline = command.includes("\n");
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(event);
    } else if (event.key === "ArrowUp" && history.length && !multiline) {
      event.preventDefault();
      const next = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(next);
      setCommand(history[next]);
    } else if (event.key === "ArrowDown" && !multiline) {
      event.preventDefault();
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setCommand(next >= 0 ? history[next] : "");
    }
  };

  const restore = () => {
    setMinimized(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const dockStyle = pos ? { left: pos.x, top: pos.y, width: minimized ? undefined : pos.w, right: "auto", bottom: "auto" } : undefined;
  const inputRows = Math.min(6, command.split("\n").length);

  return (
    <aside
      aria-label={`Terminal voor ${repo.fullName}`}
      className={`terminal-dock${minimized ? " minimized" : ""}${pos ? " floating" : ""}`}
      ref={dockRef}
      style={dockStyle}
    >
      <div
        className="terminal-head"
        onDoubleClick={resetPosition}
        onPointerCancel={onDragEnd}
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        title="Sleep om te verplaatsen · dubbelklik = terug op vaste plek"
      >
        <span>
          <GripHorizontal className="terminal-grip" size={15} />
          <Terminal size={16} /> Terminal
          {terminal?.running && <i className="terminal-live" title="Terminal draait" />}
          <small>{repo.fullName}{!minimized && terminal?.shell ? ` · ${terminal.shell}` : ""}</small>
        </span>
        <div>
          {!minimized && (
            <>
              {terminal?.running ? (
                <button disabled={busy === "stop"} onClick={() => act("stop", () => stopTerminal(repo))}><Square size={14} /> Stop</button>
              ) : (
                <button disabled={busy === "start"} onClick={() => act("start", () => startTerminal(repo))}><Play size={14} /> Open terminal</button>
              )}
              <button disabled={!terminal?.output || busy === "clear"} onClick={() => act("clear", () => clearTerminal(repo))}>Wis</button>
            </>
          )}
          {minimized ? (
            <button aria-label="Terminal openklappen" className="icon" onClick={restore} title="Openklappen"><Maximize2 size={14} /></button>
          ) : (
            <button aria-label="Terminal minimaliseren" className="icon" onClick={() => setMinimized(true)} title="Minimaliseren"><Minus size={15} /></button>
          )}
          <button aria-label="Terminal sluiten" className="icon" onClick={onClose} title="Sluiten"><X size={15} /></button>
        </div>
      </div>
      {!minimized && (
        <>
          <pre className="terminal-output" onContextMenu={onContextMenu} ref={outputRef}>{terminal?.output || (terminal ? "Terminal gestopt." : "Terminal starten…")}</pre>
          <form className="terminal-input" onContextMenu={onContextMenu} onSubmit={submit}>
            <span>$</span>
            <textarea
              autoComplete="off"
              disabled={!terminal?.running || busy === "input"}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={terminal?.running ? "Typ of plak (rechtermuis) een commando · Enter = uitvoeren · Shift+Enter = nieuwe regel" : "Terminal is gestopt"}
              ref={inputRef}
              rows={inputRows}
              spellCheck="false"
              value={command}
            />
            <button disabled={!terminal?.running || !command.trim() || busy === "input"}>Uitvoeren</button>
          </form>
          {error && <div className="runtime-error">{error}</div>}
          <small className="terminal-warning">
            {notice ? <b className="terminal-notice">{notice}</b> : "Rechtermuis = plakken (of kopiëren als je tekst selecteerde). "}
            Commando’s draaien lokaal in de clone-map, met jouw rechten. Voer alleen uit wat je vertrouwt.
          </small>
        </>
      )}
    </aside>
  );
}

// Shows where the MCP server lives and how to hook an agent to it.
function McpDialog({ onClose }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    loadMcpStatus().then(setStatus).catch((err) => setError(err.message));
  }, []);

  const copy = async (label, value) => {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(""), 1800);
    } catch {
      setError("Kopiëren naar het klembord lukte niet — selecteer de tekst handmatig.");
    }
  };
  const endpoint = status?.endpoint || "";
  const claudeCommand = endpoint ? `claude mcp add --transport http repo-notebook ${endpoint}` : "";
  const codexCommand = endpoint ? `codex mcp add repo-notebook --url ${endpoint}` : "";
  const stdioCommand = status?.stdio ? `claude mcp add repo-notebook -- ${status.stdio}` : "";

  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-label="MCP-server" className="clone-modal mcp-modal" role="dialog">
        <div className="modal-head">
          <div>
            <h2>Repo Notebook als MCP-server</h2>
            <p>Dezelfde notebook-tools (zoeken, opslaan, klonen, status zetten) voor Claude Code, Codex of elke andere MCP-client — via HTTP zolang de app draait, of via stdio.</p>
          </div>
          <button aria-label="Sluit MCP-venster" className="icon" onClick={onClose}><X size={18} /></button>
        </div>
        {error && <div className="clone-error">{error}</div>}
        {!status && !error && <div className="mcp-loading"><Loader2 className="spin" size={18} /> MCP-status laden…</div>}
        {status && (
          <>
            <div className="mcp-status"><CheckCircle2 size={18} /> Actief · alleen localhost · versie {status.version}</div>
            <label className="mcp-field">
              <span>HTTP-endpoint (Streamable HTTP)</span>
              <div><code>{endpoint}</code><button onClick={() => copy("endpoint", endpoint)} type="button">{copied === "endpoint" ? "Gekopieerd" : "Kopieer"}</button></div>
            </label>
            <label className="mcp-field">
              <span>Claude Code</span>
              <div><code>{claudeCommand}</code><button onClick={() => copy("claude", claudeCommand)} type="button">{copied === "claude" ? "Gekopieerd" : "Kopieer"}</button></div>
            </label>
            <label className="mcp-field">
              <span>Codex CLI</span>
              <div><code>{codexCommand}</code><button onClick={() => copy("codex", codexCommand)} type="button">{copied === "codex" ? "Gekopieerd" : "Kopieer"}</button></div>
            </label>
            {stdioCommand && (
              <label className="mcp-field">
                <span>Zonder draaiende app (stdio)</span>
                <div><code>{stdioCommand}</code><button onClick={() => copy("stdio", stdioCommand)} type="button">{copied === "stdio" ? "Gekopieerd" : "Kopieer"}</button></div>
              </label>
            )}
            <div className="mcp-note">
              De desktop-app gebruikt poort 5188 als die vrij is, anders een andere — de endpoint hierboven is die van nu (ook te vinden in <code>server.json</code> in de datamap). Alleen lokale clients kunnen erbij; de app zet niets open naar het internet.
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Stats({ repo }) {
  return (
    <div className="stats">
      <span><Star size={17} /> {shortNumber(repo.stars)} stars</span>
      <span><GitFork size={17} /> {shortNumber(repo.forks)} forks</span>
      <span><Eye size={17} /> {shortNumber(repo.watchers)} watching</span>
      <span><GitBranch size={17} /> {repo.defaultBranch}</span>
      <span className="updated">Bijgewerkt {shortDate(repo.updatedAt)}</span>
    </div>
  );
}

function Files({ repo }) {
  return (
    <section className="panel files">
      <div className="panel-head">
        <h2>Bestanden</h2>
        <span><GitBranch size={15} /> {repo.defaultBranch}</span>
      </div>
      <div className="file-table">
        {repo.files?.length ? repo.files.map((file) => (
          <a href={file.htmlUrl} key={file.path} rel="noreferrer" target="_blank">
            <span>{file.type === "dir" ? <Folder size={18} /> : <File size={18} />} {file.name}</span>
            <small>{file.type === "dir" ? "map" : fileSize(file.size)}</small>
          </a>
        )) : <p className="muted">Geen rootbestanden gevonden.</p>}
      </div>
    </section>
  );
}

function Readme({ repo }) {
  const readme = repo.files?.find((file) => /^readme(\.|$)/i.test(file.name));

  return (
    <section className="panel readme">
      <div className="panel-head">
        <h2>README.md</h2>
        <a href={readme?.htmlUrl || `${repo.htmlUrl}#readme`} rel="noreferrer" target="_blank">
          Open op GitHub <ExternalLink size={16} />
        </a>
      </div>
      {repo.readme ? (
        <div className="readme-md" dangerouslySetInnerHTML={{ __html: renderReadme(repo.readme) }} />
      ) : (
        <div className="readme-empty">README niet lokaal opgeslagen</div>
      )}
    </section>
  );
}

function About({ dupPath, repo }) {
  return (
    <aside className="panel about">
      <h2>Over</h2>
      {repo.description && <p>{repo.description}</p>}
      <dl>
        {repo.homepage && <><dt>Homepage</dt><dd><a href={repo.homepage} rel="noreferrer" target="_blank">{repo.homepage}</a></dd></>}
        <dt>Taal</dt>
        <dd>{repo.language ? <><i style={{ background: languageColor(repo.language) }} /> {repo.language}</> : "Onbekend"}</dd>
        <dt>Licentie</dt>
        <dd>{repo.license || "Onbekend"}</dd>
        {repo.localPath && <><dt>Lokaal</dt><dd><code className="local-path">{repo.localPath}</code></dd></>}
        {dupPath && <><dt>Ook gekloond in</dt><dd><code className="local-path dup-path" title="Deze repo staat al ergens anders op je schijf">{dupPath}</code></dd></>}
        <dt>Opgeslagen</dt>
        <dd>{shortDate(repo.savedAt)}</dd>
      </dl>
      {!!repo.topics?.length && (
        <div className="topics">
          {repo.topics.slice(0, 12).map((topic) => <span key={topic}>{topic}</span>)}
        </div>
      )}
    </aside>
  );
}

function RuntimePanel({ onRepoUpdate, repo }) {
  const [runtime, setRuntime] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [size, setSize] = useState(null);
  const [behind, setBehind] = useState(null);

  const refresh = async () => {
    if (!repo?.localPath) return setRuntime(null);
    setRuntime(await loadRuntime(repo));
  };

  useEffect(() => {
    setSize(null);
    setBehind(null);
    let active = true;
    const load = async () => {
      if (!repo?.localPath) return setRuntime(null);
      try {
        const data = await loadRuntime(repo);
        if (active) setRuntime(data);
      } catch {
        if (active) setRuntime(null);
      }
    };
    load();
    const timer = setInterval(load, 3500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [repo?.id, repo?.localPath]);

  if (!repo?.localPath) return null;

  const run = async (action) => {
    setBusy(action);
    setError("");
    try {
      const starter = repo.containerMode ? startContainer : startRepo;
      const data = await ({ install: installRepo, start: starter, stop: stopRepo, pull: pullRepo }[action])(repo);
      if (data.repo) onRepoUpdate(data.repo);
      setRuntime(data.runtime || (await loadRuntime(data.repo || repo)));
      if (action === "pull") setBehind(0);
      if (action === "start" && data.portWarning) setError(data.portWarning);
    } catch (err) {
      setError(err.message);
      await refresh();
    } finally {
      setBusy("");
    }
  };

  const removeClone = async () => {
    if (!confirm(`Gekloonde bestanden van ${repo.fullName} verwijderen? (de opgeslagen repo blijft)`)) return;
    setBusy("delete-clone");
    setError("");
    try {
      const data = await deleteClone(repo);
      if (data.repo) onRepoUpdate(data.repo);
      setRuntime(null);
      setSize(null);
      setBehind(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const loadSize = async () => {
    setBusy("size");
    setError("");
    try {
      setSize((await repoSize(repo)).bytes || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const loadBehind = async () => {
    setBusy("updates");
    setError("");
    try {
      setBehind((await checkUpdates(repo)).behind ?? 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const runDiagnose = async () => {
    setBusy("diagnose");
    setError("");
    try {
      const data = await diagnoseRepo(repo);
      if (data.repo) onRepoUpdate(data.repo);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const install = runtime?.commands?.install;
  const start = runtime?.commands?.start;

  return (
    <section className="panel runtime">
      <div className="panel-head">
        <h2>Lokaal</h2>
        <span>{runtime?.commands?.type || "Detectie"}</span>
      </div>
      <div className="runtime-body">
        <div className="runtime-actions">
          <button disabled={!install || busy === "install"} onClick={() => run("install")}>
            {busy === "install" ? <Loader2 className="spin" size={16} /> : <PackageCheck size={16} />}
            Install
          </button>
          {runtime?.running ? (
            <button disabled={busy === "stop"} onClick={() => run("stop")}>
              {busy === "stop" ? <Loader2 className="spin" size={16} /> : <Square size={16} />}
              Stop
            </button>
          ) : (
            <button disabled={!start || busy === "start"} onClick={() => run("start")}>
              {busy === "start" ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
              Start
            </button>
          )}
          {runtime?.running && runtime?.url && (
            <a className="runtime-open" href={runtime.url} rel="noreferrer" target="_blank">
              <Globe size={16} /> Open
            </a>
          )}
          <button disabled={busy === "pull"} onClick={() => run("pull")}>
            {busy === "pull" ? <Loader2 className="spin" size={16} /> : <GitBranch size={16} />} Pull
          </button>
          <button onClick={() => loadLog(repo).then(({ log }) => setRuntime((item) => ({ ...item, log })))}>
            <RefreshCcw size={16} /> Log
          </button>
        </div>
        <div className="runtime-actions secondary">
          <button disabled={busy === "updates"} onClick={loadBehind}>
            {busy === "updates" ? <Loader2 className="spin" size={15} /> : <Activity size={15} />}
            {behind === null ? "Updates?" : behind === 0 ? "Up-to-date" : `${behind} achter`}
          </button>
          <button disabled={busy === "size"} onClick={loadSize}>
            {busy === "size" ? <Loader2 className="spin" size={15} /> : <HardDriveDownload size={15} />}
            {size === null ? "Schijfruimte" : formatBytes(size)}
          </button>
          <button className="danger" disabled={busy === "delete-clone"} onClick={removeClone} title="Verwijder gekloonde bestanden">
            {busy === "delete-clone" ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />} Clone weg
          </button>
          <button disabled={busy === "diagnose"} onClick={runDiagnose} title="Laat AI (lokale Ollama) de foutlog analyseren">
            {busy === "diagnose" ? <Loader2 className="spin" size={15} /> : <Stethoscope size={15} />} AI-diagnose
          </button>
        </div>
        <div className="runtime-meta">
          {install && <code>{install.label}</code>}
          {start && <code>{start.label}</code>}
          {runtime?.running && <strong>PID {runtime.pid}</strong>}
          {runtime?.running && runtime?.mode === "container" && <strong className="mode-chip"><Container size={12} /> container</strong>}
          {repo.installedAt && <span>Installed {shortDate(repo.installedAt)}</span>}
        </div>
        {error && <div className="runtime-error">{error}</div>}
        {repo.lastError && !runtime?.running && (
          <div className="runtime-error">
            Laatste fout ({repo.lastError.op}, {shortDate(repo.lastError.at)}): {repo.lastError.message}
          </div>
        )}
        {repo.lastDiagnosis && (
          <div className="diagnose-block">
            <div className="diagnose-head">
              <Stethoscope size={14} /> AI-diagnose
              <span>
                {repo.lastDiagnosis.provider}
                {repo.lastDiagnosis.model ? ` · ${repo.lastDiagnosis.model}` : ""} · {shortDate(repo.lastDiagnosis.at)}
              </span>
            </div>
            <pre className="diagnose-advice">{repo.lastDiagnosis.advice}</pre>
          </div>
        )}
        <ContainerControls onRepoUpdate={onRepoUpdate} repo={repo} />
        <EnvEditor repo={repo} />
        {runtime?.log && <pre className="runtime-log">{runtime.log}</pre>}
      </div>
    </section>
  );
}

// Containermodus per repo: install + start gebeuren dan in Docker in plaats
// van op de host. Opt-in en onthouden per repo; Docker Desktop wordt
// on-demand gestart en kan hier ook weer uit (RAM terug).
function ContainerControls({ onRepoUpdate, repo }) {
  const [docker, setDocker] = useState(null);
  const [port, setPort] = useState(repo.containerPort || "");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setPort(repo.containerPort || "");
    setError("");
  }, [repo.id]);

  useEffect(() => {
    if (repo.containerMode) dockerStatus().then(setDocker).catch(() => {});
  }, [repo.id, repo.containerMode]);

  const commit = async (patch) => {
    setError("");
    try {
      const { repo: updated } = await setRepoMeta(repo, patch);
      if (updated) onRepoUpdate(updated);
    } catch (err) {
      setError(err.message);
    }
  };

  const dockerAction = async (action) => {
    setBusy(action);
    setError("");
    try {
      if (action === "start") setDocker(await dockerStart());
      else {
        await dockerStop();
        setDocker(await dockerStatus());
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="container-block">
      <label className="container-toggle">
        <input
          checked={Boolean(repo.containerMode)}
          onChange={(event) => commit({ containerMode: event.target.checked })}
          type="checkbox"
        />
        <Container size={15} /> In container draaien — install &amp; start in Docker, je PC blijft proper
      </label>
      {repo.containerMode && (
        <div className="container-opts">
          <label className="container-port">
            Poort
            <input
              inputMode="numeric"
              onBlur={() => (repo.containerPort || "") !== port.trim() && commit({ containerPort: port.trim() })}
              onChange={(event) => setPort(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
              placeholder={repo.lastPort || "bv. 3000"}
              value={port}
            />
          </label>
          <label className="container-gpu">
            <input
              checked={Boolean(repo.containerGpu)}
              onChange={(event) => commit({ containerGpu: event.target.checked })}
              type="checkbox"
            />
            GPU (RTX)
          </label>
          {docker && (
            <span className={`docker-chip ${docker.running ? "on" : ""}`}>
              Docker {docker.running ? "draait" : docker.installed ? "uit" : "ontbreekt"}
            </span>
          )}
          {docker && docker.installed && !docker.running && (
            <button disabled={busy === "start"} onClick={() => dockerAction("start")} type="button">
              {busy === "start" ? <Loader2 className="spin" size={13} /> : <Play size={13} />} Start Docker (±30-60s)
            </button>
          )}
          {docker?.running && (
            <button disabled={busy === "stop"} onClick={() => dockerAction("stop")} title="Sluit Docker Desktop af en geef RAM terug (kan enkel als er geen containers draaien)" type="button">
              {busy === "stop" ? <Loader2 className="spin" size={13} /> : <Square size={13} />} Stop Docker
            </button>
          )}
        </div>
      )}
      {error && <div className="env-error">{error}</div>}
    </div>
  );
}

// .env van de clone bekijken/aanpassen zonder verkenner + kladblok: veel
// AI-repos falen enkel op ontbrekende keys, dit haalt die drempel weg.
function EnvEditor({ repo }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [example, setExample] = useState(null);
  const [exists, setExists] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedTick, setSavedTick] = useState(false);

  useEffect(() => {
    setOpen(false);
    setContent("");
    setExample(null);
    setExists(false);
    setError("");
  }, [repo.id]);

  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const data = await loadEnv(repo);
      setContent(data.content || "");
      setExample(data.example || null);
      setExists(Boolean(data.exists));
      setOpen(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await saveEnv(repo, content);
      setExists(true);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 2500);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="env-row">
        <button className="env-toggle" disabled={busy} onClick={load} type="button">
          {busy ? <Loader2 className="spin" size={14} /> : <File size={14} />} .env bewerken
        </button>
        {error && <span className="env-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className="env-editor">
      <div className="env-head">
        <strong><File size={14} /> .env {exists ? "" : "(nog niet aanwezig)"}</strong>
        <div className="env-actions">
          {example && !content.trim() && (
            <button onClick={() => setContent(example.content)} type="button">Vul met {example.name}</button>
          )}
          <button className="primary" disabled={busy} onClick={save} type="button">
            {busy ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />} {savedTick ? "Bewaard" : "Bewaar"}
          </button>
          <button onClick={() => setOpen(false)} type="button"><X size={14} /></button>
        </div>
      </div>
      <textarea
        className="env-textarea"
        onChange={(event) => setContent(event.target.value)}
        placeholder={example ? `Leeg — klik "Vul met ${example.name}" voor de template.` : "KEY=waarde"}
        rows={Math.min(16, Math.max(6, content.split("\n").length + 1))}
        spellCheck={false}
        value={content}
      />
      {error && <div className="env-error">{error}</div>}
    </div>
  );
}

function CloneDialog({ onRepoUpdate, repo, setCloneFor }) {
  const [method, setMethod] = useState("https");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const cloneUrl = method === "ssh" ? repo.sshUrl : repo.cloneUrl;

  const run = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const data = await cloneRepo(repo, method);
      setResult(data);
      if (data.repo) onRepoUpdate(data.repo);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const copy = () => navigator.clipboard?.writeText(`git clone ${cloneUrl}`);

  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-label="Repository klonen" className="clone-modal" role="dialog">
        <div className="modal-head">
          <div>
            <h2>{repo.fullName} klonen</h2>
          </div>
          <button aria-label="Sluit clone-venster" className="icon" onClick={() => setCloneFor(null)}><X size={18} /></button>
        </div>
        <div className="segment">
          {["https", "ssh"].map((item) => (
            <button className={method === item ? "active" : ""} key={item} onClick={() => setMethod(item)}>
              {item.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="clone-url">
          <code>{cloneUrl}</code>
          <button aria-label="Clone-commando kopieren" onClick={copy} title="Clone-commando kopieren"><Copy size={16} /></button>
        </div>
        <button className="primary clone-run" disabled={busy} onClick={run}>
          {busy ? <Loader2 className="spin" size={17} /> : <HardDriveDownload size={17} />}
          Clone repository
        </button>
        {result && (
          <div className="clone-result">
            <CheckCircle2 size={18} />
            <span>{result.status === "exists" ? "Bestaat al:" : "Gekloond naar:"}</span>
            <code>{result.path}</code>
          </div>
        )}
        {error && <div className="clone-error">{error}</div>}
      </section>
    </div>
  );
}

function MetaPanel({ categories, onRepoUpdate, repo }) {
  const [category, setCategory] = useState(repo.category || "");
  const [note, setNote] = useState(repo.note || "");
  const [status, setStatus] = useState(repo.status || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setCategory(repo.category || "");
    setNote(repo.note || "");
    setStatus(repo.status || "");
    setError("");
  }, [repo.id]);

  const commit = async (patch) => {
    setSaving(true);
    setError("");
    try {
      const { repo: updated } = await setRepoMeta(repo, patch);
      if (updated) onRepoUpdate(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const pickStatus = (value) => {
    const next = status === value ? "" : value;
    setStatus(next);
    if ((repo.status || "") !== next) commit({ status: next });
  };
  const commitCategory = () => {
    if ((repo.category || "") !== category.trim()) commit({ category: category.trim() });
  };
  const commitNote = () => {
    if ((repo.note || "") !== note) commit({ note });
  };

  return (
    <section className="panel meta">
      <div className="panel-head">
        <h2>Notitie &amp; status</h2>
        {saving && <Loader2 className="spin" size={14} />}
      </div>
      <div className="meta-body">
        <div className="meta-row">
          <label>Status</label>
          <div className="status-picker">
            {STATUS_ORDER.map((key) => (
              <button
                className={status === key ? "active" : ""}
                key={key}
                onClick={() => pickStatus(key)}
                style={status === key ? { background: STATUS[key].color, borderColor: STATUS[key].color, color: "#0b0e14" } : undefined}
                type="button"
              >
                {STATUS[key].label}
              </button>
            ))}
          </div>
        </div>
        <div className="meta-row">
          <label htmlFor="meta-category">Categorie</label>
          <input
            autoComplete="off"
            id="meta-category"
            list="meta-categories"
            onBlur={commitCategory}
            onChange={(event) => setCategory(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
            placeholder="bv. AI, Hacking, van Insta"
            value={category}
          />
          <datalist id="meta-categories">
            {categories.map((cat) => (
              <option key={cat} value={cat} />
            ))}
          </datalist>
        </div>
        <div className="meta-row">
          <label htmlFor="meta-note">Notitie</label>
          <textarea
            id="meta-note"
            onBlur={commitNote}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Waarom sloeg je dit op? Wat wil je ermee?"
            value={note}
          />
        </div>
        {error && <div className="meta-error">{error}</div>}
      </div>
    </section>
  );
}

function AddModal({ hasToken, onClose, onRepos, repos, setNotice }) {
  const [tab, setTab] = useState("bulk");
  const [text, setText] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  const run = async (fn) => {
    setBusy(true);
    setError("");
    setResult("");
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const doBulk = () =>
    run(async () => {
      const data = await bulkSave(text);
      if (data.repos) onRepos(data.repos);
      const parts = [];
      if (data.added?.length) parts.push(`${data.added.length} toegevoegd`);
      if (data.existed?.length) parts.push(`${data.existed.length} bestond al`);
      if (data.failed?.length) parts.push(`${data.failed.length} mislukt`);
      setResult(parts.join(" · ") || "Geen GitHub-links gevonden.");
      if (data.added?.length) setNotice(`Bulk: ${data.added.length} repo's toegevoegd`);
    });

  const doStars = () =>
    run(async () => {
      const data = await importStars(username.trim());
      if (data.repos) onRepos(data.repos);
      setResult(`${data.added} nieuw · ${data.existed} bestond al (van ${data.total} stars)`);
      if (data.added) setNotice(`Stars: ${data.added} repo's geïmporteerd`);
    });

  const doExport = () => {
    const blob = new Blob([JSON.stringify({ repos }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "repo-notebook-export.json";
    link.click();
    URL.revokeObjectURL(url);
    setResult("Geëxporteerd naar repo-notebook-export.json");
  };

  const doImport = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () =>
      run(async () => {
        let parsed;
        try {
          parsed = JSON.parse(String(reader.result));
        } catch {
          throw new Error("Geen geldig JSON-bestand.");
        }
        const list = Array.isArray(parsed) ? parsed : parsed.repos;
        const data = await importNotebook(Array.isArray(list) ? list : []);
        if (data.repos) onRepos(data.repos);
        setResult(`${data.added} repo's geïmporteerd`);
        if (data.added) setNotice(`Import: ${data.added} repo's toegevoegd`);
      });
    reader.readAsText(file);
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-label="Repos toevoegen" className="add-modal" role="dialog">
        <div className="modal-head">
          <h2>Repos toevoegen</h2>
          <button aria-label="Sluiten" className="icon" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="segment">
          {[["bulk", "Bulk plakken"], ["stars", "GitHub Stars"], ["io", "Import / Export"]].map(([key, label]) => (
            <button className={tab === key ? "active" : ""} key={key} onClick={() => { setTab(key); setResult(""); setError(""); }} type="button">
              {label}
            </button>
          ))}
        </div>

        {tab === "bulk" && (
          <div className="add-body">
            <p className="add-hint">Plak een tekst (bv. een Insta-caption) — elke <code>github.com/owner/repo</code> erin wordt opgeslagen.</p>
            <textarea onChange={(event) => setText(event.target.value)} placeholder="Plak hier links of hele tekst..." rows={6} value={text} />
            <button className="primary" disabled={busy || !text.trim()} onClick={doBulk} type="button">
              {busy ? <Loader2 className="spin" size={16} /> : <ClipboardList size={16} />} Alles opslaan
            </button>
          </div>
        )}

        {tab === "stars" && (
          <div className="add-body">
            <p className="add-hint">Importeer de publieke Stars van een GitHub-gebruiker (enkel nieuwe; bestaande blijven ongemoeid).{!hasToken && " Zonder GITHUB_TOKEN geldt een lagere rate-limit."}</p>
            <input onChange={(event) => setUsername(event.target.value)} onKeyDown={(event) => event.key === "Enter" && username.trim() && doStars()} placeholder="GitHub-gebruikersnaam" value={username} />
            <button className="primary" disabled={busy || !username.trim()} onClick={doStars} type="button">
              {busy ? <Loader2 className="spin" size={16} /> : <Star size={16} />} Stars importeren
            </button>
          </div>
        )}

        {tab === "io" && (
          <div className="add-body io">
            <button className="ghost" onClick={doExport} type="button"><Download size={16} /> Exporteer je lijst (.json)</button>
            <label className="ghost file-btn">
              <Upload size={16} /> Importeer een lijst (.json)
              <input accept="application/json" hidden onChange={doImport} type="file" />
            </label>
          </div>
        )}

        {error && <div className="clone-error">{error}</div>}
        {result && <div className="add-result"><CheckCircle2 size={16} /> {result}</div>}
      </section>
    </div>
  );
}

function VerdictPanel({ config, repo }) {
  const [verdict, setVerdict] = useState(repo.aiVerdict || "");
  const [provider, setProvider] = useState(repo.aiProvider || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setVerdict(repo.aiVerdict || "");
    setProvider(repo.aiProvider || "");
    setError("");
  }, [repo.id]);

  const run = async (refresh) => {
    setBusy(true);
    setError("");
    try {
      const data = await repoVerdict(repo, refresh);
      if (data.available === false) {
        setError("Geen AI beschikbaar. Start Ollama (lokaal, gratis) of zet OPENAI_API_KEY / ANTHROPIC_API_KEY.");
      } else {
        setVerdict(data.verdict || "");
        setProvider(data.provider || "");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const providerLabel = provider || config?.aiProvider || "";

  return (
    <section className="panel verdict">
      <div className="panel-head">
        <h2>
          <Sparkles size={16} /> Is dit de moeite?
          {providerLabel && <span className="verdict-provider">via {providerLabel}</span>}
        </h2>
        <button disabled={busy} onClick={() => run(Boolean(verdict))} type="button">
          {busy ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />}
          {verdict ? "Opnieuw" : "AI-oordeel"}
        </button>
      </div>
      <div className="verdict-body">
        {error && <div className="verdict-error">{error}</div>}
        {verdict ? (
          <p className="verdict-text">{verdict}</p>
        ) : (
          !error && (
            <p className="muted">
              Kort AI-oordeel of dit de moeite is om te proberen{config?.ai ? "" : " — vereist een lokaal Ollama-model of een API-key"}.
            </p>
          )
        )}
      </div>
    </section>
  );
}

function RepoAvatar({ repo }) {
  return <span className="avatar">{repo.owner?.[0]?.toUpperCase() || <Github size={16} />}</span>;
}

createRoot(document.getElementById("root")).render(<App />);
