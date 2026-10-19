// Dutch → English message map for the Obsidian plugin, same model as the
// desktop app's shared/i18n.js: the Dutch source text is the key, `{0}`-style
// placeholders are filled from `values`. English is the default and the
// fallback. No Obsidian imports and no global state: callers pass the
// language (core render/sync get it through their options).

export type Lang = "en" | "nl";
/** Persisted setting: "auto" follows Obsidian's UI language. */
export type LanguageSetting = "auto" | Lang;

export const normalizeLang = (value: unknown): Lang => (/^nl(?:[-_]|$)/i.test(String(value ?? "")) ? "nl" : "en");

export const messages: Record<string, string> = {
  // ---- statuses + health (types.ts / util.ts keep the Dutch labels as keys)
  "Te proberen": "To try",
  "Geïnstalleerd": "Installed",
  "Bevalt": "Keep",
  "Archief": "Archive",
  "Gearchiveerd": "Archived",
  "Actief": "Active",
  "Stil": "Quiet",
  "Verouderd": "Stale",

  // ---- generated notes (render.ts / readme.ts / sync.ts)
  "Notities": "Notes",
  "AI-oordeel": "AI verdict",
  "Is dit de moeite?": "Is it worth trying?",
  "Verwante repos": "Related repos",
  "Bestanden ({0})": "Files ({0})",
  "gekloond": "cloned",
  "Niet meer in Repo Notebook": "No longer in Repo Notebook",
  "Deze repo is uit de app verwijderd; de note blijft staan voor je eigen notities.": "This repo was removed from the app; the note stays for your own notes.",
  "Notitie in de Repo Notebook-app verschilt van je vault-notitie": "The note in the Repo Notebook app differs from your vault note",
  "woorden: {0}": "words: {0}",
  "zelfde categorie": "same category",
  "zelfde maker": "same owner",
  "zelfde taal": "same language",
  "verborgen link": "hidden link",
  "README ingekort — volledige versie: {0}": "README truncated — full version: {0}",
  "**{0}** repos · **{1}** gekloond": "**{0}** repos · **{1}** cloned",
  "**{0}** links ({1} verborgen)": "**{0}** links ({1} hidden)",
  "nog geen statussen": "no statuses yet",
  "Gesynct {0} · app {1}": "Synced {0} · app {1}",
  "{0} verwijderde notes bewaard": "{0} removed notes kept",
  "Clusters (kennisgraaf)": "Clusters (knowledge graph)",
  "Per status": "By status",
  // Bases file (Repos.base) column + view names
  "Taal": "Language",
  "Categorie": "Category",
  "Gezondheid": "Health",
  "Laatste push": "Last push",
  "Gekloond": "Cloned",
  "Omschrijving": "Description",
  "Alle repos": "All repos",
  "Per cluster": "By cluster",
  "Kaarten": "Cards",

  // ---- core errors (store.ts / github.ts throw the Dutch text; the UI localizes it)
  "notebook.json niet gevonden in {0}": "notebook.json not found in {0}",
  "notebook.json is onleesbaar en er is geen bruikbare backup ({0})": "notebook.json is unreadable and there is no usable backup ({0})",
  "Ongeldige status: {0}": "Invalid status: {0}",
  "GitHub kent {0} niet (404).": "GitHub does not know {0} (404).",
  "GitHub rate limit bereikt — zet GITHUB_TOKEN of wacht even.": "GitHub rate limit reached — set GITHUB_TOKEN or wait a moment.",
  "GitHub gaf {0}: {1}": "GitHub returned {0}: {1}",

  // ---- commands (main.ts)
  "Open het zijpaneel (plank)": "Open the side panel (shelf)",
  "Synchroniseer alle repos naar de vault": "Sync all repos to the vault",
  "Repo toevoegen (URL of tekst met links)": "Add repo (URL or text with links)",
  "Repo toevoegen vanaf klembord": "Add repo from clipboard",
  "Open de Repo Notebook-app": "Open the Repo Notebook app",
  "Start de Repo Notebook-app": "Start the Repo Notebook app",
  "Open de indexnote": "Open the index note",
  "Huidige repo: open op GitHub": "Current repo: open on GitHub",
  "Huidige repo: ververs van GitHub": "Current repo: refresh from GitHub",
  "Huidige repo: kloon": "Current repo: clone",
  "Huidige repo: installeer": "Current repo: install",
  "Huidige repo: start": "Current repo: start",
  "Huidige repo: stop": "Current repo: stop",
  "Huidige repo: toon log": "Current repo: show log",
  "Huidige repo: git pull": "Current repo: git pull",
  "Huidige repo: open lokale map": "Current repo: open local folder",
  "Huidige repo: stuur status/categorie/notities naar de app": "Current repo: send status/category/notes to the app",
  "Huidige repo: hersynchroniseer deze note": "Current repo: resync this note",
  "Huidige repo: verwijder uit Repo Notebook": "Current repo: remove from Repo Notebook",

  // ---- notices (main.ts)
  "geen data gevonden": "no data found",
  "{0} nieuw": "{0} new",
  "{0} bijgewerkt": "{0} updated",
  "{0} ongewijzigd": "{0} unchanged",
  "{0} uitgesteld (in bewerking)": "{0} deferred (being edited)",
  "{0} overgeslagen (markers weg)": "{0} skipped (markers missing)",
  "{0} notitie-conflict": "{0} note conflict",
  "{0} als verwijderd gemarkeerd": "{0} marked as removed",
  "Repo Notebook sync mislukt: {0}": "Repo Notebook sync failed: {0}",
  "✓ notebook.json gevonden in {0}": "✓ notebook.json found in {0}",
  "✗ geen notebook.json in {0}": "✗ no notebook.json in {0}",
  "✓ app online op {0}": "✓ app online at {0}",
  "○ app offline (lezen werkt, acties niet)": "○ app offline (reading works, actions don't)",
  "Repo Notebook draait al.": "Repo Notebook is already running.",
  "Repo Notebook starten…": "Starting Repo Notebook…",
  "Repo Notebook online op {0}": "Repo Notebook online at {0}",
  "Starten mislukt: {0}": "Start failed: {0}",
  "Note voor {0} kon niet gemaakt worden.": "Could not create the note for {0}.",
  "{0} toevoegen…": "Adding {0}…",
  "toegevoegd: {0}": "added: {0}",
  "stond er al (bijgewerkt): {0}": "already there (updated): {0}",
  "mislukt: {0}": "failed: {0}",
  "niets gedaan": "nothing done",
  "status gewist": "status cleared",
  "Status zetten mislukt: {0}": "Setting status failed: {0}",
  "Verwijderen uit Repo Notebook": "Remove from Repo Notebook",
  "{0} verdwijnt uit de app. De note in je vault blijft staan (gemarkeerd als verwijderd).": "{0} will be removed from the app. The note in your vault stays (marked as removed).",
  "Verwijder": "Remove",
  "verversen": "refreshing",
  "klonen": "cloning",
  "installeren": "installing",
  "starten": "starting",
  "stoppen": "stopping",
  "log ophalen": "fetching the log",
  "map openen": "opening the folder",
  "verwijderen": "removing",
  "{0} verwijderd uit Repo Notebook.": "{0} removed from Repo Notebook.",
  "{0}: verwijderen mislukt — {1}": "{0}: removing failed — {1}",
  "Voor {0} moet de Repo Notebook-app draaien. Start ze met het commando '{1}'.": "The Repo Notebook app must be running for {0}. Start it with the command '{1}'.",
  "Stond al lokaal: {0}": "Already local: {0}",
  "Gekloond naar {0}": "Cloned to {0}",
  "{0}: installatie gestart — volg de log in de app of via 'toon log'.": "{0}: install started — follow the log in the app or via 'show log'.",
  "draait al": "already running",
  "gestart": "started",
  "{0}: gestopt.": "{0}: stopped.",
  "pull klaar": "pull done",
  "{0}: {1} mislukt — {2}": "{0}: {1} failed — {2}",
  "{0}: status \"{1}\" kent de app niet — gebruik todo, installed, keep, archive of leeg.": "{0}: the app does not know status \"{1}\" — use todo, installed, keep, archive or leave it empty.",
  "{0}: note en app zijn al gelijk.": "{0}: note and app are already in sync.",
  "categorie": "category",
  "notities": "notes",
  "{0}: terugschrijven mislukt — {1}": "{0}: writing back failed — {1}",
  "Repo Notebook-app online": "Repo Notebook app online",
  "Repo Notebook-app offline": "Repo Notebook app offline",

  // ---- server.ts / vault-adapter.ts errors
  "Repo Notebook draait niet. Start de app (commando: '{0}').": "Repo Notebook is not running. Start the app (command: '{0}').",
  "Geen pad naar Repo Notebook.exe ingesteld (instellingen).": "No path to Repo Notebook.exe set (settings).",
  "Repo Notebook.exe niet gevonden: {0}": "Repo Notebook.exe not found: {0}",
  "De app is gestart maar de server antwoordt (nog) niet.": "The app was started but its server is not responding (yet).",
  "Bestaat niet: {0}": "Does not exist: {0}",

  // ---- side panel (view.ts)
  "Synchroniseer notebook.json naar de vault": "Sync notebook.json to the vault",
  "Repo toevoegen": "Add repo",
  "Zoek repo, taal, topic, categorie…": "Search repo, language, topic, category…",
  "Alle": "All",
  "Draait": "Running",
  "App online ({0})": "App online ({0})",
  "App offline — acties zoals klonen/starten hebben de app nodig": "App offline — actions like clone/start need the app",
  "Nog geen repos geladen.": "No repos loaded yet.",
  "Synchroniseer": "Sync",
  "Geen repo past bij dit filter.": "No repo matches this filter.",
  "Acties": "Actions",
  "{0} gekloond": "{0} cloned",
  "{0} draait": "{0} running",
  "Open op GitHub": "Open on GitHub",
  "Open in Repo Notebook-app": "Open in Repo Notebook app",
  "Ververs van GitHub": "Refresh from GitHub",
  "Kloon": "Clone",
  "Installeer": "Install",
  "Toon log": "Show log",
  "Open lokale map": "Open local folder",
  "Verwijder uit Repo Notebook": "Remove from Repo Notebook",

  // ---- modals (modals.ts)
  "Repo toevoegen aan Repo Notebook": "Add repo to Repo Notebook",
  "Plak een GitHub-URL of owner/naam. Je mag ook een lap tekst plakken (bv. een post met meerdere links): elke github.com/owner/repo erin wordt bewaard.":
    "Paste a GitHub URL or owner/name. You can also paste a block of text (e.g. a post with several links): every github.com/owner/repo in it is saved.",
  "Nog geen geldige repo gevonden.": "No valid repo found yet.",
  "Annuleren": "Cancel",
  "Toevoegen": "Add",
  "(leeg)": "(empty)",
  "Ververs": "Refresh",
  "Sluiten": "Close",

  // ---- settings (settings.ts)
  "Taal van het zijpaneel, de meldingen en de gegenereerde notes. Commandonamen wisselen pas na het herladen van Obsidian; notes worden bij de volgende sync in de nieuwe taal herschreven (je eigen notities blijven staan).":
    "Language of the side panel, notices and generated notes. Command names switch only after reloading Obsidian; notes are rewritten in the new language on the next sync (your own notes are kept).",
  "Automatisch (volgt Obsidian)": "Automatic (follow Obsidian)",
  "Verbinding": "Connection",
  "Datamap van Repo Notebook": "Repo Notebook data folder",
  "Map met notebook.json. Leeg = standaard ({0}).": "Folder containing notebook.json. Empty = default ({0}).",
  "Server-URL (fallback)": "Server URL (fallback)",
  "Wordt gebruikt als de app geen server.json schrijft (bv. npm run dev). De desktop-app wordt automatisch gevonden.":
    "Used when the app does not write server.json (e.g. npm run dev). The desktop app is found automatically.",
  "Pad naar de desktop-app": "Path to the desktop app",
  "Volledig pad naar Repo Notebook.exe — voor het commando 'Start de Repo Notebook-app'. Leeg laten mag; dan start je de app zelf.":
    "Full path to Repo Notebook.exe — for the command 'Start the Repo Notebook app'. May be left empty; then you start the app yourself.",
  "GitHub-token (optioneel)": "GitHub token (optional)",
  "Alleen voor 'Repo toevoegen' terwijl de app uit staat: zonder token geeft GitHub 60 aanvragen per uur. Wordt in de plugin-instellingen (data.json) bewaard.":
    "Only for 'Add repo' while the app is not running: without a token GitHub allows 60 requests per hour. Stored in the plugin settings (data.json).",
  "Map in de vault": "Folder in the vault",
  "Hier komen de repo-notes (één submap per eigenaar) plus de indexnote en de Bases-tabel.":
    "Holds the repo notes (one subfolder per owner) plus the index note and the Bases table.",
  "README opnemen": "Include README",
  "Zet de README van elke repo onderaan de note (doorzoekbaar in Obsidian).": "Puts each repo's README at the bottom of its note (searchable in Obsidian).",
  "Maximale README-lengte": "Maximum README length",
  "Tekens; langere README's worden ingekort met een link naar GitHub. 0 = onbeperkt.": "Characters; longer READMEs are truncated with a link to GitHub. 0 = unlimited.",
  "Verwante repos (kennisgraaf-links)": "Related repos (knowledge-graph links)",
  "Schrijft wikilinks naar verwante repos — dezelfde engine als de kaart in de app. Zo toont de Obsidian-graph je repo-kaart.":
    "Writes wikilinks to related repos — the same engine as the map in the app, so Obsidian's graph shows your repo map.",
  "Max. verwante repos per note": "Max. related repos per note",
  "Bestandenlijst opnemen": "Include file list",
  "Ingeklapte lijst met de bovenste bestanden/mappen van de repo.": "Collapsed list of the repo's top-level files and folders.",
  "AI-oordeel opnemen": "Include AI verdict",
  "Het 'is dit de moeite?'-oordeel uit de app, als het er is.": "The app's 'is it worth trying?' verdict, when there is one.",
  "Indexnote schrijven": "Write index note",
  "Hub-note met alle repos per cluster, status en A–Z.": "Hub note listing every repo by cluster, status and A–Z.",
  "Bases-tabel schrijven": "Write Bases table",
  "Repos.base: een sorteerbare tabel over alle repo-notes (Obsidian 1.9+).": "Repos.base: a sortable table over all repo notes (Obsidian 1.9+).",
  "Synchronisatie": "Sync",
  "Synchroniseer bij opstarten": "Sync on startup",
  "Volg notebook.json": "Watch notebook.json",
  "Synchroniseert automatisch zodra de app (of de MCP-server) iets wijzigt.": "Syncs automatically as soon as the app (or the MCP server) changes something.",
  "Wijzigingen terugschrijven naar de app": "Write changes back to the app",
  "Status, categorie en je notities uit de note gaan terug naar Repo Notebook zodra je ze bewerkt.":
    "Status, category and your notes from the note go back to Repo Notebook as soon as you edit them.",
  "Open de note na toevoegen": "Open the note after adding",
  "Nu synchroniseren": "Sync now",
  "Alle repos uit notebook.json naar de vault schrijven.": "Write every repo from notebook.json to the vault."
};

