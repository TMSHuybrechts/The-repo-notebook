import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
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
  HardDriveDownload,
  Loader2,
  PackageCheck,
  Play,
  Plus,
  Radio,
  RefreshCcw,
  Search,
  Sparkles,
  Square,
  Star,
  Terminal,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { bulkSave, checkUpdates, clearTerminal, cloneRepo, deleteClone, importNotebook, importStars, installRepo, loadConfig, loadLog, loadMcpStatus, loadNotebook, loadRuntime, loadTerminal, loadTrending, openLocalRepo, pullRepo, refreshRepo, removeRepo, repoSize, repoVerdict, saveRepo, sendTerminalInput, setRepoMeta, startRepo, startTerminal, stopRepo, stopTerminal } from "./api";
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

  useEffect(() => {
    loadNotebook()
      .then(({ repos }) => {
        setRepos(repos);
        setSelectedId(repos[0]?.id || "");
      })
      .catch((err) => setError(err.message));
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

  return (
    <main className="app">
      <TopBar busy={busy} error={error} notice={notice} openAdd={() => setAddOpen(true)} openMcp={() => setMcpOpen(true)} query={query} setQuery={setQuery} save={save} setUrl={setUrl} url={url} />
      <TrendingTicker busy={busy} error={trendingError} onSave={saveTrending} repos={trending} />
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
          refresh={refresh}
          remove={remove}
          openLocal={openLocal}
          onRepoUpdate={updateRepo}
          repo={selected}
          setCloneFor={setCloneFor}
        />
      </section>
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

function TopBar({ busy, error, notice, openAdd, openMcp, query, save, setQuery, setUrl, url }) {
  return (
    <header className="topbar">
      <div className="brand">
        <BookOpen size={24} />
        <span>Repo Notebook</span>
        <button className="mcp-chip" onClick={openMcp} title="MCP-server en verbindingsinformatie" type="button">
          <span /> MCP
        </button>
      </div>
      <form className="save-form" onSubmit={save}>
        <input
          aria-label="GitHub repository URL"
          onChange={(event) => setUrl(event.target.value)}
          placeholder="GitHub repo-URL plakken"
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

function RepoDetail({ busy, categories, config, onRepoUpdate, openLocal, refresh, remove, repo, setCloneFor }) {
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
              <button onClick={() => setTerminalOpen(true)}><Terminal size={17} /> Terminal</button>
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
        <About repo={repo} />
      </div>
      {terminalOpen && repo.localPath && <TerminalDock onClose={() => setTerminalOpen(false)} repo={repo} />}
    </section>
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

function About({ repo }) {
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

function McpDialog({ onClose }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    loadMcpStatus().then(setStatus).catch((err) => setError(err.message));
  }, []);

  const copy = async (label, value) => {
    await navigator.clipboard?.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(""), 1800);
  };
  const endpoint = status?.endpoint || "";
  const codexCommand = endpoint ? `codex mcp add repo-notebook --url ${endpoint}` : "";

  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-label="MCP-server" className="clone-modal mcp-modal" role="dialog">
        <div className="modal-head">
          <div>
            <h2>Repo Notebook MCP</h2>
            <p>De desktopapp biedt dezelfde notebook-tools aan via Streamable HTTP en STDIO.</p>
          </div>
          <button aria-label="Sluit MCP-venster" className="icon" onClick={onClose}><X size={18} /></button>
        </div>
        {error && <div className="clone-error">{error}</div>}
        {!status && !error && <div className="mcp-loading"><Loader2 className="spin" size={18} /> MCP-status laden…</div>}
        {status && (
          <>
            <div className="mcp-status"><CheckCircle2 size={18} /> Actief · lokaal beveiligd · versie {status.version}</div>
            <label className="mcp-field">
              <span>Lokale HTTP-endpoint</span>
              <div><code>{endpoint}</code><button onClick={() => copy("endpoint", endpoint)}>{copied === "endpoint" ? "Gekopieerd" : "Kopieer"}</button></div>
            </label>
            <label className="mcp-field">
              <span>Toevoegen aan lokale Codex</span>
              <div><code>{codexCommand}</code><button onClick={() => copy("codex", codexCommand)}>{copied === "codex" ? "Gekopieerd" : "Kopieer"}</button></div>
            </label>
            <div className="mcp-note">
              ChatGPT Work kan deze localhost-endpoint gebruiken via een Secure MCP Tunnel. De app stelt hem nooit rechtstreeks aan het internet bloot.
            </div>
          </>
        )}
      </section>
    </div>
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
      const data = await ({ install: installRepo, start: startRepo, stop: stopRepo, pull: pullRepo }[action])(repo);
      if (data.repo) onRepoUpdate(data.repo);
      setRuntime(data.runtime || (await loadRuntime(data.repo || repo)));
      if (action === "pull") setBehind(0);
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
        </div>
        <div className="runtime-meta">
          {install && <code>{install.label}</code>}
          {start && <code>{start.label}</code>}
          {runtime?.running && <strong>PID {runtime.pid}</strong>}
          {repo.installedAt && <span>Installed {shortDate(repo.installedAt)}</span>}
        </div>
        {error && <div className="runtime-error">{error}</div>}
        {runtime?.log && <pre className="runtime-log">{runtime.log}</pre>}
      </div>
    </section>
  );
}

function TerminalDock({ onClose, repo }) {
  const [terminal, setTerminal] = useState(null);
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const outputRef = useRef(null);

  useEffect(() => {
    let active = true;
    setTerminal(null);
    setCommand("");
    setError("");
    const refresh = () => loadTerminal(repo).then((data) => active && setTerminal(data)).catch(() => {});
    loadTerminal(repo)
      .then((data) => data.running ? data : startTerminal(repo))
      .then((data) => active && setTerminal(data))
      .catch((err) => active && setError(err.message));
    const timer = setInterval(refresh, 900);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [repo.id]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [terminal?.output]);

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
    await act("input", () => sendTerminalInput(repo, input));
  };

  return (
    <aside className="terminal-dock" aria-label={`Terminal voor ${repo.fullName}`}>
      <div className="terminal-head">
        <span><Terminal size={16} /> Terminal <small>{repo.fullName}</small></span>
        <div>
          {terminal?.running ? (
            <button disabled={busy === "stop"} onClick={() => act("stop", () => stopTerminal(repo))}><Square size={14} /> Stop</button>
          ) : (
            <button disabled={busy === "start"} onClick={() => act("start", () => startTerminal(repo))}><Play size={14} /> Open terminal</button>
          )}
          <button disabled={!terminal?.output || busy === "clear"} onClick={() => act("clear", () => clearTerminal(repo))}>Wis</button>
          <button aria-label="Terminal sluiten" className="icon" onClick={onClose}><X size={15} /></button>
        </div>
      </div>
      {(terminal?.output || terminal?.running) && (
        <>
          <pre className="terminal-output" ref={outputRef}>{terminal?.output || "Terminal gestart…"}</pre>
          <form className="terminal-input" onSubmit={submit}>
            <span>$</span>
            <input autoComplete="off" disabled={!terminal?.running || busy === "input"} onChange={(event) => setCommand(event.target.value)} placeholder={terminal?.running ? "Typ een commando en druk Enter" : "Terminal is gestopt"} spellCheck="false" value={command} />
            <button disabled={!terminal?.running || !command.trim() || busy === "input"}>Uitvoeren</button>
          </form>
        </>
      )}
      {error && <div className="runtime-error">{error}</div>}
      <small className="terminal-warning">Commando’s draaien lokaal in de clone-map. Voer alleen code uit die je vertrouwt.</small>
    </aside>
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
