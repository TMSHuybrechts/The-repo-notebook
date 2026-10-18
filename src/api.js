import { getLocale, t } from "./i18n.js";

const apiFetch = (url, options = {}) => fetch(url, {
  ...options,
  headers: { ...options.headers, "Accept-Language": getLocale() }
});

const json = async (res) => {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(t(data.error || "Request failed."));
  return data;
};

export const loadNotebook = () => apiFetch("/api/notebook").then(json);

export const loadGraph = () => apiFetch("/api/graph").then(json);

export const loadTrending = () => apiFetch("/api/trending").then(json);

export const loadSuggestions = (refresh = false) =>
  fetch(`/api/suggestions${refresh ? "?refresh=1" : ""}`).then(json);

export const saveRepo = (url) =>
  apiFetch("/api/notebook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  }).then(json);

export const refreshRepo = (repo) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/refresh`, {
    method: "POST"
  }).then(json);

export const removeRepo = (repo) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`, {
    method: "DELETE"
  }).then(json);

export const cloneRepo = (repo, method) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/clone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method })
  }).then(json);

export const openLocalRepo = (repo) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/open-local`, {
    method: "POST"
  }).then(json);

export const loadRuntime = (repo) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/runtime`).then(json);

export const loadRuntimes = () => apiFetch("/api/runtimes").then(json);

export const installRepo = (repo) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/install`, {
    method: "POST"
  }).then(json);

export const startRepo = (repo) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/start`, {
    method: "POST"
  }).then(json);

export const stopRepo = (repo) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/stop`, {
    method: "POST"
  }).then(json);

export const loadLog = (repo) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/log`).then(json);

export const diagnoseRepo = (repo) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/diagnose`, {
    method: "POST"
  }).then(json);

export const loadProblems = () => fetch("/api/problems").then(json);

export const setRepoMeta = (repo, meta) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/meta`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(meta)
  }).then(json);

export const loadConfig = () => apiFetch("/api/config").then(json);

export const loadMcpStatus = () => apiFetch("/api/mcp/status").then(json);

const terminalUrl = (repo, suffix = "") =>
  `/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/terminal${suffix}`;

export const loadTerminal = (repo) => apiFetch(terminalUrl(repo)).then(json);

export const startTerminal = (repo) => apiFetch(terminalUrl(repo, "/start"), { method: "POST" }).then(json);

export const sendTerminalInput = (repo, input) =>
  apiFetch(terminalUrl(repo, "/input"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input })
  }).then(json);

export const clearTerminal = (repo) => apiFetch(terminalUrl(repo, "/clear"), { method: "POST" }).then(json);

export const stopTerminal = (repo) => apiFetch(terminalUrl(repo, "/stop"), { method: "POST" }).then(json);

export const bulkSave = (text) =>
  apiFetch("/api/notebook/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  }).then(json);

export const harvest = (source) =>
  fetch("/api/harvest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source })
  }).then(json);

export const importStars = (username) =>
  apiFetch("/api/import-stars", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  }).then(json);

export const importNotebook = (repos) =>
  apiFetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repos })
  }).then(json);

export const pullRepo = (repo) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pull`, {
    method: "POST"
  }).then(json);

export const checkUpdates = (repo) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/updates`).then(json);

export const repoSize = (repo) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/size`).then(json);

export const deleteClone = (repo) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/delete-clone`, {
    method: "POST"
  }).then(json);

export const loadEnv = (repo) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/env`).then(json);

export const saveEnv = (repo, content) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/env`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  }).then(json);

export const checkUpdatesAll = () => apiFetch("/api/updates-all").then(json);

export const dockerStatus = () => apiFetch("/api/docker").then(json);

export const dockerStart = () => apiFetch("/api/docker/start", { method: "POST" }).then(json);

export const dockerStop = () => apiFetch("/api/docker/stop", { method: "POST" }).then(json);

export const startContainer = (repo) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/start-container`, {
    method: "POST"
  }).then(json);

export const loadDuplicates = () => apiFetch("/api/duplicates").then(json);

export const startBulkVerdicts = () => apiFetch("/api/verdicts/bulk", { method: "POST" }).then(json);

export const bulkVerdictStatus = () => apiFetch("/api/verdicts/bulk").then(json);

export const repoVerdict = (repo, refresh = false) =>
  apiFetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/verdict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh })
  }).then(json);
