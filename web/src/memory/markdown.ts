/**
 * Issue #37 (M04): bounded, dependency-free Markdown preview. The parser
 * never produces raw HTML and the renderer builds React elements only, so a
 * note cannot execute scripts, load remote images/iframes or leak content
 * through an automatic request. Unsafe links and images stay visible as
 * inert text.
 */

export type MarkdownInline =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "strong"; children: MarkdownInline[] }
  | { type: "em"; children: MarkdownInline[] }
  | { type: "link"; href: string; children: MarkdownInline[] }
  | { type: "blocked"; reason: "url" | "image"; children: MarkdownInline[] };

export interface MarkdownListItem {
  children: MarkdownInline[];
  task: boolean;
  checked: boolean;
}

export type MarkdownBlock =
  | { type: "heading"; level: number; children: MarkdownInline[] }
  | { type: "paragraph"; children: MarkdownInline[] }
  | {
      type: "list";
      ordered: boolean;
      start: number;
      items: MarkdownListItem[];
    }
  | { type: "quote"; children: MarkdownInline[] }
  | { type: "code"; language: string; value: string }
  | { type: "hr" };

export interface MarkdownParseResult {
  blocks: MarkdownBlock[];
  truncated: boolean;
}

export const MARKDOWN_LIMITS = {
  maxChars: 120_000,
  maxLines: 5_000,
  maxBlocks: 2_000,
  maxCodeLines: 500,
} as const;

const SCHEME_ALLOWLIST = new Set(["http:", "https:", "mailto:"]);

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Normalized absolute URL, or null for anything not explicitly allowed. */
export function safeMarkdownUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || hasControlChars(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!SCHEME_ALLOWLIST.has(parsed.protocol)) return null;
  return parsed.href;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^(```+|~~~+)\s*([A-Za-z0-9_+#.-]{0,20})\s*$/;
const HR = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

function inlineText(nodes: MarkdownInline[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text" || node.type === "code") return node.value;
      if (node.type === "blocked") return inlineText(node.children);
      return inlineText(node.children);
    })
    .join("");
}

function findClosing(text: string, marker: string, from: number): number {
  const index = text.indexOf(marker, from + marker.length);
  return index;
}

function parseInline(source: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let buffer = "";
  let i = 0;
  const flush = () => {
    if (buffer) nodes.push({ type: "text", value: buffer });
    buffer = "";
  };
  while (i < source.length) {
    const char = source[i]!;
    // Inline code spans win over emphasis.
    if (char === "`") {
      const end = findClosing(source, "`", i);
      if (end !== -1) {
        flush();
        nodes.push({ type: "code", value: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Images: never rendered; the alt text stays visible.
    if (char === "!" && source[i + 1] === "[") {
      const label = matchBracket(source, i + 2);
      if (label && source[label.end + 1] === "(") {
        const target = matchParen(source, label.end + 2);
        if (target) {
          flush();
          nodes.push({
            type: "blocked",
            reason: "image",
            children: parseInline(label.content),
          });
          i = target.end + 1;
          continue;
        }
      }
    }
    if (char === "[") {
      const label = matchBracket(source, i + 1);
      if (label && source[label.end + 1] === "(") {
        const target = matchParen(source, label.end + 2);
        if (target) {
          const href = safeMarkdownUrl(stripTitle(target.content));
          flush();
          if (href)
            nodes.push({
              type: "link",
              href,
              children: parseInline(label.content),
            });
          else
            nodes.push({
              type: "blocked",
              reason: "url",
              children: parseInline(label.content),
            });
          i = target.end + 1;
          continue;
        }
      }
    }
    if (
      (char === "*" || char === "_") &&
      source[i + 1] === char &&
      source[i + 2] &&
      source[i + 2] !== char
    ) {
      const end = findClosing(source, char + char, i);
      if (end !== -1 && end > i + 2) {
        flush();
        nodes.push({
          type: "strong",
          children: parseInline(source.slice(i + 2, end)),
        });
        i = end + 2;
        continue;
      }
    }
    if (char === "*" || char === "_") {
      const end = findClosing(source, char, i);
      if (end !== -1 && end > i + 1 && source[i + 1] !== " ") {
        flush();
        nodes.push({
          type: "em",
          children: parseInline(source.slice(i + 1, end)),
        });
        i = end + 1;
        continue;
      }
    }
    buffer += char;
    i += 1;
  }
  flush();
  return nodes;
}

/** `[label]` support with nesting; returns the closing bracket position. */
function matchBracket(
  source: string,
  start: number,
): { content: string; end: number } | null {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i]!;
    if (char === "[") depth += 1;
    else if (char === "]") {
      if (depth === 0) return { content: source.slice(start, i), end: i };
      depth -= 1;
    }
  }
  return null;
}

