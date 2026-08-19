// Ad-hoc, read-only check against a LIVE Repo Notebook app (not part of `npm test`):
//   node scripts/test.mjs is not involved — bundle + run via scripts/live-check.mjs.
// Verifies server.json discovery, probe, and a few GET endpoints through the
// plugin's ServerClient using the fake requestUrl (= Node fetch).
import * as fs from "node:fs";
import * as path from "node:path";
import { ServerClient } from "../src/server";

const port = Number(process.argv[2] || 0);
if (!port) {
  console.error("usage: live-check <port>");
  process.exit(1);
}
const dir = fs.mkdtempSync(path.join(process.env.RN_TEST_SCRATCH || ".", "rn-live-"));
fs.writeFileSync(path.join(dir, "server.json"), JSON.stringify({ port, pid: 0, startedAt: "x" }));

const client = new ServerClient(
  () => dir,
  () => "http://127.0.0.1:1"
);
const main = async () => {
  const url = await client.discover(true);
  console.log("discovered:", url);
  if (!url) process.exit(2);
  const cfg = await client.config();
  console.log("config:", JSON.stringify(cfg));
  const nb = await client.notebook();
  console.log("repos:", nb.repos.length);
  const rt = await client.runtimes();
  console.log("runtimes:", rt.items.length, "running:", rt.items.filter((i) => i.running).length);
  const graph = await client.graph();
  console.log("graph:", graph.nodes.length, "nodes", graph.edges.length, "edges", graph.clusters.length, "clusters");
  // Stale-port behaviour: a dead port in server.json must fall through to "offline".
  fs.writeFileSync(path.join(dir, "server.json"), JSON.stringify({ port: 1, pid: 0, startedAt: "x" }));
  console.log("stale server.json →", await client.discover(true));
};
main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
