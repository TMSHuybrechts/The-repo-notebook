// Read-only smoke check of the plugin's ServerClient against a running app:
//   node scripts/live-check.mjs <port>      (port = see <dataDir>/server.json)
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "..");
const outdir = path.join(root, "test-dist");
mkdirSync(outdir, { recursive: true });
const outfile = path.join(outdir, "live-check.mjs");
await esbuild.build({
  entryPoints: [path.join(root, "test", "live-server.check.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
  alias: { obsidian: path.join(root, "test", "fake-obsidian.ts") },
  logLevel: "warning"
});
const run = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit", cwd: root });
process.exit(run.status ?? 1);
