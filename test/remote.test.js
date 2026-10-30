import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const freePort = async () => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
};

// Boots the real server with remote mode forced on, in a throwaway data dir.
const startServer = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rn-remote-"));
  const port = await freePort();
  const remotePort = await freePort();
  const child = spawn(process.execPath, ["server/index.js", "--production"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      RN_DATA_DIR: dir,
      RN_REMOTE: "1",
      RN_REMOTE_PORT: String(remotePort),
      RN_REMOTE_BIND: "127.0.0.1",
      RN_SKIP_SHELL_PATH: "1",
      GITHUB_TOKEN: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  const deadline = Date.now() + 15000;
  while (!log.includes("remote access on")) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    if (Date.now() > deadline) throw new Error(`server did not start remote listener:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const stop = async () => {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await fs.rm(dir, { recursive: true, force: true });
  };
  return { dir, port, remotePort, stop, local: `http://127.0.0.1:${port}`, remote: `http://127.0.0.1:${remotePort}` };
};

test("remote listener needs the token; loopback hands out the pairing link", async () => {
  const srv = await startServer();
  try {
    // Loopback: settings are readable, token included, urls carry it.
    const status = await fetch(`${srv.local}/api/remote`).then((r) => r.json());
    assert.equal(status.enabled, true);
    assert.equal(status.listening, true);
    assert.equal(status.port, srv.remotePort);
    assert.ok(status.token.length >= 24);
    for (const entry of status.urls) assert.ok(entry.url.endsWith(`?token=${status.token}`));

    // Remote without token: API 401, page gets the pairing hint, no data leaks.
    const noToken = await fetch(`${srv.remote}/api/notebook`);
    assert.equal(noToken.status, 401);
    const page = await fetch(`${srv.remote}/`);
    assert.equal(page.status, 401);
    assert.match(await page.text(), /not paired yet/);

    // Wrong token on the pairing URL is refused.
    assert.equal((await fetch(`${srv.remote}/?token=nope`, { redirect: "manual" })).status, 403);

    // Pairing: ?token= sets the cookie and redirects to the clean URL.
    const pair = await fetch(`${srv.remote}/?token=${status.token}`, { redirect: "manual" });
    assert.equal(pair.status, 302);
    assert.equal(pair.headers.get("location"), "/");
    const cookie = pair.headers.get("set-cookie");
    assert.match(cookie, /^rn_remote=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const jar = cookie.split(";")[0];

    // With the cookie the API answers like on loopback.
    const notebook = await fetch(`${srv.remote}/api/notebook`, { headers: { cookie: jar } });
    assert.equal(notebook.status, 200);
    assert.deepEqual(await notebook.json(), { repos: [] });
    // Bearer works too (scripts, other clients).
    assert.equal((await fetch(`${srv.remote}/api/health`, { headers: { authorization: `Bearer ${status.token}` } })).status, 200);

    // /api/config tells the UI it is a remote viewer.
    const config = await fetch(`${srv.remote}/api/config`, { headers: { cookie: jar } }).then((r) => r.json());
    assert.equal(config.remote, true);
    assert.equal((await fetch(`${srv.local}/api/config`).then((r) => r.json())).remote, false);

    // Remote settings (token, QR) stay on the computer itself.
    assert.equal((await fetch(`${srv.remote}/api/remote`, { headers: { cookie: jar } })).status, 403);
    assert.equal((await fetch(`${srv.remote}/api/remote/qr.svg?target=x`, { headers: { cookie: jar } })).status, 403);

    // Cross-site POST with the cookie is refused (CSRF), same-origin passes the guard.
    const csrf = await fetch(`${srv.remote}/api/notebook`, {
      method: "POST",
      headers: { cookie: jar, origin: "https://evil.example", "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(csrf.status, 403);
    const sameOrigin = await fetch(`${srv.remote}/api/notebook`, {
      method: "POST",
      headers: { cookie: jar, origin: srv.remote, "content-type": "application/json" },
      body: JSON.stringify({ url: "not-a-url" })
    });
    assert.equal(sameOrigin.status, 400); // past the guard, rejected by the route itself

    // Manifest: start_url carries the token only for remote viewers.
    const remoteManifest = await fetch(`${srv.remote}/manifest.webmanifest`, { headers: { cookie: jar } }).then((r) => r.json());
    assert.equal(remoteManifest.start_url, `/?token=${status.token}`);
    assert.equal(remoteManifest.display, "standalone");
    const localManifest = await fetch(`${srv.local}/manifest.webmanifest`).then((r) => r.json());
    assert.equal(localManifest.start_url, "/");

    // QR code renders as SVG for a known pairing URL only.
    if (status.urls.length) {
      const qr = await fetch(`${srv.local}/api/remote/qr.svg?target=${encodeURIComponent(status.urls[0].url)}`);
      assert.equal(qr.status, 200);
      assert.match(qr.headers.get("content-type"), /svg/);
      assert.match(await qr.text(), /<svg/);
    }
    assert.equal((await fetch(`${srv.local}/api/remote/qr.svg?target=http://example.com`)).status, 400);

    // server.json advertises the remote port for other clients.
    const info = JSON.parse(await fs.readFile(path.join(srv.dir, "server.json"), "utf8"));
    assert.deepEqual(info.remote, { enabled: true, port: srv.remotePort });

    // Regenerating the code locks out the old cookie; disabling closes the port.
    const regenerated = await fetch(`${srv.local}/api/remote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ regenerate: true })
    }).then((r) => r.json());
    assert.notEqual(regenerated.token, status.token);
    assert.equal((await fetch(`${srv.remote}/api/notebook`, { headers: { cookie: jar } })).status, 401);
    const saved = JSON.parse(await fs.readFile(path.join(srv.dir, "remote.json"), "utf8"));
    assert.equal(saved.token, regenerated.token);
    assert.equal(saved.enabled, true);

    const disabled = await fetch(`${srv.local}/api/remote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false })
    }).then((r) => r.json());
    assert.equal(disabled.listening, false);
    await assert.rejects(fetch(`${srv.remote}/api/health`));
  } finally {
    await srv.stop();
  }
});