const fill = (template: string, values: ReadonlyArray<string | number>): string =>
  template.replace(/\{(\d+)\}/g, (token, index) => (values[Number(index)] !== undefined ? String(values[Number(index)]) : token));

/**
 * Translate a Dutch source message. Unknown messages are returned as-is (with
 * placeholders filled), so a missing entry degrades to Dutch, never to blank.
 */
export const translate = (message: string, values: ReadonlyArray<string | number> = [], lang: Lang = "en"): string => {
  const template = lang === "en" && Object.prototype.hasOwnProperty.call(messages, message) ? messages[message] : message;
  return fill(template, values);
};

/** Placeholder indexes used in a message, sorted (for consistency checks). */
export const placeholders = (text: string): number[] => [...text.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1])).sort((a, b) => a - b);

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Templates with placeholders, most literal text first so the most specific
// template wins when several could match.
const patterns = Object.keys(messages)
  .filter((nl) => /\{\d+\}/.test(nl))
  .sort((a, b) => b.replace(/\{\d+\}/g, "").length - a.replace(/\{\d+\}/g, "").length)
  .map((nl) => ({
    nl,
    slots: [...nl.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1])),
    regex: new RegExp(`^${nl.split(/\{\d+\}/).map(escapeRegex).join("([\\s\\S]*?)")}$`)
  }));

/**
 * Translate an already-interpolated Dutch message (e.g. an Error thrown by a
 * core module). Only complete known messages match; free text is returned
 * unchanged.
 */
export const localize = (message: string, lang: Lang = "en"): string => {
  const text = String(message ?? "");
  if (lang === "nl") return text;
  if (Object.prototype.hasOwnProperty.call(messages, text)) return messages[text];
  for (const pattern of patterns) {
    const match = pattern.regex.exec(text);
    if (!match) continue;
    const values: string[] = [];
    pattern.slots.forEach((slot, i) => {
      values[slot] = match[i + 1];
    });
    return fill(messages[pattern.nl], values);
  }
  return text;
};
