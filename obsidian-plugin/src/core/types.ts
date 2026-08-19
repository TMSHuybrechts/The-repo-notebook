// Shared types for the Repo Notebook plugin.
//
// `RepoRecord` mirrors the records the Repo Notebook app writes to
// notebook.json (server/index.js → recordFromMeta + later patches). Everything
// is optional except the identity fields, because older records and records
// written by the MCP server don't carry every key.

export interface RepoFile {
  name: string;
  path: string;
  type: string;
  size: number;
  htmlUrl: string;
}

export type RepoStatus = "" | "todo" | "installed" | "keep" | "archive";

export interface RepoRecord {
  id: string; // "owner/name" lower-cased
  owner: string;
  name: string;
  fullName: string;
  description?: string;
  htmlUrl?: string;
  cloneUrl?: string;
  sshUrl?: string;
  homepage?: string;
  visibility?: string;
  defaultBranch?: string;
  language?: string;
  topics?: string[];
  license?: string;
  stars?: number;
  forks?: number;
  watchers?: number;
  openIssues?: number;
  archived?: boolean;
  updatedAt?: string;
  pushedAt?: string;
  savedAt?: string;
  fetchedAt?: string;
  files?: RepoFile[];
  readme?: string;
  // Organisation written by the app / MCP / this plugin
  category?: string;
  status?: RepoStatus | string;
  note?: string;
  // Clone + runtime bookkeeping written by the app
  cloneStatus?: string;
  localPath?: string;
  clonedAt?: string;
  installStatus?: string;
  installedAt?: string;
  lastStartCommand?: string;
  lastStartedAt?: string;
  lastPort?: string;
  lastUrl?: string;
  containerMode?: boolean;
  containerPort?: string;
  containerGpu?: boolean;
  // AI verdict
  aiVerdict?: string;
  aiVerdictAt?: string;
  aiProvider?: string;
  [key: string]: unknown;
}

export interface Store {
  repos: RepoRecord[];
}

export interface GraphNode {
  id: string;
  name: string;
  fullName: string;
  owner: string;
  description: string;
  language: string;
  category: string;
  status: string;
  stars: number;
  topics: string[];
  cluster: number;
  degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  score: number;
  hidden: boolean;
  sharedTopics: string[];
  sharedTerms: string[];
  sameCategory: boolean;
  sameOwner: boolean;
  sameLanguage: boolean;
}

export interface GraphCluster {
  id: number;
  label: string;
  size: number;
}

export interface Graph {
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
}

// Written by the Repo Notebook server (server/index.js) next to notebook.json
// so clients can find the live port of the desktop app.
export interface ServerInfo {
  port: number;
  pid: number;
  startedAt: string;
  dataDir?: string;
  mode?: string;
}

export interface RuntimeItem {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  language: string;
  category: string;
  status: string;
  localPath: string;
  type: string;
  canStart: boolean;
  startLabel: string;
  installLabel: string;
  installStatus: string;
  installedAt: string;
  running: boolean;
  pid: number | null;
  startedAt: string;
  url: string;
  port: string;
  mode: string;
  lastPort: string;
  lastUrl: string;
  containerMode: boolean;
}

export const STATUS_LABELS: Record<string, string> = {
  todo: "Te proberen",
  installed: "Geïnstalleerd",
  keep: "Bevalt",
  archive: "Archief"
};
export const STATUS_ORDER = ["todo", "installed", "keep", "archive"] as const;
export const ALLOWED_STATUS = new Set(["", "todo", "installed", "keep", "archive"]);

export interface Health {
  key: "archived" | "active" | "quiet" | "stale";
  label: string;
}
