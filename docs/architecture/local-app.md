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

`Start Repo Notebook.bat` is a Windows launcher for local use. It delegates to `scripts/start-repo-notebook.ps1`, checks that Node.js exists, installs project dependencies when `node_modules` is missing, starts the app on port `5188`, and opens `http://127.0.0.1:5188/` when the server is reachable.

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

## GitHub Data

The server fetches public repository data from `api.github.com`. It stores the normalized repository summary, topics, license label, root directory entries, and full README Markdown returned by GitHub. README content is rendered as raw Markdown in a bounded local panel. `GITHUB_TOKEN` can be set optionally to raise GitHub API rate limits.

The trending ticker uses GitHub Search API data. It first looks for repositories created during the last fourteen days with meaningful star activity, then falls back to popular repositories pushed during the last seven days. Results are normalized to the same lightweight shape used by the frontend ticker and cached in memory for ten minutes.

## Safety Decisions

- Repository `owner` and `repo` segments must match a conservative GitHub-name pattern.
- Clone commands use `spawn("git", args)` without a shell.
- Install and start commands are detected from local project files and run with argument arrays in the cloned repository directory.
- Clone destinations are resolved and checked to remain under `data/clones`.
- Existing clone directories are not overwritten.
- README content is stored locally and displayed as plain Markdown text, avoiding HTML injection and keeping long content constrained inside the README panel.
