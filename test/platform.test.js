import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { childSpawnOptions, findOnPath, killTree, reachableAddresses, resolveNpmCli, venvPython } from "../server/platform.js";

const require = createRequire(import.meta.url);
const { defaultDataDir } = require("../shared/datadir.cjs");

const win = (file) => file.split("/").join(path.sep);

test("default data dir follows each platform's convention and RN_DATA_DIR wins", () => {
  assert.equal(
    defaultDataDir({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "win32"),
    path.join("C:\\Users\\me\\AppData\\Local", "RepoNotebook", "data")
  );
  assert.equal(
    defaultDataDir({ HOME: "/Users/me" }, "darwin"),
    path.join("/Users/me", "Library", "Application Support", "RepoNotebook", "data")
  );
  assert.equal(defaultDataDir({ HOME: "/home/me" }, "linux"), path.join("/home/me", ".local", "share", "RepoNotebook", "data"));
  assert.equal(defaultDataDir({ HOME: "/home/me", XDG_DATA_HOME: "/data/xdg" }, "linux"), path.join("/data/xdg", "RepoNotebook", "data"));
  assert.equal(defaultDataDir({ RN_DATA_DIR: "custom-dir", HOME: "/home/me" }, "linux"), path.resolve("custom-dir"));
  // Windows without LOCALAPPDATA (service accounts) still lands under the profile.
  assert.equal(
    defaultDataDir({ USERPROFILE: "C:\\Users\\svc" }, "win32"),
    path.join("C:\\Users\\svc", "AppData", "Local", "RepoNotebook", "data")
  );
});

test("venv python path differs per platform", () => {
  const expected = process.platform === "win32" ? win("x/.venv/Scripts/python.exe") : "x/.venv/bin/python";
  assert.equal(venvPython("x"), expected);
});

test("findOnPath finds node itself and nothing for a made-up name", () => {
  const found = findOnPath(process.platform === "win32" ? "node" : path.basename(process.execPath));
  assert.ok(found, "node should be on PATH in the test environment");
  assert.equal(findOnPath("repo-notebook-no-such-binary-xyz"), "");
});

test("resolveNpmCli returns a node + npm-cli.js pair when npm is installed next to node", () => {
  const npm = resolveNpmCli();
  if (!npm) return; // some CI images keep npm elsewhere; nothing to assert then
  assert.ok(npm.cli.endsWith("npm-cli.js"));
  assert.ok(path.isAbsolute(npm.node));
});

test("reachableAddresses only lists IPv4, non-loopback, non-link-local entries", () => {
  for (const entry of reachableAddresses()) {
    assert.match(entry.address, /^\d+\.\d+\.\d+\.\d+$/);
    assert.ok(!entry.address.startsWith("127."));
    assert.ok(!entry.address.startsWith("169.254."));
    assert.ok(["lan", "tailscale"].includes(entry.kind));
  }
});

test("childSpawnOptions gives POSIX children their own process group", () => {
  const opts = childSpawnOptions();
  if (process.platform === "win32") assert.equal(opts.detached, undefined);
  else assert.equal(opts.detached, true);
});

test("killTree stops a child together with its grandchild", { skip: process.platform === "win32" ? "process groups are POSIX-only; Windows uses taskkill /T" : false }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rn-killtree-"));
  const marker = path.join(dir, "grandchild.pid");
  // Parent node spawns a sleeping grandchild and records its pid, then idles.
  const script = `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(${JSON.stringify(marker)}, String(kid.pid));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", ...childSpawnOptions() });
  let grandchildPid = 0;
  for (let i = 0; i < 50 && !grandchildPid; i++) {
    await new Promise((r) => setTimeout(r, 100));
    grandchildPid = Number(await fs.readFile(marker, "utf8").catch(() => 0));
  }
  assert.ok(grandchildPid > 0, "grandchild should have started");
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive(grandchildPid));
  killTree(child);
  for (let i = 0; i < 50 && alive(grandchildPid); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(grandchildPid), false, "grandchild should be gone after killTree");
  await fs.rm(dir, { recursive: true, force: true });
});
