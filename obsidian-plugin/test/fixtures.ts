import type { RepoRecord } from "../src/core/types";

export const sampleRepo = (over: Partial<RepoRecord> = {}): RepoRecord => ({
  id: "browser-use/browser-use",
  owner: "browser-use",
  name: "browser-use",
  fullName: "browser-use/browser-use",
  description: "Make websites accessible for AI agents",
  htmlUrl: "https://github.com/browser-use/browser-use",
  cloneUrl: "https://github.com/browser-use/browser-use.git",
  homepage: "https://browser-use.com",
  defaultBranch: "main",
  language: "Python",
  topics: ["ai", "agents", "browser"],
  license: "MIT",
  stars: 61234,
  forks: 6543,
  pushedAt: "2026-08-10T10:00:00Z",
  savedAt: "2026-07-01T10:00:00Z",
  fetchedAt: "2026-08-15T10:00:00Z",
  files: [
    { name: "src", path: "src", type: "dir", size: 0, htmlUrl: "" },
    { name: "README.md", path: "README.md", type: "file", size: 1200, htmlUrl: "" }
  ],
  readme: "# Browser Use\n\nSee [docs](docs/index.md) and ![logo](static/logo.png).\n\n```sh\n# not a heading\npip install browser-use\n```\n\nTry #hashtag and [[wiki]].",
  status: "todo",
  category: "agents",
  ...over
});
