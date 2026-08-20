// Generates/updates the standalone plugin repository (for BRAT / the community
// list) from this canonical source. Development happens HERE, in the app repo;
// the standalone repo is a build artifact plus its own git history.
//
//   node scripts/sync-standalone.mjs [targetDir]
//
// Transforms applied on the way out:
//  - src/core/graph-engine.js re-exports the VENDORED ../../server/graph.js,
//    copied into the standalone repo as src/core/graph.js (no app checkout needed).
//  - README gets a BRAT install section and absolute links to the app repo.
//  - LICENSE (MIT) and a GitHub Actions release workflow are added.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const pluginRoot = path.resolve(here, "..");
const appRoot = path.resolve(pluginRoot, "..");
const target = path.resolve(process.argv[2] || path.join(appRoot, "..", "obsidian-repo-notebook"));

const APP_REPO_URL = "https://github.com/TMSHuybrechts/The-repo-notebook";
const PLUGIN_REPO = "TMSHuybrechts/obsidian-repo-notebook";

// --- 1. tracked plugin files ------------------------------------------------
const files = execSync("git ls-files obsidian-plugin", { cwd: appRoot, encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  .map((f) => f.replace(/^obsidian-plugin\//, ""))
  .filter((f) => f !== "scripts/sync-standalone.mjs"); // meta: not part of the standalone repo

for (const rel of files) {
  const dest = path.join(target, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(path.join(pluginRoot, rel), dest);
}

// --- 2. vendor the graph engine --------------------------------------------
copyFileSync(path.join(appRoot, "server", "graph.js"), path.join(target, "src", "core", "graph.js"));
writeFileSync(
  path.join(target, "src", "core", "graph-engine.js"),
  `// Vendored copy of the Repo Notebook graph engine (${APP_REPO_URL},
// server/graph.js) so "Verwante repos" in the vault are computed by exactly
// the same code as the map inside the desktop app. Do not edit here — it is
// refreshed by scripts/sync-standalone.mjs in the app repository.
export { buildGraph } from "./graph.js";
`
);

// --- 3. README: absolute links + BRAT section -------------------------------
let readme = readFileSync(path.join(pluginRoot, "README.md"), "utf8");
const replace = (old, next, label) => {
  if (!readme.includes(old)) throw new Error(`README anchor missing: ${label}`);
  readme = readme.replace(old, next);
};
replace("[Repo Notebook](../README.md)", `[Repo Notebook](${APP_REPO_URL})`, "app link");
replace(
  "## Install\n",
  `> **Note** — development happens in the [Repo Notebook repository](${APP_REPO_URL}) (\`obsidian-plugin/\`); this repository is the install/release channel for Obsidian. Issues and PRs are welcome in either place.

## Install (BRAT)

1. Install **BRAT** from Obsidian's community plugins (its full name is "Obsidian42 - BRAT").
2. In BRAT's settings choose **Add beta plugin** and paste \`${PLUGIN_REPO}\`.
3. Enable **Repo Notebook** under Settings → Community plugins.

BRAT keeps the plugin updated from this repository's releases.

## Install from source
`,
  "install heading"
);
replace(
  "Easiest for other people: via **BRAT** from the standalone repo [TMSHuybrechts/obsidian-repo-notebook](https://github.com/TMSHuybrechts/obsidian-repo-notebook) (generated from this folder by `scripts/sync-standalone.mjs`). From source:\n\n",
  "",
  "BRAT self-reference"
);
replace("```bash\ncd obsidian-plugin\nnpm install", "```bash\nnpm install", "cd line");
writeFileSync(path.join(target, "README.md"), readme);

// --- 4. LICENSE -------------------------------------------------------------
const year = new Date().getFullYear();
writeFileSync(
  path.join(target, "LICENSE"),
  `MIT License

Copyright (c) ${year} Thomas Huybrechts

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
);

// --- 5. release workflow ----------------------------------------------------
mkdirSync(path.join(target, ".github", "workflows"), { recursive: true });
writeFileSync(
  path.join(target, ".github", "workflows", "release.yml"),
  `# Push a tag that matches manifest.json's version (e.g. 0.1.0) and this
# builds the plugin, runs the tests, and attaches manifest.json + main.js +
# styles.css to a GitHub release — exactly what BRAT installs from.
name: Release
on:
  push:
    tags: ["*"]
permissions:
  contents: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: npm ci
      - name: Check tag matches manifest version
        run: |
          V=$(node -p "require('./manifest.json').version")
          [ "\${GITHUB_REF_NAME}" = "\$V" ] || { echo "tag \${GITHUB_REF_NAME} != manifest \$V"; exit 1; }
      - run: npm test
      - run: npm run build
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            manifest.json
            main.js
            styles.css
`
);

console.log(`${files.length} bestanden → ${target}`);
console.log("plus: src/core/graph.js (vendored), README (BRAT), LICENSE, .github/workflows/release.yml");
