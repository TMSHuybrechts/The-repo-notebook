import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type RepoNotebookPlugin from "./main";
import { defaultDataDir } from "./core/store";
import type { LanguageSetting } from "./core/i18n";
import { t } from "./lang";

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
  /** UI + generated-note language: "auto" follows Obsidian's own language. */
  language: LanguageSetting;
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
  lastSyncedMtime: 0,
  language: "auto"
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

    new Setting(containerEl)
      .setName(t("Taal"))
      .setDesc(
        t("Taal van het zijpaneel, de meldingen en de gegenereerde notes. Commandonamen wisselen pas na het herladen van Obsidian; notes worden bij de volgende sync in de nieuwe taal herschreven (je eigen notities blijven staan).")
      )
      .addDropdown((dd) =>
        dd
          .addOption("auto", t("Automatisch (volgt Obsidian)"))
          .addOption("en", "English")
          .addOption("nl", "Nederlands")
          .setValue(s.language)
          .onChange(async (value) => {
            s.language = value === "en" || value === "nl" ? value : "auto";
            await save();
            this.plugin.applyLanguage();
            this.display();
          })
      );

    new Setting(containerEl).setName(t("Verbinding")).setHeading();

    new Setting(containerEl)
      .setName(t("Datamap van Repo Notebook"))
      .setDesc(t("Map met notebook.json. Leeg = standaard ({0}).", [defaultDataDir()]))
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
      .setName(t("Server-URL (fallback)"))
      .setDesc(t("Wordt gebruikt als de app geen server.json schrijft (bv. npm run dev). De desktop-app wordt automatisch gevonden."))
      .addText((text) =>
        text.setValue(s.serverUrl).onChange(async (value) => {
          s.serverUrl = value.trim().replace(/\/$/, "") || DEFAULT_SETTINGS.serverUrl;
          await save();
        })
      );

    new Setting(containerEl)
      .setName(t("Pad naar de desktop-app"))
      .setDesc(t("Volledig pad naar Repo Notebook.exe — voor het commando 'Start de Repo Notebook-app'. Leeg laten mag; dan start je de app zelf."))
      .addText((text) =>
        text.setValue(s.appExePath).onChange(async (value) => {
          s.appExePath = value.trim();
          await save();
        })
      );

    new Setting(containerEl)
      .setName(t("GitHub-token (optioneel)"))
      .setDesc(t("Alleen voor 'Repo toevoegen' terwijl de app uit staat: zonder token geeft GitHub 60 aanvragen per uur. Wordt in de plugin-instellingen (data.json) bewaard."))
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("ghp_…").setValue(s.githubToken).onChange(async (value) => {
          s.githubToken = value.trim();
          await save();
        });
      });

    new Setting(containerEl).setName("Notes").setHeading();

    new Setting(containerEl)
      .setName(t("Map in de vault"))
      .setDesc(t("Hier komen de repo-notes (één submap per eigenaar) plus de indexnote en de Bases-tabel."))
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
      .setName(t("README opnemen"))
      .setDesc(t("Zet de README van elke repo onderaan de note (doorzoekbaar in Obsidian)."))
      .addToggle((t) =>
        t.setValue(s.includeReadme).onChange(async (v) => {
          s.includeReadme = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName(t("Maximale README-lengte"))
      .setDesc(t("Tekens; langere README's worden ingekort met een link naar GitHub. 0 = onbeperkt."))
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
      .setName(t("Verwante repos (kennisgraaf-links)"))
      .setDesc(t("Schrijft wikilinks naar verwante repos — dezelfde engine als de kaart in de app. Zo toont de Obsidian-graph je repo-kaart."))
      .addToggle((t) =>
        t.setValue(s.includeRelated).onChange(async (v) => {
          s.includeRelated = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName(t("Max. verwante repos per note"))
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
      .setName(t("Bestandenlijst opnemen"))
      .setDesc(t("Ingeklapte lijst met de bovenste bestanden/mappen van de repo."))
      .addToggle((t) =>
        t.setValue(s.includeFiles).onChange(async (v) => {
          s.includeFiles = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName(t("AI-oordeel opnemen"))
      .setDesc(t("Het 'is dit de moeite?'-oordeel uit de app, als het er is."))
      .addToggle((t) =>
        t.setValue(s.includeVerdict).onChange(async (v) => {
          s.includeVerdict = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName(t("Indexnote schrijven"))
      .setDesc(t("Hub-note met alle repos per cluster, status en A–Z."))
      .addToggle((t) =>
        t.setValue(s.writeIndex).onChange(async (v) => {
          s.writeIndex = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName(t("Bases-tabel schrijven"))
      .setDesc(t("Repos.base: een sorteerbare tabel over alle repo-notes (Obsidian 1.9+)."))
      .addToggle((t) =>
        t.setValue(s.writeBase).onChange(async (v) => {
          s.writeBase = v;
          await save();
        })
      );

    new Setting(containerEl).setName(t("Synchronisatie")).setHeading();

    new Setting(containerEl)
      .setName(t("Synchroniseer bij opstarten"))
      .addToggle((t) =>
        t.setValue(s.syncOnStartup).onChange(async (v) => {
          s.syncOnStartup = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName(t("Volg notebook.json"))
      .setDesc(t("Synchroniseert automatisch zodra de app (of de MCP-server) iets wijzigt."))
      .addToggle((t) =>
        t.setValue(s.watchStore).onChange(async (v) => {
          s.watchStore = v;
          await save();
          this.plugin.restartWatcher();
        })
      );

    new Setting(containerEl)
      .setName(t("Wijzigingen terugschrijven naar de app"))
      .setDesc(t("Status, categorie en je notities uit de note gaan terug naar Repo Notebook zodra je ze bewerkt."))
      .addToggle((t) =>
        t.setValue(s.pushMeta).onChange(async (v) => {
          s.pushMeta = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName(t("Open de note na toevoegen"))
      .addToggle((t) =>
        t.setValue(s.openNoteAfterAdd).onChange(async (v) => {
          s.openNoteAfterAdd = v;
          await save();
        })
      );

    new Setting(containerEl)
      .setName(t("Nu synchroniseren"))
      .setDesc(t("Alle repos uit notebook.json naar de vault schrijven."))
      .addButton((b) =>
        b.setButtonText(t("Synchroniseer")).setCta().onClick(() => this.plugin.syncAll({ reason: "settings" }))
      );
  }
}
