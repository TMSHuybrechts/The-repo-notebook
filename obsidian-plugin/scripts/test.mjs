// Bundles every test/*.test.ts with esbuild (core modules have no Obsidian
// imports) and runs them with node's built-in test runner.
import esbuild from "esbuild";
import { readdirSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const outdir = path.join(root, "test-dist");
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const entries = readdirSync(path.join(root, "test"))
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join(root, "test", f));

await esbuild.build({
  entryPoints: entries,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outdir,
  outExtension: { ".js": ".mjs" },
  sourcemap: "inline",
  logLevel: "warning",
  // The harness test loads the real plugin class against a small fake of the
  // Obsidian API; production builds keep "obsidian" external (esbuild.config.mjs).
  alias: { obsidian: path.join(root, "test", "fake-obsidian.ts") }
});

const files = readdirSync(outdir).filter((f) => f.endsWith(".mjs")).map((f) => path.join(outdir, f));
const run = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", cwd: root });
process.exit(run.status ?? 1);
