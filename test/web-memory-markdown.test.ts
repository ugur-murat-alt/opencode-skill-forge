import { describe, expect, test } from "bun:test";
import {
  MARKDOWN_LIMITS,
  inlineToText,
  parseMarkdown,
  safeMarkdownUrl,
} from "../web/src/memory/markdown.js";

function flattenText(source: string): string {
  return parseMarkdown(source)
    .blocks.map((block) => {
      if (block.type === "paragraph" || block.type === "heading")
        return inlineToText(block.children);
      if (block.type === "quote") return inlineToText(block.children);
      if (block.type === "list")
        return block.items.map((item) => inlineToText(item.children)).join(" ");
      if (block.type === "code") return block.value;
      return "";
    })
    .join(" ");
}

describe("issue #37 safe markdown urls", () => {
  test("http, https and mailto are allowed", () => {
    expect(safeMarkdownUrl("https://example.com/a?b=1")).toBe(
      "https://example.com/a?b=1",
    );
    expect(safeMarkdownUrl("http://example.com")).toBe("http://example.com/");
    expect(safeMarkdownUrl("mailto:user@example.com")).toBe(
      "mailto:user@example.com",
    );
  });

  test("javascript, data, file, protocol-relative and relative urls are rejected", () => {
    for (const value of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "//evil.example/x",
      "/notes/1",
      "vbscript:msgbox(1)",
      "java\nscript:alert(1)",
    ])
      expect(safeMarkdownUrl(value)).toBeNull();
  });
});

describe("issue #37 markdown parsing", () => {
  test("headings, lists, quotes and fenced code parse into blocks", () => {
    const { blocks } = parseMarkdown(
      [
        "# Başlık",
        "",
        "- bir",
        "- [x] iki",
        "",
        "1. sıralı",
        "",
        "> alıntı",
        "",
        "```ts",
        "const x = 1;",
        "```",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "list",
      "list",
      "quote",
      "code",
    ]);
    const taskList = blocks[1]!;
    if (taskList.type === "list") {
      expect(taskList.items[1]!.task).toBe(true);
      expect(taskList.items[1]!.checked).toBe(true);
    }
    const code = blocks[4]!;
    if (code.type === "code") {
      expect(code.language).toBe("ts");
      expect(code.value).toBe("const x = 1;");
    }
  });

  test("raw HTML becomes inert text, never a node", () => {
    const source = "<script>alert(1)</script> <img src=x onerror=alert(2)>";
    const { blocks } = parseMarkdown(source);
    expect(blocks).toHaveLength(1);
    const paragraph = blocks[0]!;
    expect(paragraph.type).toBe("paragraph");
    expect(inlineToText(paragraph.children)).toBe(source);
  });

  test("inline formatting stays inside text nodes", () => {
    const { blocks } = parseMarkdown("**kalın** ve `kod` ve *italik*");
    const paragraph = blocks[0]!;
    if (paragraph.type !== "paragraph") throw new Error("expected paragraph");
    const types = paragraph.children.map((node) => node.type);
    expect(types).toEqual(["strong", "text", "code", "text", "em"]);
    expect(inlineToText(paragraph.children)).toBe("kalın ve kod ve italik");
  });

  test("unsafe links become blocked nodes with visible label", () => {
    const { blocks } = parseMarkdown("[tıkla](javascript:alert(1))");
    const paragraph = blocks[0]!;
    if (paragraph.type !== "paragraph") throw new Error("expected paragraph");
    expect(paragraph.children[0]!.type).toBe("blocked");
    if (paragraph.children[0]!.type === "blocked")
      expect(paragraph.children[0]!.reason).toBe("url");
    expect(inlineToText(paragraph.children)).toBe("tıkla");
  });

  test("remote images are blocked and never become image nodes", () => {
    const { blocks } = parseMarkdown(
      "öncesi ![uzak görsel](https://evil.example/x.png) sonrası",
    );
    const paragraph = blocks[0]!;
    if (paragraph.type !== "paragraph") throw new Error("expected paragraph");
    const blocked = paragraph.children.find((node) => node.type === "blocked");
    expect(blocked).toBeDefined();
    if (blocked && blocked.type === "blocked")
      expect(blocked.reason).toBe("image");
    expect(JSON.stringify(blocks)).not.toContain("img");
  });

  test("safe links keep the allowlisted href", () => {
    const { blocks } = parseMarkdown("[git](https://example.com/git)");
    const paragraph = blocks[0]!;
    if (paragraph.type !== "paragraph") throw new Error("expected paragraph");
    const link = paragraph.children[0]!;
    expect(link.type).toBe("link");
    if (link.type === "link") expect(link.href).toBe("https://example.com/git");
  });

  test("line and character bounds report truncation", () => {
    const lines = Array.from(
      { length: MARKDOWN_LIMITS.maxLines + 10 },
      (_, index) => `satır ${index}`,
    ).join("\n");
    expect(parseMarkdown(lines).truncated).toBe(true);
    const long = "a".repeat(MARKDOWN_LIMITS.maxChars + 5);
    expect(parseMarkdown(long).truncated).toBe(true);
  });

  test("block count is bounded", () => {
    const source = Array.from(
      { length: MARKDOWN_LIMITS.maxBlocks + 20 },
      (_, index) => `# b${index}`,
    ).join("\n\n");
    const parsed = parseMarkdown(source);
    expect(parsed.blocks.length).toBeLessThanOrEqual(MARKDOWN_LIMITS.maxBlocks);
    expect(parsed.truncated).toBe(true);
  });
});

describe("issue #37 markdown plain-text projection", () => {
  test("flattening keeps user text and drops markup only", () => {
    expect(flattenText("# Başlık\n\nmetin **kalın**")).toBe(
      "Başlık metin kalın",
    );
  });
});
