# Repo Notebook for Obsidian

Your [Repo Notebook](../README.md) shelf inside Obsidian. Every saved GitHub repo becomes a note, the app's knowledge-graph links become `[[wikilinks]]` (so Obsidian's graph view shows your repo map), and clone / install / start / stop stay one command away.

The plugin reads the same `notebook.json` the desktop app and the MCP server use, so the three stay in sync — save a repo in the app and the note appears in your vault a few seconds later; change a status in the note and the app shows it.

## What you get

| In the vault | Source |
|---|---|
| `Repo Notebook/<owner>/<repo>.md` — one note per repo: frontmatter (stars, language, topics, status, category, cluster, health, cloned …), a summary callout, your own **Notes** section, the AI verdict, **Related repos** with the reason for each link, top-level files, and the README (headings nested, relative links pointed at GitHub, `#words` escaped so they don't become tags) | `notebook.json` + the app's graph engine (`server/graph.js`, bundled) |
| `Repo Notebook/Repo Notebook.md` — index: clusters, statuses, A–Z | generated on every sync |
| `Repo Notebook/Repos.base` — a native Bases table (Obsidian 1.9+): all repos, "To try", "Cloned", grouped by cluster, cards | generated once, kept if unchanged |
| Tags: `#repo-notebook`, `#repo/taal/python`, `#repo/status/todo`, `#repo/categorie/…`, `#repo/cluster/…`, `#repo/gezondheid/active`, `#repo/gekloond` (tag paths are identifiers and stay the same in every language) | colour groups for the graph view |
| Side panel (ribbon icon / "Open the side panel"): search, status chips, letter groups, running dots, right-click menu with every app action | live from `notebook.json` + `/api/runtimes` when the app is online |

## Language

The plugin speaks **English and Dutch**. By default it follows Obsidian's own language (Settings → General → Language): Dutch when Obsidian is set to Nederlands, English otherwise. Override it under **Settings → Repo Notebook → Language** (Automatic / English / Nederlands).

The language covers the side panel, notices, modals, settings, command names and the headings the plugin writes into notes (Notes / Notities, AI verdict / AI-oordeel, Related repos / Verwante repos, the index note and the Bases view names). Command names switch after reloading Obsidian. After a switch, the next sync rewrites each note once with the new headings; your text between the notes markers, your own properties, tags and aliases are kept, and frontmatter keys and tag paths (`#repo/status/todo`, `#repo/taal/python`, …) never change.

## Sync rules (what is yours, what is the app's)

* Everything above and below the markers is regenerated on every sync; the text between `<!-- rn:notes -->` … `<!-- /rn:notes -->` is **yours** and is never touched. If the markers are removed, the note is skipped and never overwritten.
* Your own frontmatter properties, tags and aliases are kept.
* A note that is open in the active editor and was modified in the last 12 s is left alone and retried later.
* **Vault → app**: status, category and the Notes text are written back to Repo Notebook ~1.5 s after you change them (toggle in settings, or use the command "send status/category/notes to the app"). `status` must be one of `todo`, `installed`, `keep`, `archive` or empty.
* **App → vault**: the app's note text only replaces your Notes when you haven't edited them since the last sync; if both changed you keep yours and the app's text is shown in a warning callout under it.
* A repo removed from the app is **not** deleted from the vault: the note gets `rn_removed: true`, the tag `#repo/verwijderd` and a warning callout.
* A sync only rewrites notes whose content actually changed (122 repos ≈ 0.3 s).

## Online vs offline

* Reading, syncing, status/category/notes and **adding repos** (straight from the GitHub API) work without the app.
* Clone, install, start/stop, log, git pull, open folder, refresh and remove need the app; the plugin finds its port through `<data dir>/server.json` (written by the app's server on start) and falls back to the configured URL (`npm run dev` → `http://127.0.0.1:5188`). "Start the Repo Notebook app" launches the packaged `.exe` and waits for it.
* "Open in Repo Notebook app" opens `http://127.0.0.1:<port>/#repo=owner/name`, which selects that repo in the app UI.

## Install

Easiest for other people: via **BRAT** from the standalone repo [TMSHuybrechts/obsidian-repo-notebook](https://github.com/TMSHuybrechts/obsidian-repo-notebook) (generated from this folder by `scripts/sync-standalone.mjs`). From source:

```bash
cd obsidian-plugin
npm install
npm run build                       # → main.js
node scripts/install-vault.mjs      # copies manifest.json, main.js, styles.css into the vault Obsidian has open
# or: node scripts/install-vault.mjs "D:\path\to\vault" --enable
```

Then enable **Repo Notebook** under Settings → Community plugins (or reload Obsidian if you used `--enable`). The first sync runs on startup and creates the `Repo Notebook` folder.

Settings: language (automatic / English / Nederlands), data dir (defaults to `%LOCALAPPDATA%\RepoNotebook\data`, same as the app), fallback server URL, path to `Repo Notebook.exe`, vault folder, README / related / files / verdict toggles, README length cap, index + Bases, sync on startup, watch `notebook.json`, push changes back, open note after add.

## Commands

`Sync all repos to the vault` · `Add repo (URL or text with links)` · `Add repo from clipboard` · `Open the side panel (shelf)` · `Open the index note` · `Open the Repo Notebook app` · `Start the Repo Notebook app` · and, with a repo note active: `Current repo:` `open on GitHub`, `refresh from GitHub`, `clone`, `install`, `start`, `stop`, `show log`, `git pull`, `open local folder`, `send status/category/notes to the app`, `resync this note`, `remove from Repo Notebook`. In Dutch the same commands read `Synchroniseer alle repos naar de vault`, `Repo toevoegen …`, `Huidige repo: kloon`, and so on.

## Without Obsidian

`node scripts/export.mjs <folder> [--data <dataDir>] [--folder "Repo Notebook"] [--lang en|nl] [--no-readme]` writes the same notes/index/base to any folder using the same engine (headings in English unless `--lang nl`) — handy for a quick look or another tool.

## Development

```bash
npm run dev                        # esbuild watch → main.js
npm test                           # node:test — core (render/merge/readme/yaml/store/sync) + a plugin harness against a small fake of the Obsidian API
node scripts/live-check.mjs 6998   # read-only smoke check of the server client against a running app (port: see <dataDir>/server.json)
```

`src/core/*` has no Obsidian imports and holds all the logic (UI text lives in `src/core/i18n.ts`: Dutch source text → English, `{0}` placeholders); `src/main.ts`, `view.ts`, `modals.ts`, `settings.ts`, `server.ts`, `vault-adapter.ts` are the Obsidian layer. The graph engine is imported from `../server/graph.js` at build time, so the vault's "Related repos" are computed by exactly the same code as the map in the app.