/** `(target)` support with one level of nesting (e.g. parentheses in URLs). */
function matchParen(
  source: string,
  start: number,
): { content: string; end: number } | null {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i]!;
    if (char === "(") depth += 1;
    else if (char === ")") {
      if (depth === 0) return { content: source.slice(start, i), end: i };
      depth -= 1;
    }
  }
  return null;
}

function stripTitle(target: string): string {
  const value = target.trim();
  const quoted = /^(\S+)\s+["'(].*$/.exec(value);
  return quoted ? quoted[1]! : value;
}

function isBlockStart(line: string): boolean {
  return (
    HEADING.test(line) ||
    FENCE.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line)
  );
}

/** Bounded block parser. Every input becomes text, code or inert content. */
export function parseMarkdown(source: string): MarkdownParseResult {
  let truncated = source.length > MARKDOWN_LIMITS.maxChars;
  let text = truncated ? source.slice(0, MARKDOWN_LIMITS.maxChars) : source;
  let lines = text.split(/\r?\n/);
  if (lines.length > MARKDOWN_LIMITS.maxLines) {
    truncated = true;
    lines = lines.slice(0, MARKDOWN_LIMITS.maxLines);
  }
  const blocks: MarkdownBlock[] = [];
  let i = 0;
  const push = (block: MarkdownBlock) => {
    if (blocks.length >= MARKDOWN_LIMITS.maxBlocks) {
      truncated = true;
      return false;
    }
    blocks.push(block);
    return true;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const value: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.startsWith(marker.slice(0, 3))) {
        if (value.length < MARKDOWN_LIMITS.maxCodeLines) value.push(lines[i]!);
        else truncated = true;
        i += 1;
      }
      if (i < lines.length) i += 1;
      if (
        !push({
          type: "code",
          language: fence[2] ?? "",
          value: value.join("\n"),
        })
      )
        break;
      continue;
    }
    if (HR.test(line)) {
      if (!push({ type: "hr" })) break;
      i += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      if (
        !push({
          type: "heading",
          level: heading[1]!.length,
          children: parseInline(heading[2]!),
        })
      )
        break;
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const parts: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        parts.push(QUOTE.exec(lines[i]!)![1]!);
        i += 1;
      }
      if (!push({ type: "quote", children: parseInline(parts.join("\n")) }))
        break;
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      const orderedList = Boolean(ordered);
      const start = ordered ? Number(ordered[1]) : 1;
      const items: MarkdownListItem[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const item = orderedList ? ORDERED.exec(current) : BULLET.exec(current);
        if (!item) break;
        const content = orderedList ? item[2]! : item[1]!;
        const task = TASK.exec(content);
        items.push({
          children: parseInline(task ? task[2]! : content),
          task: Boolean(task),
          checked: task ? task[1]!.toLowerCase() === "x" : false,
        });
        i += 1;
        // Continuation lines (indented) belong to the same item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!)) {
          const continuation = lines[i]!.trim();
          const last = items[items.length - 1]!;
          last.children = [
            ...last.children,
            { type: "text", value: ` ${continuation}` },
          ];
          i += 1;
        }
      }
      if (!push({ type: "list", ordered: orderedList, start, items })) break;
      continue;
    }
    const parts = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!)) {
      parts.push(lines[i]!.trim());
      i += 1;
    }
    if (!push({ type: "paragraph", children: parseInline(parts.join(" ")) }))
      break;
  }
  return { blocks, truncated };
}

/** Flatten a node to plain text (used for aria labels and tests). */
export function inlineToText(nodes: MarkdownInline[]): string {
  return inlineText(nodes);
}
