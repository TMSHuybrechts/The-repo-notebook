import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "bin", "repo-notebook-mcp.js");

const EXPECTED_TOOLS = [
  "bulk_save",
  "clone_repo",
  "list_saved_repos",
  "remove_repo",
  "save_repo",
  "search_github",
  "set_repo_meta",
  "trending_repos"
];

// Speaks newline-delimited JSON-RPC to the launcher over stdio.
const startSession = (dataDir) => {
  const child = spawn(process.execPath, [launcher], {
    env: { ...process.env, RN_DATA_DIR: dataDir },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  let nextId = 1;
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  return { child, request, notify };
};

test("repo-notebook-mcp starts a stdio MCP server exposing the documented tools", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "rn-mcp-"));
  const { child, request, notify } = startSession(dataDir);
  try {
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "launcher-test", version: "1.0.0" }
    });
    assert.equal(init.result.serverInfo.name, "repo-notebook");
    notify("notifications/initialized");

    const listed = await request("tools/list");
    const names = listed.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, EXPECTED_TOOLS);

    const call = await request("tools/call", { name: "list_saved_repos", arguments: {} });
    assert.equal(call.result.content[0].text, "No repositories saved yet.");
  } finally {
    child.kill();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
