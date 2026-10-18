import { useSyncExternalStore } from "react";
import { normalizeLocale, translate } from "../shared/i18n.js";

export const LANGUAGE_STORAGE_KEY = "repo-notebook-language";
const listeners = new Set();
let locale = "en";
try {
  locale = normalizeLocale(globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY));
} catch { /* Storage may be disabled; the language switch still works. */ }

export const getLocale = () => locale;
export const t = (message, values = []) => translate(message, values, locale);

export function setLocale(value) {
  locale = normalizeLocale(value);
  try { globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, locale); } catch { /* In-memory preference only. */ }
  listeners.forEach((listener) => listener());
}

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== LANGUAGE_STORAGE_KEY) return;
    locale = normalizeLocale(event.newValue);
    listeners.forEach((listener) => listener());
  });
}

export const useLocale = () => useSyncExternalStore(subscribe, getLocale, () => "en");
