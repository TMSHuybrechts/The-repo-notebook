// UI language for the Obsidian side. Core modules stay global-free and take
// the language through their options; this module holds the one active
// language for views, notices, modals and settings.

import { localize, normalizeLang, translate, type Lang, type LanguageSetting } from "./core/i18n";

let current: Lang = "en";

/** Obsidian's own UI language: it stores e.g. "nl" under localStorage "language"; absent = English. */
export const obsidianLanguage = (): Lang => {
  try {
    const storage = (globalThis as { localStorage?: { getItem(key: string): string | null } }).localStorage;
    return normalizeLang(storage?.getItem("language") ?? "en");
  } catch {
    return "en";
  }
};

export const resolveLanguage = (setting: LanguageSetting | string | undefined): Lang =>
  setting === "en" || setting === "nl" ? setting : obsidianLanguage();

export const setLanguage = (lang: Lang): void => {
  current = lang;
};

export const getLanguage = (): Lang => current;

/** Translate a Dutch source message into the active language; `{0}` placeholders take `values`. */
export const t = (nl: string, values: Array<string | number> = []): string => translate(nl, values, current);

/** User-facing text of an error: known (Dutch) core messages are translated, anything else is kept. */
export const errorText = (error: unknown): string => localize(String((error as Error)?.message ?? error), current);
