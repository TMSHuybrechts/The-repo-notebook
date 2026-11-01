#!/usr/bin/env bash
# Start Repo Notebook from a clone on Linux or macOS: checks for Node.js,
# installs dependencies on first run, starts the server and opens the browser
# once it answers. Windows has "Start Repo Notebook.bat" for the same job.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${PORT:-5188}"
url="http://127.0.0.1:${port}/"
api="http://127.0.0.1:${port}/api/health"
cd "$root"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to run Repo Notebook (https://nodejs.org)." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing project dependencies..."
  npm install
fi

open_browser() {
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then open "$1"
  else echo "Open $1 in your browser."
  fi
}

# Already running? Just open it.
if curl -fsS --max-time 1 "$api" >/dev/null 2>&1; then
  open_browser "$url"
  exit 0
fi

(
  for _ in $(seq 1 40); do
    if curl -fsS --max-time 1 "$api" >/dev/null 2>&1; then
      open_browser "$url"
      break
    fi
    sleep 0.5
  done
) &

exec npm run dev
