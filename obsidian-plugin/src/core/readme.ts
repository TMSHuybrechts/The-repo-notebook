// Turns a raw GitHub README into markdown that behaves inside an Obsidian
// note: headings nest under the note's own "## README" heading, relative
// links/images point at GitHub, and stray `#word` / `[[x]]` fragments don't
// become accidental Obsidian tags or wikilinks.

export interface ReadmeOptions {
  owner: string;
  name: string;
  branch: string;
  maxChars: number;
  /** How many levels to push headings down (2 → `#` becomes `###`). */
  headingShift?: number;
}

// A fence opener; returns its marker ("```" / "~~~~") or null. A backtick
// fence can't have backticks in its info string, so ```pip install x``` is an
// inline code span, not a fence (CommonMark).
const fenceOpen = (line: string): string | null => {
  const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  if (m[1][0] === "`" && m[2].includes("`")) return null;
  return m[1];
};

const fenceClose = (line: string, open: string): boolean => {
  const m = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return Boolean(m && m[1][0] === open[0] && m[1].length >= open.length);
};

/** Apply fn to the parts of a line that are outside inline code spans. */
const outsideInlineCode = (line: string, fn: (text: string) => string): string => {
  const parts = line.split(/(`+[^`]*`+)/g);
  return parts.map((part, i) => (i % 2 === 1 ? part : fn(part))).join("");
};

const RELATIVE = (target: string): boolean =>
  !/^(https?:)?\/\//i.test(target) && !/^(mailto:|tel:|data:|#|javascript:)/i.test(target) && target.trim() !== "";

const absolutize = (target: string, base: string): string => {
  const clean = target.trim().replace(/^\.\//, "").replace(/^\//, "");
  return `${base}/${clean}`;
};

export const normalizeReadme = (readme: string, options: ReadmeOptions): string => {
  const shift = options.headingShift ?? 2;
  const blob = `https://github.com/${options.owner}/${options.name}/blob/${options.branch}`;
  const raw = `https://raw.githubusercontent.com/${options.owner}/${options.name}/${options.branch}`;

  let text = String(readme || "").replace(/\r\n/g, "\n").replace(/^﻿/, "");
  let truncated = false;
  if (options.maxChars > 0 && text.length > options.maxChars) {
    text = text.slice(0, options.maxChars);
    truncated = true;
  }

  const lines = text.split("\n");
  const out: string[] = [];
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (fence) {
      out.push(line);
      if (fenceClose(line, fence)) fence = null;
      continue;
    }
    const opened = fenceOpen(line);
    if (opened) {
      fence = opened;
      out.push(line);
      continue;
    }

    // Setext headings → ATX so they can be shifted like the rest.
    const next = lines[i + 1] ?? "";
    const prevIsText = line.trim() && !/^\s*([-*+]|\d+[.)])\s/.test(line) && !/^\s*#/.test(line) && !/^\s*>/.test(line) && !line.includes("|");
    if (prevIsText && /^\s{0,3}=+\s*$/.test(next)) {
      line = `# ${line.trim()}`;
      i++;
    } else if (prevIsText && /^\s{0,3}-{2,}\s*$/.test(next) && !/^\s{0,3}-{3,}\s*$/.test(line)) {
      line = `## ${line.trim()}`;
      i++;
    }

    // Shift ATX headings down so the README nests under "## README".
    const h = /^(\s{0,3})(#{1,6})(\s+.*|$)/.exec(line);
    if (h) {
      const level = Math.min(6, h[2].length + shift);
      line = `${"#".repeat(level)}${h[3] || ""}`;
    }

    line = outsideInlineCode(line, (part) =>
      part
        // Markdown images with a relative path → raw.githubusercontent.com
        .replace(/!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (m, alt, target, title) =>
          RELATIVE(target) ? `![${alt}](${absolutize(target, raw)}${title || ""})` : m)
        // Markdown links with a relative path → github.com/.../blob/<branch>
        .replace(/(^|[^!])\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (m, pre, label, target, title) =>
          RELATIVE(target) ? `${pre}[${label}](${absolutize(target, blob)}${title || ""})` : m)
        // HTML img/a with relative src/href
        .replace(/(<img\b[^>]*?\bsrc=)(["'])([^"']+)\2/gi, (m, pre, q, target) =>
          RELATIVE(target) ? `${pre}${q}${absolutize(target, raw)}${q}` : m)
        .replace(/(<a\b[^>]*?\bhref=)(["'])([^"']+)\2/gi, (m, pre, q, target) =>
          RELATIVE(target) ? `${pre}${q}${absolutize(target, blob)}${q}` : m)
        // `#word` after whitespace would become an Obsidian tag — escape it.
        .replace(/(^|\s)#(?=[\p{L}_])/gu, "$1\\#")
        // `[[...]]` would become a wikilink to a note that doesn't exist.
        .replace(/\[\[/g, "\\[[")
        // Obsidian comment / highlight syntax.
        .replace(/%%/g, "\\%%")
    );

    out.push(line);
  }
  if (fence) out.push(fence);

  let result = out.join("\n").trim();
  if (truncated) {
    result += `\n\n> [!note] README ingekort — volledige versie: ${blob}/README.md`;
  }
  return result;
};
