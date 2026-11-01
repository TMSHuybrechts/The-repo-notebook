// Platform helpers: everything that differs between Windows, macOS and Linux
// lives here so server/index.js can stay about repos, not about operating
// systems.
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";

// Children on POSIX get their own process group (detached: true) so a stop
// can take the whole tree down with one signal — the equivalent of
// `taskkill /T` on Windows. Without it only the direct child (often a shell
// or npm wrapper) dies and the real dev server keeps running.
export const childSpawnOptions = () => (isWindows ? { windowsHide: true } : { detached: true });

// Kill a child and everything it started. Fire-and-forget: callers never
// wait on this, and a child that is already gone is not an error.
export const killTree = (child, signal = "SIGTERM") => {
  if (!child?.pid) return;
  if (isWindows) {
    spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true }).on("error", () => {});
    return;
  }
  const groupKill = (sig) => {
    try {
      process.kill(-child.pid, sig);
      return true;
    } catch {
      return false;
    }
  };
  if (!groupKill(signal)) {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
  if (signal !== "SIGKILL") {
    const escalate = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        groupKill("SIGKILL") || (() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        })();
      }
    }, 5000);
    escalate.unref?.();
  }
};

const executableAt = (file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

// Resolve a command name on PATH (first match). Windows checks the PATHEXT
// variants so `npm` finds npm.cmd and `python` finds python.exe.
export const findOnPath = (name) => {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const names = isWindows
    ? [name, ...((process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").map((ext) => name + ext.toLowerCase()))]
    : [name];
  for (const dir of dirs) {
    for (const candidate of names) {
      const file = path.join(dir, candidate);
      if (executableAt(file)) return file;
    }
  }
  return "";
};

// `python` is Windows-only in practice; Debian/Ubuntu and macOS ship
// `python3` (and often no `python` at all).
let pythonCache;
export const pythonCommand = () => {
  if (pythonCache) return pythonCache;
  if (isWindows) pythonCache = "python";
  else pythonCache = findOnPath("python3") ? "python3" : "python";
  return pythonCache;
};

export const venvPython = (target) =>
  isWindows ? path.join(target, ".venv", "Scripts", "python.exe") : path.join(target, ".venv", "bin", "python");

// npm-cli.js next to a node binary. Windows layout: <nodeDir>/node_modules/npm;
// POSIX layout: <nodeDir>/../lib/node_modules/npm. Used when `npm` itself is
// not runnable (Windows: .cmd shim with shell:false; packaged Electron app:
// process.execPath is Electron, not node).
export const resolveNpmCli = () => {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const nodeName = isWindows ? "node.exe" : "node";
  const nodeDir = dirs.find((dir) => executableAt(path.join(dir, nodeName)));
  const candidates = (dir) =>
    isWindows
      ? [path.join(dir, "node_modules", "npm", "bin", "npm-cli.js")]
      : [path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), path.join(dir, "node_modules", "npm", "bin", "npm-cli.js")];
  for (const dir of nodeDir ? [nodeDir, ...dirs] : dirs) {
    for (const cli of candidates(dir)) {
      if (existsSync(cli)) return { node: nodeDir ? path.join(nodeDir, nodeName) : process.execPath, cli: path.resolve(cli) };
    }
  }
  return null;
};

// GUI launches on macOS (Finder, Dock) and some Linux desktops start the app
// with a bare PATH: no Homebrew, no nvm, no ~/.local/bin. The user's shell
// knows the real PATH, so ask it once and merge the result in. No-op on
// Windows and when the PATH already looks complete.
export const fixPath = () => {
  if (isWindows) return process.env.PATH;
  const home = os.homedir();
  const known = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/snap/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, "go", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".local", "share", "fnm", "aliases", "default", "bin")
  ];
  try {
    const nvmDir = path.join(home, ".nvm", "versions", "node");
    for (const version of readdirSync(nvmDir).sort().reverse()) known.unshift(path.join(nvmDir, version, "bin"));
  } catch {
    /* no nvm */
  }
  let shellPath = "";
  if (process.env.RN_SKIP_SHELL_PATH !== "1") {
    const shell = process.env.SHELL || "/bin/sh";
    const marker = "__RN_PATH__";
    try {
      const result = spawnSync(shell, ["-ilc", `printf '${marker}%s${marker}' "$PATH"`], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, DISABLE_AUTO_UPDATE: "true", TERM: "dumb" }
      });
      const match = result.stdout?.match(new RegExp(`${marker}([^]*?)${marker}`));
      if (match) shellPath = match[1];
    } catch {
      /* shell unavailable or slow: fall back to the known folders */
    }
  }
  const current = (process.env.PATH || "").split(":").filter(Boolean);
  const merged = [...new Set([...current, ...shellPath.split(":").filter(Boolean), ...known])].filter((dir) => existsSync(dir));
  process.env.PATH = merged.join(":");
  return process.env.PATH;
};

// --- Docker Desktop / daemon per platform --------------------------------
const DOCKER_DESKTOP_WIN = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";

const detached = (cmd, args) => {
  const child = spawn(cmd, args, { detached: true, shell: false, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
};

// Try to bring the Docker daemon up. Returns false when this platform has no
// launcher we can drive (e.g. a Linux box where dockerd is a root service).
export const launchDocker = () => {
  if (isWindows) {
    if (!existsSync(DOCKER_DESKTOP_WIN)) return false;
    detached(DOCKER_DESKTOP_WIN, []);
    return true;
  }
  if (isMac) {
    detached("open", ["-a", "Docker"]);
    return true;
  }
  // Docker Desktop for Linux runs as a user service; plain dockerd needs root
  // (sudo) which we never ask for — the user starts it themselves.
  if (findOnPath("systemctl")) {
    detached("systemctl", ["--user", "start", "docker-desktop"]);
    return true;
  }
  return false;
};

export const quitDocker = () => {
  if (isWindows) {
    spawn("taskkill.exe", ["/IM", "Docker Desktop.exe", "/F"], { shell: false, windowsHide: true }).on("error", () => {});
    // WSL backend keeps the RAM until its distro is stopped.
    setTimeout(() => {
      spawn("wsl.exe", ["--terminate", "docker-desktop"], { shell: false, windowsHide: true }).on("error", () => {});
    }, 2000);
    return true;
  }
  if (isMac) {
    detached("osascript", ["-e", 'quit app "Docker"']);
    return true;
  }
  if (findOnPath("systemctl")) {
    detached("systemctl", ["--user", "stop", "docker-desktop"]);
    return true;
  }
  return false;
};

// LAN / VPN addresses other devices can reach this machine on. Tailscale
// hands out 100.64.0.0/10; it is listed first because that is the safest
// way to reach the app from a phone.
// Virtual adapters (Hyper-V/WSL switches, Docker bridges, VM host-only nets)
// are reachable from nothing a phone can see, so they only clutter the list.
const VIRTUAL_INTERFACE = /vethernet|hyper-v|wsl|docker|virbr|^veth|^br-|vmnet|vbox|virtualbox|^bridge\d/i;
export const reachableAddresses = () => {
  const found = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      const [a, b] = entry.address.split(".").map(Number);
      const tailscale = a === 100 && b >= 64 && b <= 127;
      const linkLocal = a === 169 && b === 254;
      if (linkLocal) continue;
      if (!tailscale && VIRTUAL_INTERFACE.test(name)) continue;
      found.push({ address: entry.address, interface: name, kind: tailscale ? "tailscale" : "lan" });
    }
  }
  return found.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "tailscale" ? -1 : 1));
};
