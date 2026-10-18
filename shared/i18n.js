import { messages } from "./messages.js";

export const normalizeLocale = (value) => /^nl(?:-|$)/i.test(String(value || "")) ? "nl" : "en";

const entries = Object.entries(messages);
const englishToDutch = new Map(entries.map(([nl, en]) => [en, nl]));
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = entries.filter(([nl]) => /\{\d+\}/.test(nl)).flatMap(([nl, en]) =>
  [[nl, en], [en, nl]].map(([source, target]) => {
    const slots = [...source.matchAll(/\{(\d+)\}/g)].map((match) => Number(match[1]));
    return { source, target, slots, regex: new RegExp(`^${source.split(/\{\d+\}/).map(escapeRegex).join("([\\s\\S]*?)")}$`) };
  })
);

export function translate(message, values = [], locale = "en") {
  if (typeof message !== "string") return message;
  const lang = normalizeLocale(locale);
  const nl = Object.hasOwn(messages, message) ? message : englishToDutch.get(message);
  let template = nl === undefined ? message : lang === "nl" ? nl : messages[nl];
  // Messages already stored in UI state or received from the API may contain
  // interpolated values. Match complete known messages only, never free text.
  if (nl === undefined && !values.length) {
    for (const pattern of patterns) {
      const sourceIsDutch = Object.hasOwn(messages, pattern.source);
      if ((lang === "nl") === sourceIsDutch) continue;
      const match = message.match(pattern.regex);
      if (!match) continue;
      const captured = [];
      pattern.slots.forEach((slot, index) => { captured[slot] = match[index + 1]; });
      return pattern.target.replace(/\{(\d+)\}/g, (token, index) => captured[index] ?? token);
    }
  }
  return template.replace(/\{(\d+)\}/g, (token, index) => values[index] ?? token);
}
