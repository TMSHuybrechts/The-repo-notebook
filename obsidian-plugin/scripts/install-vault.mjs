// Copies the built plugin into a vault:  node scripts/install-vault.mjs [vaultPath] [--enable]
// Without a path it picks the vault Obsidian currently has open (obsidian.json).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const enable = args.includes("--enable");
let vault = args.find((a) => !a.startsWith("--")) || process.env.OBSIDIAN_VAULT || "";

if (!vault) {
  const cfg = path.join(process.env.APPDATA || "", "obsidian", "obsidian.json");
  if (existsSync(cfg)) {
    const data = JSON.parse(readFileSync(cfg, "utf8"));
    const vaults = Object.values(data.vaults || {});
    const open = vaults.find((v) => v.open) || vaults.sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
    vault = open?.path || "";
  }
}
if (!vault || !existsSync(vault)) {
  console.error("Geen vault gevonden. Geef het pad mee: node scripts/install-vault.mjs <vault> [--enable]");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
const dest = path.join(vault, ".obsidian", "plugins", manifest.id);
mkdirSync(dest, { recursive: true });
for (const file of ["manifest.json", "main.js", "styles.css"]) {
  const src = path.join(root, file);
  if (!existsSync(src)) {
    console.error(`${file} ontbreekt — eerst \`npm run build\`.`);
    process.exit(1);
  }
  copyFileSync(src, path.join(dest, file));
}
console.log(`Plugin ${manifest.id} v${manifest.version} → ${dest}`);

if (enable) {
  const listPath = path.join(vault, ".obsidian", "community-plugins.json");
  const list = existsSync(listPath) ? JSON.parse(readFileSync(listPath, "utf8")) : [];
  if (!list.includes(manifest.id)) {
    list.push(manifest.id);
    writeFileSync(listPath, `${JSON.stringify(list, null, 2)}\n`);
    console.log(`Ingeschakeld in ${listPath} (herlaad Obsidian of zet de plugin aan/uit in Instellingen → Community plugins).`);
  } else {
    console.log("Stond al ingeschakeld.");
  }
}
