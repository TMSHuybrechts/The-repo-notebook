export const CLUSTER_COLORS = [
  "#2f81f7", "#4fd1a5", "#f0883e", "#d2a8ff", "#f2cc60", "#ff7b72",
  "#79c0ff", "#56d364", "#e3b341", "#ffa198", "#a5d6ff", "#7ee787"
];
export const clusterColor = (index) => CLUSTER_COLORS[index % CLUSTER_COLORS.length];
export const SETTINGS_KEY = "repo-notebook.graph-settings.v1";
export const DEFAULT_SETTINGS = Object.freeze({
  springK: 0.035, repulsion: 1500, sizeMode: "degree", colorMode: "cluster",
  monoColor: "#2f81f7", todoColor: "#58a6ff", otherColor: "#4fd1a5",
  clusterColors: Object.freeze({})
});

const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
const bounded = (value, min, max, fallback) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

export function normalizeSettings(value) {
  const v = value && typeof value === "object" ? value : {};
  const d = DEFAULT_SETTINGS;
  return {
    springK: bounded(v.springK, 0, 0.1, d.springK),
    repulsion: bounded(v.repulsion, 0, 6000, d.repulsion),
    sizeMode: ["fixed", "stars", "degree"].includes(v.sizeMode) ? v.sizeMode : d.sizeMode,
    colorMode: ["mono", "status", "cluster", "manual"].includes(v.colorMode) ? v.colorMode : d.colorMode,
    monoColor: color(v.monoColor, d.monoColor),
    todoColor: color(v.todoColor, d.todoColor),
    otherColor: color(v.otherColor, d.otherColor),
    clusterColors: Object.fromEntries(Object.entries(v.clusterColors && typeof v.clusterColors === "object" ? v.clusterColors : {})
      .filter(([, value]) => color(value, null)))
  };
}

export function loadGraphSettings() {
  try { return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY))); }
  catch { return normalizeSettings(null); }
}

// Cluster numbers can change after recomputing the graph. Match manual colours
// to membership instead, so a colour cannot silently move to an unrelated group.
export function clusterKeys(graph) {
  const members = new Map();
  for (const node of graph?.nodes || []) {
    if (!members.has(node.cluster)) members.set(node.cluster, []);
    members.get(node.cluster).push(String(node.id));
  }
  return new Map([...members].map(([id, ids]) => [id, JSON.stringify(ids.sort())]));
}

export function nodeColor(node, settings, keys) {
  if (settings.colorMode === "mono") return settings.monoColor;
  if (settings.colorMode === "status") return node.status === "todo" ? settings.todoColor : settings.otherColor;
  if (settings.colorMode === "manual") return settings.clusterColors[keys.get(node.cluster)] || clusterColor(node.cluster);
  return clusterColor(node.cluster);
}

export function nodeRadius(node, mode = "degree") {
  if (mode === "fixed") return 8;
  const value = Number(mode === "stars" ? node.stars : node.degree);
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return 6 + Math.min(9, mode === "stars" ? Math.log10(1 + safe) * 1.8 : Math.sqrt(safe) * 2.2);
}

// The same subgraph drives physics, painting, hit testing and related rows.
// Never remove nodes or edges from the source graph itself.
export function visibleGraph(graph, hiddenClusters) {
  const nodes = (graph?.nodes || []).filter((node) => !hiddenClusters.has(node.cluster));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = (graph?.edges || []).filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  return { ...graph, nodes, edges };
}
