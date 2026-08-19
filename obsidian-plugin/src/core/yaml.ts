// Minimal YAML emitter for the flat frontmatter this plugin writes: scalars,
// lists of scalars, and nothing nested deeper. Strings are quoted whenever
// they could be misread by a YAML parser, so Obsidian's property panel and
// Dataview/Bases always see the intended value.

export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlScalar[];

// Bare (unquoted) only when the value is plainly a word-ish string: starts with
// a letter and contains only letters, digits, spaces, dots, underscores,
// slashes and hyphens. Everything else — URLs, text with colons or quotes,
// numeric-looking names like "2048", reserved words — gets double-quoted.
const SAFE_BARE = /^\p{L}[\p{L}\p{N} ._/-]*$/u;
const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;

export const yamlString = (value: string): string => {
  const text = String(value);
  // Dates like 2026-08-19 are fine bare (Obsidian treats them as dates).
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(text)) return text;
  if (SAFE_BARE.test(text) && !RESERVED.test(text) && !/\s$/.test(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n").replace(/\t/g, "\\t")}"`;
};

const yamlScalar = (value: YamlScalar): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  return yamlString(value);
};

/** Render an ordered set of entries as YAML lines (no --- fences). */
export const yamlEntries = (entries: Array<[string, YamlValue]>): string[] => {
  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      if (!value.length) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlScalar(item)}`);
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  return lines;
};

/**
 * Split a raw frontmatter body (between the --- fences) into top-level
 * entries, preserving each entry's text verbatim. A top-level entry starts at
 * column 0 with `key:`; indented lines and list items belong to the entry
 * above. Used to keep user-added properties untouched while we rewrite ours.
 */
export const splitFrontmatterEntries = (raw: string): Array<{ key: string; text: string }> => {
  const out: Array<{ key: string; text: string }> = [];
  let current: { key: string; text: string } | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([^\s#][^:]*?):(\s|$)/.exec(line);
    if (m && !line.startsWith(" ") && !line.startsWith("\t") && !line.startsWith("-")) {
      if (current) out.push(current);
      current = { key: m[1].trim(), text: line };
    } else if (current) {
      current.text += `\n${line}`;
    } else if (line.trim()) {
      // Stray content before any key (rare) — keep it as an unnamed entry.
      current = { key: "", text: line };
    }
  }
  if (current) out.push(current);
  return out.map((entry) => ({ ...entry, text: entry.text.replace(/\n+$/, "") }));
};

/** Very small YAML scalar reader for values we wrote ourselves (or simple user values). */
export const readScalar = (text: string): string => {
  const t = String(text || "").trim();
  if (!t) return "";
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const inner = t.slice(1, -1);
    return t.startsWith('"')
      ? inner.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
      : inner.replace(/''/g, "'");
  }
  return t;
};

/** Get the scalar value of a top-level key from raw frontmatter text. */
export const frontmatterValue = (raw: string, key: string): string | undefined => {
  const entry = splitFrontmatterEntries(raw).find((e) => e.key === key);
  if (!entry) return undefined;
  const firstLine = entry.text.split(/\r?\n/)[0];
  return readScalar(firstLine.slice(firstLine.indexOf(":") + 1));
};

/** Split a markdown document into raw frontmatter (without fences) and body. */
export const splitFrontmatter = (content: string): { frontmatter: string | null; body: string } => {
  if (!content.startsWith("---")) return { frontmatter: null, body: content };
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!m) return { frontmatter: null, body: content };
  return { frontmatter: m[1], body: content.slice(m[0].length) };
};
