import { describe, expect, test } from "bun:test";
import {
  applyNoteEdits,
  buildMemoryDocument,
  createNoteDocument,
  readFrontmatterField,
  setFrontmatterField,
  splitMemoryDocument,
} from "../web/src/memory/document.js";

const CANONICAL = [
  "---",
  "format_version: 1",
  'note_id: "note-1"',
  "memory_space_id: space-1",
  "kind: note",
  'title: "İlk başlık"',
  "summary: kısa özet",
  "sources:",
  "  - id: src-1",
  "edges:",
  "  - relation: SUPPORTS",
  "    target: note-2",
  "custom_user_key: korunmalı",
  "---",
  "",
  "# Gövde",
  "",
  "Satır.",
  "",
].join("\n");

describe("issue #37 memory document split", () => {
  test("canonical document splits into raw frontmatter and body", () => {
    const split = splitMemoryDocument(CANONICAL);
    expect(split.frontmatter).toContain("custom_user_key: korunmalı");
    expect(split.frontmatter).toContain("format_version: 1");
    expect(split.body).toBe("# Gövde\n\nSatır.\n");
  });

  test("a document without frontmatter stays a plain body", () => {
    const split = splitMemoryDocument("# sadece gövde\n");
    expect(split.frontmatter).toBeNull();
    expect(split.body).toBe("# sadece gövde\n");
  });

  test("an unclosed frontmatter is not treated as a block", () => {
    const source = "---\nformat_version: 1\n";
    expect(splitMemoryDocument(source).frontmatter).toBeNull();
  });

  test("a horizontal rule in the body is preserved", () => {
    const source = `${CANONICAL}\n---\n\ndaha sonra\n`;
    const split = splitMemoryDocument(source);
    expect(split.body).toContain("---");
    expect(split.body).toContain("daha sonra");
  });

  test("CRLF input is normalized without losing content", () => {
    const split = splitMemoryDocument(
      "---\r\nformat_version: 1\r\n---\r\ngövde\r\n",
    );
    expect(split.frontmatter).toBe("format_version: 1");
    expect(split.body).toBe("gövde\n");
  });
});

describe("issue #37 memory frontmatter fields", () => {
  test("quotes, backslashes and colons survive a field round-trip", () => {
    const tricky = 'Başlık: "alıntı" ve \\ ters bölü';
    const updated = setFrontmatterField(
      splitMemoryDocument(CANONICAL).frontmatter!,
      "title",
      tricky,
    );
    expect(readFrontmatterField(updated, "title")).toBe(tricky);
  });

  test("unknown keys, sources and edges stay byte-identical", () => {
    const frontmatter = splitMemoryDocument(CANONICAL).frontmatter!;
    const updated = setFrontmatterField(frontmatter, "title", "Yeni başlık");
    const lines = frontmatter.split("\n");
    const updatedLines = updated.split("\n");
    expect(updatedLines.length).toBe(lines.length);
    for (const line of lines)
      if (!line.startsWith("title:")) expect(updated).toContain(line);
    expect(readFrontmatterField(updated, "custom_user_key")).toBe("korunmalı");
  });

  test("a missing key is appended once", () => {
    const withSummary = setFrontmatterField(
      "format_version: 1",
      "summary",
      "özet",
    );
    expect(readFrontmatterField(withSummary, "summary")).toBe("özet");
  });
});

describe("issue #37 note edits", () => {
  test("title, kind and body are patched, other metadata preserved", () => {
    const { document } = applyNoteEdits(CANONICAL, {
      title: "Güncel başlık",
      summary: "kısa özet",
      body: "# Yeni gövde\n",
      kind: "decision",
    });
    const split = splitMemoryDocument(document);
    expect(readFrontmatterField(split.frontmatter!, "title")).toBe(
      "Güncel başlık",
    );
    expect(readFrontmatterField(split.frontmatter!, "kind")).toBe("decision");
    expect(split.frontmatter).toContain("custom_user_key: korunmalı");
    expect(split.frontmatter).toContain("- relation: SUPPORTS");
    expect(split.body).toBe("# Yeni gövde\n");
  });

  test("an empty summary does not add a new key", () => {
    const source = '---\nformat_version: 1\ntitle: "x"\n---\ngövde\n';
    const { frontmatter } = applyNoteEdits(source, {
      title: "x",
      summary: "",
      body: "gövde",
      kind: "note",
    });
    expect(readFrontmatterField(frontmatter!, "summary")).toBeNull();
  });

  test("a plain body edit keeps working without frontmatter", () => {
    const { document, frontmatter } = applyNoteEdits("eski gövde", {
      title: "x",
      summary: "",
      body: "yeni gövde",
      kind: "note",
    });
    expect(frontmatter).toBeNull();
    expect(document).toBe("yeni gövde\n");
  });
});

describe("issue #37 new note document", () => {
  test("a minimal canonical document is created with quoted identity", () => {
    const document = createNoteDocument(
      {
        noteId: "note-uuid",
        spaceId: "space-1",
        kind: "task",
        title: 'Görev: "ilk"',
        summary: "özet",
      },
      "gövde",
    );
    const split = splitMemoryDocument(document);
    expect(readFrontmatterField(split.frontmatter!, "note_id")).toBe(
      "note-uuid",
    );
    expect(readFrontmatterField(split.frontmatter!, "memory_space_id")).toBe(
      "space-1",
    );
    expect(readFrontmatterField(split.frontmatter!, "kind")).toBe("task");
    expect(readFrontmatterField(split.frontmatter!, "title")).toBe(
      'Görev: "ilk"',
    );
    expect(readFrontmatterField(split.frontmatter!, "summary")).toBe("özet");
    expect(split.body).toBe("gövde\n");
  });

  test("build keeps a single trailing newline", () => {
    expect(buildMemoryDocument(null, "gövde")).toBe("gövde\n");
    expect(buildMemoryDocument("a: 1", "gövde")).toBe(
      "---\na: 1\n---\ngövde\n",
    );
  });
});
