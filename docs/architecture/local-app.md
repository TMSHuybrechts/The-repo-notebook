# Local App Architecture

Repo Notebook is a React + Vite frontend served by a small Node/Express server. The server exists so the app runs locally on the system instead of as a static HTML file, keeps GitHub API calls consistent, and enables controlled local `git clone` operations.

## Runtime Shape

- `server/index.js` exposes JSON API endpoints and serves the Vite app.
- `src/` contains the React UI, client API helpers, and formatting utilities.
- `data/notebook.json` stores saved repository metadata, README content, clone status, and local clone paths at runtime. It is intentionally not committed.
- `data/clones/` is the only directory where clone operations may write repositories.
- `data/runs/` stores install/start logs and is intentionally not committed.

During development the Express server uses Vite middleware, so `npm run dev` starts one local server for both API and UI. In production preview mode, the server serves the static `dist/` build.

## Local Startup

`Start Repo Notebook.bat` is a Windows launcher for local use. It delegates to `scripts/start-repo-notebook.ps1`, checks that Node.js exists, installs project dependencies when `node_modules` is missing, starts the app on port `5188`, and opens `http://127.0.0.1:5188/` when the server is reachable. `scripts/start-repo-notebook.sh` (and `Start Repo Notebook.command` for Finder) do the same on Linux and macOS.

## Platforms

Everything OS-specific sits in `server/platform.js` and `shared/datadir.cjs`:

- **Data dir** — `%LOCALAPPDATA%\RepoNotebook\data` (Windows), `~/Library/Application Support/RepoNotebook/data` (macOS), `$XDG_DATA_HOME/RepoNotebook/data` (Linux); `RN_DATA_DIR` overrides. The server, the Electron shell, the MCP server and the Obsidian plugin all derive the same path.
- **Process trees** — repo children are spawned in their own process group on POSIX (`detached: true`) so `killTree` can stop a whole `npm run dev` tree with one group signal; Windows uses `taskkill /T /F`. On shutdown the server stops every run and terminal it started.
- **PATH** — GUI launches on macOS/Linux can come with a bare PATH; `fixPath()` asks the login shell for its PATH once and merges it with well-known tool folders (Homebrew, nvm, `~/.local/bin`, `~/.cargo/bin`, …).
- **Commands** — `npm` runs via `npm-cli.js` under a real `node` whenever the `npm` wrapper is not usable (Windows `.cmd` shim, packaged app); `python` becomes `python3` where that is the only Python; the venv interpreter lives in `.venv/Scripts` or `.venv/bin`.
- **Docker** — Docker Desktop on Windows (`Docker Desktop.exe`, WSL backend stopped on quit) and macOS (`open -a Docker` / AppleScript quit); on Linux the Docker Desktop user service when present, otherwise the daemon is left to the user.
- **Packaging** — electron-builder targets: NSIS (Windows), dmg + zip (macOS, arm64 and x64), AppImage + tar.gz (Linux). `.github/workflows/build.yml` builds all three on GitHub's runners and drafts a release on `v*` tags.

## Remote mode

Phones and tablets cannot clone or run code, so the mobile version is a remote control of a running app. Remote mode (off by default, toggled via `POST /api/remote` from the **Phone** chip, persisted in `<dataDir>/remote.json`, or forced with `RN_REMOTE=1`) opens a second HTTP listener on `RN_REMOTE_BIND:RN_REMOTE_PORT` (default `0.0.0.0:5189`). Connections on that listener are tagged, and the guard then requires the access token on every request: a `?token=` query on a GET sets an `HttpOnly; SameSite=Strict` cookie and redirects to the clean URL, scripts can send `Authorization: Bearer <token>`. Writes must be same-origin. `/api/remote*` (status, token, QR SVG) is refused on the remote listener, so the pairing secret is only ever shown on the computer itself. `/manifest.webmanifest` is generated per request: for a remote viewer its `start_url` carries the token, which makes an iOS/Android home-screen web app pair itself on first launch. `/api/config` reports `remote: true` so the UI hides the pairing chip there.

## API Surface

- `GET /api/notebook` returns all saved repositories.
- `GET /api/trending` returns a cached Top 10 list of currently popular public GitHub repositories.
- `POST /api/notebook` accepts `{ "url": "https://github.com/owner/repo" }`, fetches metadata, and stores or updates the repository.
- `POST /api/notebook/:owner/:repo/refresh` re-fetches metadata for an existing repository.
- `DELETE /api/notebook/:owner/:repo` removes a repository from the notebook without deleting a local clone.
- `POST /api/notebook/:owner/:repo/clone` accepts `{ "method": "https" | "ssh" }`, clones into `data/clones/<owner>/<repo>`, and stores clone status plus local path.
- `POST /api/notebook/:owner/:repo/open-local` opens the local clone folder when it exists.
- `GET /api/notebook/:owner/:repo/runtime` detects local project type and returns install/start commands, running status, and recent logs.
- `GET /api/notebook/:owner/:repo/log` returns recent install/start logs.
- `POST /api/notebook/:owner/:repo/install` runs the detected install command in the local clone folder.
- `POST /api/notebook/:owner/:repo/start` starts the detected local run command and keeps the process attached to Repo Notebook.
- `POST /api/notebook/:owner/:repo/stop` stops a process started by Repo Notebook.
- `GET|POST /api/notebook/:owner/:repo/terminal[/start|/input|/clear|/stop]` manages one persistent local shell session rooted in a cloned repository.
- `GET /api/mcp/status` reports the MCP transports and the local HTTP endpoint.
- `GET|POST /api/remote` reads or changes remote mode (`{ enabled, regenerate, port }`); `GET /api/remote/qr.svg?target=<pairing url>` renders the QR code. Loopback only.
- `GET /manifest.webmanifest` serves the web-app manifest (home-screen install), with a token-carrying `start_url` for remote viewers.
- `POST /mcp` serves the Repo Notebook MCP tools over stateless Streamable HTTP (same tools as `mcp/server.js` over stdio).

## GitHub Data

The server fetches public repository data from `api.github.com`. It stores the normalized repository summary, topics, license label, root directory entries, and full README Markdown returned by GitHub. README content is rendered as raw Markdown in a bounded local panel. `GITHUB_TOKEN` can be set optionally to raise GitHub API rate limits.

The trending ticker uses GitHub Search API data. It first looks for repositories created during the last fourteen days with meaningful star activity, then falls back to popular repositories pushed during the last seven days. Results are normalized to the same lightweight shape used by the frontend ticker and cached in memory for ten minutes.

## Safety Decisions

- Repository `owner` and `repo` segments must match a conservative GitHub-name pattern.
- Clone commands use `spawn("git", args)` without a shell.
- Install and start commands are detected from local project files and run with argument arrays in the cloned repository directory.
- Clone destinations are resolved and checked to remain under `data/clones`.
- Existing clone directories are not overwritten.
- The MCP HTTP endpoint sits behind the same loopback host/origin guard as the rest of the app.
- Terminal sessions are only created for saved repositories whose guarded clone directory exists; input goes to the shell's stdin as plain lines.
- README content is stored locally and displayed as plain Markdown text, avoiding HTML injection and keeping long content constrained inside the README panel.
