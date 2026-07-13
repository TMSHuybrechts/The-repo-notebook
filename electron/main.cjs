// Electron shell for Repo Notebook.
//
// Runs the existing Express server (server/index.js) as a background Node
// process on a stable loopback port when possible, then loads it in a native window. The
// server is unchanged apart from honouring RN_DATA_DIR, so all data lives in
// a stable per-user folder that survives app updates.

const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const appRoot = path.join(__dirname, "..");
// Stable, update-proof data location (chosen by the user).
const baseDir = process.env.LOCALAPPDATA || process.env.APPDATA || app.getPath("home");
const dataDir = path.join(baseDir, "RepoNotebook", "data");

let serverProc = null;
let serverPort = 0;

const freePort = (preferred = 5188) =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", () => {
      const fallback = net.createServer();
      fallback.once("error", reject);
      fallback.listen(0, "127.0.0.1", () => {
        const { port } = fallback.address();
        fallback.close(() => resolve(port));
      });
    });
    srv.listen(preferred, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

// One-time seed: if the stable location has no notebook yet but a bundled/dev
// data/ exists, copy the saved repo list across. Copy (never move) so the
// original stays as a backup — the saved repos can never be lost here.
const seedData = () => {
  try {
    fs.mkdirSync(path.join(dataDir, "clones"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "runs"), { recursive: true });
    const dest = path.join(dataDir, "notebook.json");
    const legacy = path.join(appRoot, "data", "notebook.json");
    if (!fs.existsSync(dest) && fs.existsSync(legacy)) {
      fs.copyFileSync(legacy, dest);
    }
  } catch {
    /* non-fatal: the server will create an empty store on first use */
  }
};

const waitForServer = (port) =>
  new Promise((resolve) => {
    const attempt = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/api/notebook", timeout: 800 },
        (res) => {
          res.resume();
          resolve();
        }
      );
      req.on("error", () => setTimeout(attempt, 250));
      req.on("timeout", () => {
        req.destroy();
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });

const startServer = async () => {
  serverPort = await freePort();
  serverProc = spawn(process.execPath, [path.join(appRoot, "server", "index.js"), "--production"], {
    cwd: appRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1", // run server/index.js as plain Node, not a second Electron
      NODE_ENV: "production",
      RN_DATA_DIR: dataDir,
      PORT: String(serverPort)
    },
    stdio: "ignore",
    windowsHide: true
  });
  serverProc.on("exit", () => {
    serverProc = null;
  });
  await waitForServer(serverPort);
};

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0e14",
    title: "Repo Notebook",
    icon: path.join(appRoot, "public", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });

  // Open GitHub / external links in the real browser, not inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "deny" };
  });

  win.loadURL(`http://127.0.0.1:${serverPort}/`);
};

const killServer = () => {
  if (!serverProc) return;
  const proc = serverProc;
  serverProc = null;
  try {
    if (process.platform === "win32") {
      spawn("taskkill.exe", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
};

app.whenReady().then(async () => {
  seedData();
  try {
    await startServer();
  } catch (err) {
    console.error("Failed to start Repo Notebook server:", err);
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  killServer();
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", killServer);
app.on("quit", killServer);
