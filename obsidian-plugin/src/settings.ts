import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type RepoNotebookPlugin from "./main";
import { defaultDataDir } from "./core/store";

export interface RepoNotebookSettings {
  /** Folder in the vault that holds the repo notes. */
  folder: string;
  /** Repo Notebook data dir (notebook.json lives here). Empty = app default. */
  dataDir: string;
  /** Fallback server URL when no server.json is found (npm run dev port). */
  serverUrl: string;
  /** Path to the packaged desktop app, for "Start Repo Notebook". */
  appExePath: string;
  /** Optional GitHub token for "add repo" while the app is offline (rate limit). */
  githubToken: string;
  includeReadme: boolean;
  readmeMaxChars: number;
  includeRelated: boolean;
  maxRelated: number;
  includeFiles: boolean;
  includeVerdict: boolean;
  writeIndex: boolean;
  writeBase: boolean;
  syncOnStartup: boolean;
  watchStore: boolean;
  pushMeta: boolean;
  openNoteAfterAdd: boolean;
  /** Last known store mtime that was fully synced (ms). */
  lastSyncedMtime: number;
}

export const DEFAULT_SETTINGS: RepoNotebookSettings = {
  folder: "Repo Notebook",
  dataDir: "",
  serverUrl: "http://127.0.0.1:5188",
  appExePath: "",
  githubToken: "",
  includeReadme: true,
  readmeMaxChars: 30000,
  includeRelated: true,
  maxRelated: 6,
  includeFiles: true,
  includeVerdict: true,
  writeIndex: true,
  writeBase: true,
  syncOnStartup: true,
  watchStore: true,
  pushMeta: true,
  openNoteAfterAdd: true,
  lastSyncedMtime: 0
};

export const resolveDataDir = (settings: RepoNotebookSettings): string => settings.dataDir.trim() || defaultDataDir();

export class RepoNotebookSettingTab extends PluginSettingTab {
  plugin: RepoNotebookPlugin;

  constructor(app: App, plugin: RepoNotebookPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl).setName("Verbinding").setHeading();

    new Setting(containerEl)
      .setName("Datamap van Repo Notebook")
      .setDesc(`Map met notebook.json. Leeg = standaard (${defaultDataDir()}).`)
      .addText((text) =>
        text
          .setPlaceholder(defaultDataDir())
          .setValue(s.dataDir)
          .onChange(async (value) => {
            s.dataDir = value.trim();
            await save();
          })
      )
      .addExtraButton((btn) =>
        btn
          .setIcon("check-circle")
          .setTooltip("Test")
          .onClick(async () => {
            const report = await this.plugin.testConnection();
            new Notice(report, 8000);
          })
      );

    new Setting(containerEl)
      .setName("Server-URL (fallback)")
      .setDesc("Wordt gebruikt als de app geen server.json schrijft (bv. npm run dev). De desktop-app wordt automatisch gevonden.")
      .addText((text) =>
        text.setValue(s.serverUrl).onChange(async (value) => {
          s.serverUrl = value.trim().replace(/\/$/, "") || DEFAULT_SETTINGS.serverUrl;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Pad naar de desktop-app")
      .setDesc("Volledig pad naar Repo Notebook.exe — voor het commando 'Start de Repo Notebook-app'. Leeg laten mag; dan start je de app zelf.")
      .addText((text) =>
        text.setValue(s.appExePath).onChange(async (value) => {
          s.appExePath = value.trim();
          await save();
        })
      );

    new Setting(containerEl)
      .setName("GitHub-token (optioneel)")
      .setDesc("Alleen voor 'Repo toevoegen' terwijl de app uit staat: zonder token geeft GitHub 60 aanvragen per uur. Wordt in de plugin-instellingen (data.json) bewaard.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("ghp_…").setValue(s.githubToken).onChange(async (value) => {
          s.githubToken = value.trim();
          await save();
        });
      });

    new Setting(containerEl).setName("Notes").setHeading();

