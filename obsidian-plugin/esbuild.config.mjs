import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";

const banner = `/*
Repo Notebook for Obsidian — bundled with esbuild.
Source: obsidian-plugin/src in the Repo Notebook repository.
*/`;

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins
  ],
  format: "cjs",
  target: "es2020",
  platform: "node",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: false
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
