import { App, Modal, Setting, TextAreaComponent } from "obsidian";
import { extractRepoRefs, parseRepoRef } from "./core/util";

/** Paste one URL / owner/name, or a whole text with many github.com links. */
export class AddRepoModal extends Modal {
  private value = "";

  constructor(
    app: App,
    private readonly initial: string,
    private readonly onSubmit: (refs: string[]) => Promise<void>
  ) {
    super(app);
    this.value = initial;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("rn-modal");
    contentEl.createEl("h3", { text: "Repo toevoegen aan Repo Notebook" });
    contentEl.createEl("p", {
      cls: "rn-muted",
      text: "Plak een GitHub-URL of owner/naam. Je mag ook een lap tekst plakken (bv. een post met meerdere links): elke github.com/owner/repo erin wordt bewaard."
    });
    let area: TextAreaComponent | null = null;
    new Setting(contentEl).addTextArea((ta) => {
      area = ta;
      ta.inputEl.rows = 5;
      ta.inputEl.addClass("rn-textarea");
      ta.setPlaceholder("https://github.com/owner/repo").setValue(this.value).onChange((v) => (this.value = v));
      ta.inputEl.addEventListener("keydown", (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
          ev.preventDefault();
          void this.submit();
        }
      });
    });
    const hint = contentEl.createEl("p", { cls: "rn-muted rn-hint" });
    const refresh = () => {
      const refs = this.parse();
      hint.setText(refs.length ? `${refs.length} repo(s): ${refs.slice(0, 6).join(", ")}${refs.length > 6 ? " …" : ""}` : "Nog geen geldige repo gevonden.");
    };
    refresh();
    area!.inputEl.addEventListener("input", refresh);
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Annuleren").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Toevoegen")
          .setCta()
          .onClick(() => void this.submit())
      );
    window.setTimeout(() => area?.inputEl.focus(), 30);
  }

  private parse(): string[] {
    const text = this.value.trim();
    if (!text) return [];
    const single = parseRepoRef(text);
    if (single && !/\s/.test(text)) return [`${single.owner}/${single.name}`];
    return extractRepoRefs(text);
  }

  private async submit(): Promise<void> {
    const refs = this.parse();
    if (!refs.length) return;
    this.close();
    await this.onSubmit(refs);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Read-only text viewer (runtime logs, raw verdicts). */
export class TextModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly text: string,
    private readonly onRefresh?: () => Promise<string>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("rn-modal");
    contentEl.createEl("h3", { text: this.title });
    const pre = contentEl.createEl("pre", { cls: "rn-log" });
    pre.setText(this.text || "(leeg)");
    pre.scrollTop = pre.scrollHeight;
    const row = new Setting(contentEl);
    if (this.onRefresh) {
      row.addButton((b) =>
        b.setButtonText("Ververs").onClick(async () => {
          pre.setText((await this.onRefresh!()) || "(leeg)");
          pre.scrollTop = pre.scrollHeight;
        })
      );
    }
    row.addButton((b) => b.setButtonText("Sluiten").setCta().onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly body: string,
    private readonly confirmLabel: string,
    private readonly onConfirm: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("rn-modal");
    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("p", { text: this.body });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Annuleren").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.confirmLabel)
          .setWarning()
          .onClick(async () => {
            this.close();
            await this.onConfirm();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
