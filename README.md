# Repo Notebook

Repo Notebook is a local Node app for saving GitHub repositories alphabetically, including repository metadata and README content. It can also show a live GitHub Top 10 ticker and clone a full repository into a safe local folder inside the app.

## Run

```bash
npm install
npm run dev
```

Open the local URL shown in the terminal.

On Windows, you can also double-click `Start Repo Notebook.bat`.

## Use

Paste a public GitHub repository URL, press **Save repo**, then browse saved repositories by letter. Select a repository to see its About data, files, locally saved README, and actions.

The **Top 10 now** ticker shows currently popular public GitHub repositories. Clicking a ticker title saves it into the notebook, while the external-link icon opens it on GitHub.

The **Clone** action clones into:

```text
data/clones/<owner>/<repo>
```

If the repository is already present there, Repo Notebook reports the existing path instead of overwriting it.

After cloning, **Open map** opens the local clone folder on your system.

Each cloned repository also gets a **Terminal** action that opens an embedded bottom drawer.
On Windows it uses PowerShell; on macOS/Linux it uses the user's shell. The
terminal starts in that repository's clone folder and stays local to Repo
Notebook.

For recognized Node and Python repositories, the local panel can also run detected install/start commands such as `npm install`, `npm run dev`, or `pip install -r requirements.txt`. Runtime logs are stored under `data/runs/`.

## MCP

Repo Notebook exposes its tools in two ways:

- Streamable HTTP at `http://127.0.0.1:5188/mcp` while the desktop app is running.
- STDIO with `npm run mcp` from a source checkout.

Use the **MCP** button in the app to see the live endpoint and copy the Codex
registration command. The endpoint binds to loopback only. To use it from
ChatGPT Work, connect it through OpenAI Secure MCP Tunnel instead of exposing
the port publicly.

## Optional GitHub Token

Unauthenticated GitHub API calls work for normal use but are rate limited. Set `GITHUB_TOKEN` before starting the app if you need a higher rate limit.

## Notes

This app is intended for public repositories. Private repositories may require GitHub credentials for both API access and cloning.

## Security & privacy

Repo Notebook runs entirely on your own machine and binds to `127.0.0.1` only.
Because it can **clone, install and run** the repositories you save, it executes
third-party code that you choose — treat it like running any repo locally. The
local server rejects requests from other origins/hosts (CSRF + DNS-rebinding
guard), so a website you visit cannot drive it. Your saved repos, clones and any
tokens stay local (see `.gitignore`); nothing is uploaded.

Optional environment variables:

- `GITHUB_TOKEN` — higher GitHub API rate limit and access to private repos.
- `RN_AI_PROVIDER` — `ollama` (default, local, no tokens) · `anthropic` · `openai`.
- `RN_AI_MODEL` — model name for the chosen provider.
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — only needed for those providers.
