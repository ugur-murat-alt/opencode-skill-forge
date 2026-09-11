/**
 * Issue #37 (M04) phase A: a small, lossless editor view over the canonical
 * Markdown document. The frontmatter block is treated as opaque text; only
 * the fields the UI owns (title, summary) are patched. Unknown keys, source
 * bindings and edge metadata therefore survive an edit byte-for-byte.
 */

export interface MemoryDocumentSplit {
  /** Inner frontmatter text without the `---` delimiters; null when absent. */
  frontmatter: string | null;
  /** Body text after the closing delimiter (LF-normalized). */
  body: string;
}

const OPENING = /^---[ \t]*\r?\n/;
const CLOSING = /^---[ \t]*$/;

/** Split a canonical document into its raw frontmatter block and body. */
export function splitMemoryDocument(source: string): MemoryDocumentSplit {
  const opening = OPENING.exec(source);
  if (!opening) return { frontmatter: null, body: source };
  const rest = source.slice(opening[0].length);
  const lines = rest.split(/\r?\n/);
  const closeIndex = lines.findIndex((line) => CLOSING.test(line));
  if (closeIndex === -1) return { frontmatter: null, body: source };
  // Canonical writers may emit one blank separator line after the closing
  // delimiter; it carries no content, so the editor view drops exactly one.
  let bodyLines = lines.slice(closeIndex + 1);
  if (bodyLines.length > 0 && bodyLines[0] === "")
    bodyLines = bodyLines.slice(1);
  return {
    frontmatter: lines.slice(0, closeIndex).join("\n"),
    body: bodyLines.join("\n"),
  };
}

/** Rebuild the document; a null frontmatter leaves the body untouched. */
export function buildMemoryDocument(
  frontmatter: string | null,
  body: string,
): string {
  const trimmedBody = body.endsWith("\n") ? body : `${body}\n`;
  if (frontmatter === null) return trimmedBody;
  return `---\n${frontmatter}\n---\n${trimmedBody}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      return value;
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/**
 * Read a top-level key. Nested/indented lines (sources, edges) never match
 * because the key pattern is anchored at the line start.
 */
export function readFrontmatterField(
  frontmatter: string,
  key: string,
): string | null {
  const pattern = new RegExp(`^${escapeRegExp(key)}[ \\t]*:(.*)$`);
  for (const line of frontmatter.split("\n")) {
    const match = pattern.exec(line);
    if (match) return decodeScalar(match[1] ?? "");
  }
  return null;
}

/**
 * Replace (or append) a top-level key. The value is a JSON string literal,
 * which is also a valid YAML double-quoted scalar, so quotes, backslashes and
 * colons in user text cannot break the block.
 */
export function setFrontmatterField(
  frontmatter: string,
  key: string,
  value: string,
): string {
  const pattern = new RegExp(`^${escapeRegExp(key)}[ \\t]*:`);
  const encoded = JSON.stringify(value);
  let replaced = false;
  const lines = frontmatter.split("\n").map((line) => {
    if (replaced || !pattern.test(line)) return line;
    replaced = true;
    return `${key}: ${encoded}`;
  });
  if (!replaced) lines.push(`${key}: ${encoded}`);
  return lines.join("\n");
}

export interface NewNoteFields {
  noteId: string;
  spaceId: string;
  kind: string;
  title: string;
  summary: string;
}

/** Minimal canonical frontmatter for a service-created note. */
export function createNoteDocument(
  fields: NewNoteFields,
  body: string,
): string {
  const lines = [
    "---",
    "format_version: 1",
    `note_id: ${JSON.stringify(fields.noteId)}`,
    `memory_space_id: ${JSON.stringify(fields.spaceId)}`,
    `kind: ${fields.kind}`,
    `title: ${JSON.stringify(fields.title)}`,
  ];
  if (fields.summary) lines.push(`summary: ${JSON.stringify(fields.summary)}`);
  lines.push("---", "");
  return `${lines.join("\n")}${body.endsWith("\n") ? body : `${body}\n`}`;
}

export interface NoteEdits {
  title: string;
  summary: string;
  body: string;
  kind: string;
}

/**
 * Apply editor fields to a loaded canonical document. Title, summary and kind
 * are patched in place; the body replaces everything after the closing
 * delimiter. A document without frontmatter (first save of a plain body)
 * keeps its body.
 */
export function applyNoteEdits(
  loaded: string,
  edits: NoteEdits,
): { document: string; frontmatter: string | null } {
  const split = splitMemoryDocument(loaded);
  if (split.frontmatter === null)
    return {
      document: buildMemoryDocument(null, edits.body),
      frontmatter: null,
    };
  let frontmatter = setFrontmatterField(
    split.frontmatter,
    "title",
    edits.title,
  );
  frontmatter = setFrontmatterField(frontmatter, "kind", edits.kind);
  if (edits.summary || readFrontmatterField(frontmatter, "summary") !== null)
    frontmatter = setFrontmatterField(frontmatter, "summary", edits.summary);
  return {
    document: buildMemoryDocument(frontmatter, edits.body),
    frontmatter,
  };
}
