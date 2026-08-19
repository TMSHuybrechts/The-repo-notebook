// Thin launcher: bundles export.entry.ts (TypeScript) on the fly and runs it.
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "..");
const outdir = path.join(root, "test-dist");
mkdirSync(outdir, { recursive: true });
const outfile = path.join(outdir, "export.mjs");
await esbuild.build({
  entryPoints: [path.join(here, "export.entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
  logLevel: "warning"
});
const run = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit", cwd: root });
process.exit(run.status ?? 1);