    new Setting(containerEl)
      .setName("Map in de vault")
      .setDesc("Hier komen de repo-notes (één submap per eigenaar) plus de indexnote en de Bases-tabel.")
      .addText((text) =>
        text.setValue(s.folder).onChange(async (value) => {
          const clean = value.trim().replace(/^\/+|\/+$/g, "");
          if (clean) {
            s.folder = clean;
            await save();
          }
        })
      );

    new Setting(containerEl)
      .setName("README opnemen")
      .setDesc("Zet de README van elke repo onderaan de note (doorzoekbaar in Obsidian).")
      .addToggle((t) =>
        t.setValue(s.includeReadme).onChange(async (v) => {
          s.includeReadme = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Maximale README-lengte")
      .setDesc("Tekens; langere README's worden ingekort met een link naar GitHub. 0 = onbeperkt.")
      .addText((text) =>
        text.setValue(String(s.readmeMaxChars)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) {
            s.readmeMaxChars = Math.floor(n);
            await save();
          }
        })
      );

    new Setting(containerEl)
      .setName("Verwante repos (kennisgraaf-links)")
      .setDesc("Schrijft wikilinks naar verwante repos — dezelfde engine als de kaart in de app. Zo toont de Obsidian-graph je repo-kaart.")
      .addToggle((t) =>
        t.setValue(s.includeRelated).onChange(async (v) => {
          s.includeRelated = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Max. verwante repos per note")
      .addSlider((sl) =>
        sl
          .setLimits(1, 12, 1)
          .setValue(s.maxRelated)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.maxRelated = v;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Bestandenlijst opnemen")
      .setDesc("Ingeklapte lijst met de bovenste bestanden/mappen van de repo.")
      .addToggle((t) =>
        t.setValue(s.includeFiles).onChange(async (v) => {
          s.includeFiles = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("AI-oordeel opnemen")
      .setDesc("Het 'is dit de moeite?'-oordeel uit de app, als het er is.")
      .addToggle((t) =>
        t.setValue(s.includeVerdict).onChange(async (v) => {
          s.includeVerdict = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Indexnote schrijven")
      .setDesc("Hub-note met alle repos per cluster, status en A–Z.")
      .addToggle((t) =>
        t.setValue(s.writeIndex).onChange(async (v) => {
          s.writeIndex = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Bases-tabel schrijven")
      .setDesc("Repos.base: een sorteerbare tabel over alle repo-notes (Obsidian 1.9+).")
      .addToggle((t) =>
        t.setValue(s.writeBase).onChange(async (v) => {
          s.writeBase = v;
          await save();
        })
      );

    new Setting(containerEl).setName("Synchronisatie").setHeading();

    new Setting(containerEl)
      .setName("Synchroniseer bij opstarten")
      .addToggle((t) =>
        t.setValue(s.syncOnStartup).onChange(async (v) => {
          s.syncOnStartup = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Volg notebook.json")
      .setDesc("Synchroniseert automatisch zodra de app (of de MCP-server) iets wijzigt.")
      .addToggle((t) =>
        t.setValue(s.watchStore).onChange(async (v) => {
          s.watchStore = v;
          await save();
          this.plugin.restartWatcher();
        })
      );

    new Setting(containerEl)
      .setName("Wijzigingen terugschrijven naar de app")
      .setDesc("Status, categorie en je notities uit de note gaan terug naar Repo Notebook zodra je ze bewerkt.")
      .addToggle((t) =>
        t.setValue(s.pushMeta).onChange(async (v) => {
          s.pushMeta = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Open de note na toevoegen")
      .addToggle((t) =>
        t.setValue(s.openNoteAfterAdd).onChange(async (v) => {
          s.openNoteAfterAdd = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Nu synchroniseren")
      .setDesc("Alle repos uit notebook.json naar de vault schrijven.")
      .addButton((b) =>
        b.setButtonText("Synchroniseer").setCta().onClick(() => this.plugin.syncAll({ reason: "settings" }))
      );
  }
}
