"use strict";
// Per-user data folder for Repo Notebook. One answer for the server, the
// desktop shell, the MCP server and scripts, so they always share one shelf.
//
//   Windows  %LOCALAPPDATA%\RepoNotebook\data
//   macOS    ~/Library/Application Support/RepoNotebook/data
//   Linux    $XDG_DATA_HOME/RepoNotebook/data   (default ~/.local/share/...)
//
// RN_DATA_DIR overrides everything. CommonJS on purpose: the Electron main
// process is CJS and the ESM server/MCP import it just as easily.
const path = require("node:path");
const os = require("node:os");

function defaultDataDir(env = process.env, platform = process.platform) {
  if (env.RN_DATA_DIR) return path.resolve(env.RN_DATA_DIR);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || env.APPDATA || path.join(home, "AppData", "Local");
    return path.join(base, "RepoNotebook", "data");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "RepoNotebook", "data");
  }
  const base = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(base, "RepoNotebook", "data");
}

module.exports = { defaultDataDir };
