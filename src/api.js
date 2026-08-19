const json = async (res) => {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
};

export const loadNotebook = () => fetch("/api/notebook").then(json);

export const loadGraph = () => fetch("/api/graph").then(json);

export const loadTrending = () => fetch("/api/trending").then(json);

export const saveRepo = (url) =>
  fetch("/api/notebook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  }).then(json);

export const refreshRepo = (repo) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/refresh`, {
    method: "POST"
  }).then(json);

export const removeRepo = (repo) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`, {
    method: "DELETE"
  }).then(json);

export const cloneRepo = (repo, method) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/clone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method })
  }).then(json);

export const openLocalRepo = (repo) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/open-local`, {
    method: "POST"
  }).then(json);

export const loadRuntime = (repo) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/runtime`).then(json);

export const loadRuntimes = () => fetch("/api/runtimes").then(json);

export const installRepo = (repo) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/install`, {
    method: "POST"
  }).then(json);

export const startRepo = (repo) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/start`, {
    method: "POST"
  }).then(json);

export const stopRepo = (repo) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/stop`, {
    method: "POST"
  }).then(json);

export const loadLog = (repo) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/log`).then(json);

export const setRepoMeta = (repo, meta) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/meta`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(meta)
  }).then(json);

export const loadConfig = () => fetch("/api/config").then(json);

export const bulkSave = (text) =>
  fetch("/api/notebook/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  }).then(json);

export const importStars = (username) =>
  fetch("/api/import-stars", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  }).then(json);

export const importNotebook = (repos) =>
  fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repos })
  }).then(json);

export const pullRepo = (repo) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pull`, {
    method: "POST"
  }).then(json);

export const checkUpdates = (repo) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/updates`).then(json);

export const repoSize = (repo) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/size`).then(json);

export const deleteClone = (repo) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/delete-clone`, {
    method: "POST"
  }).then(json);

export const loadEnv = (repo) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/env`).then(json);

export const saveEnv = (repo, content) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/env`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  }).then(json);

export const checkUpdatesAll = () => fetch("/api/updates-all").then(json);

export const dockerStatus = () => fetch("/api/docker").then(json);

export const dockerStart = () => fetch("/api/docker/start", { method: "POST" }).then(json);

export const dockerStop = () => fetch("/api/docker/stop", { method: "POST" }).then(json);

export const startContainer = (repo) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/start-container`, {
    method: "POST"
  }).then(json);

export const loadDuplicates = () => fetch("/api/duplicates").then(json);

export const startBulkVerdicts = () => fetch("/api/verdicts/bulk", { method: "POST" }).then(json);

export const bulkVerdictStatus = () => fetch("/api/verdicts/bulk").then(json);

export const repoVerdict = (repo, refresh = false) =>
  fetch(`/api/notebook/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/verdict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh })
  }).then(json);
