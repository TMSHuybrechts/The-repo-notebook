// CLI: export the Repo Notebook store as a folder of notes (no Obsidian needed).
//   node scripts/export.mjs <targetDir> [--data <dataDir>] [--folder "Repo Notebook"] [--no-readme]
import * as path from "path";
import { readStore, defaultDataDir } from "../src/core/store";
import { syncStoreToVault } from "../src/core/sync";
import { fsVault } from "../src/core/fs-vault";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = args.find((a) => !a.startsWith("--") && a !== flag("--data") && a !== flag("--folder"));
if (!target) {
  console.error("Gebruik: node scripts/export.mjs <doelmap> [--data <datamap>] [--folder <naam>] [--no-readme]");
  process.exit(1);
}
const dataDir = flag("--data") || defaultDataDir();
const folder = flag("--folder") || "Repo Notebook";

const main = async () => {
  const started = Date.now();
  const store = await readStore(dataDir);
  const result = await syncStoreToVault(store, fsVault(path.resolve(target)), {
    folder,
    includeReadme: !args.includes("--no-readme"),
    readmeMaxChars: 30000,
    includeRelated: true,
    maxRelated: 6,
    includeFiles: true,
    includeVerdict: true,
    writeIndex: true,
    writeBase: true,
    now: Date.now(),
    serverOnline: false
  });
  console.log(
    `${result.total} repos uit ${dataDir}\n→ ${path.resolve(target, folder)}\n` +
      `nieuw ${result.created} · bijgewerkt ${result.updated} · ongewijzigd ${result.unchanged} · ` +
      `markers-weg ${result.skippedNoMarkers.length} · conflicten ${result.conflicts.length} · verwijderd-gemarkeerd ${result.removedMarked}\n` +
      `graaf: ${result.graph.edges.length} links (${result.graph.edges.filter((e) => e.hidden).length} verborgen), ${result.graph.clusters.length} clusters · ${Date.now() - started} ms`
  );
};
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
