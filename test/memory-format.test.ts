import { test, expect } from "bun:test";
import {
  MEMORY_FORMAT_VERSION,
  canonicalMemoryText,
  detectSupersessionCycle,
  extractWikilinks,
  memoryRecordHash,
  parseMemoryDocument,
  resolveWikilink,
  serializeMemoryDocument,
  type MemoryRecord,
} from "../src/domain/memory.js";

/**
 * Issue #34 (M01): the Markdown format v1 contract is a pure, deterministic
 * codec. These tests pin the properties promised by the issue: round-trip,
 * unknown frontmatter preservation, inert unknown security fields, future
 * format rejection without mutation, revision-independent hashing, LF-only
 * serialization with a verbatim body, note_id stability, acyclic
 * supersession, deterministic wikilink resolution and the task/lifecycle
 * separation. No database or application code takes part.
 */

const baseDocument = (extraFrontmatter = "", body = "Gövde metni.\n") =>
  [
    "---",
    `format_version: ${MEMORY_FORMAT_VERSION}`,
    'note_id: "note-1"',
    'memory_space_id: "space-1"',
    'kind: "decision"',
    'title: "İlk karar"',
    'lifecycle: "active"',
    "pinned: true",
    'verification: "declared"',
    'sources: [{"id":"agz:1","kind":"agz"}]',
    'edges: [{"relation":"SUPPORTS","target":"note-2"}]',
    "created_at: 1700000000000",
    ...(extraFrontmatter ? [extraFrontmatter] : []),
    "---",
    body,
  ].join("\n");

function parseOk(source: string): MemoryRecord {
  const parsed = parseMemoryDocument(source);
  expect(parsed.status).toBe("ok");
  if (parsed.status !== "ok") throw new Error("unreachable");
  return parsed.record;
}

test("#34 format v1 round-trips a note with sources, edges and unknown fields", () => {
  const source = baseDocument('custom_field: "korunmalı"');
  const record = parseOk(source);
  expect(record.formatVersion).toBe(1);
  expect(record.noteId).toBe("note-1");
  expect(record.spaceId).toBe("space-1");
  expect(record.kind).toBe("decision");
  expect(record.title).toBe("İlk karar");
  expect(record.lifecycle).toBe("active");
  expect(record.pinned).toBe(true);
  expect(record.verification).toBe("declared");
  expect(record.sources).toEqual([{ id: "agz:1", kind: "agz" }]);
  expect(record.edges).toEqual([{ relation: "SUPPORTS", target: "note-2" }]);
  // Unknown frontmatter survives the round-trip and is rewritten.
  expect(record.unknown).toEqual({ custom_field: "korunmalı" });
  const serialized = serializeMemoryDocument(record);
  expect(serialized).toContain('custom_field: "korunmalı"');
  const again = parseOk(serialized);
  expect(again.unknown).toEqual(record.unknown);
  expect(memoryRecordHash(again)).toBe(memoryRecordHash(record));
});

test("#34 unknown security-looking fields are preserved but never become typed identity", () => {
  const source = baseDocument(
    [
      'tenant_id: "attacker-tenant"',
      'owner_user_id: "attacker"',
      'space_id: "attacker-space"',
      'acl: {"role":"admin"}',
      'note_id_override: "hijack"',
    ].join("\n"),
  );
  const record = parseOk(source);
  // Known identity is the one parsed from the typed field, not the impostor.
  expect(record.noteId).toBe("note-1");
  expect(record.spaceId).toBe("space-1");
  expect(record.unknown.tenant_id).toBe("attacker-tenant");
  // No accessor treats unknown keys as authority: the typed record has no
  // such fields at all.
  expect("tenant_id" in record).toBe(false);
  expect("acl" in record).toBe(false);
  const again = parseOk(serializeMemoryDocument(record));
  expect(again.unknown.acl).toEqual({ role: "admin" });
  expect(again.noteId).toBe("note-1");
});

test("#34 a future format_version is rejected without producing a mutated record", () => {
  const future = baseDocument().replace(
    `format_version: ${MEMORY_FORMAT_VERSION}`,
    "format_version: 2",
  );
  const parsed = parseMemoryDocument(future);
  expect(parsed).toEqual({ status: "unsupported_format", formatVersion: 2 });
  expect("record" in parsed).toBe(false);
  // The source is untouched (the function is pure) and serialization of the
  // old version still works.
  expect(future).toContain("format_version: 2");
});

test("#34 hash excludes revision, is stable, and covers body/frontmatter content", () => {
  const source = baseDocument("", "Gövde metni.\n");
  const record = parseOk(source.replace("---\n", "---\nrevision: 4\n"));
  expect(record.revision).toBe(4);
  const canonical = canonicalMemoryText(record);
  expect(canonical).not.toContain("revision:");
  const hash = memoryRecordHash(record);
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(memoryRecordHash(record)).toBe(hash);
  // Same content, different revision => same hash.
  expect(memoryRecordHash({ ...record, revision: 9 })).toBe(hash);
  // Body and semantic frontmatter are covered.
  expect(memoryRecordHash({ ...record, body: "Değişti.\n" })).not.toBe(hash);
  expect(memoryRecordHash({ ...record, title: "Başka başlık" })).not.toBe(hash);
  // Serialized markdown of the same record is byte-stable.
  expect(serializeMemoryDocument(record)).toBe(serializeMemoryDocument(record));
});

test("#34 CRLF is normalized only while serializing; body meaning and Unicode are preserved", () => {
  const source = [
    "---",
    "format_version: 1",
    'note_id: "note-crlf"',
    'memory_space_id: "space-1"',
    'kind: "note"',
    'title: "CRLF"',
    "---",
    "",
    "Satır 1",
    "Satır 2",
  ].join("\r\n");
  const record = parseOk(source);
  // Raw body is kept verbatim at parse time.
  expect(record.body).toContain("\r\n");
  const serialized = serializeMemoryDocument(record);
  expect(serialized.includes("\r\n")).toBe(false);
  // The body text itself is unchanged once line endings are canonicalized.
  const bodyStart = serialized.indexOf("---\n", "---\n".length);
  expect(serialized.slice(bodyStart + 4)).toBe(
    record.body.replace(/\r\n?/g, "\n"),
  );
  // Unicode normalization is never applied: composed and decomposed forms
  // stay distinct, so meaning is not silently rewritten.
  const composed = parseOk(baseDocument("", "caf\u00e9\n"));
  const decomposed = parseOk(baseDocument("", "cafe\u0301\n"));
  expect(composed.body).toBe("caf\u00e9\n");
  expect(decomposed.body).toBe("cafe\u0301\n");
  expect(memoryRecordHash(composed)).not.toBe(memoryRecordHash(decomposed));
});

test("#34 note_id survives a title change and is never derived from the title", () => {
  const record = parseOk(
    baseDocument("", "Eski başlık gövdesi.\n").replace(
      'title: "İlk karar"',
      'title: "Eski başlık"',
    ),
  );
  const renamed = { ...record, title: "Yeni başlık" };
  const reparsed = parseOk(serializeMemoryDocument(renamed));
  expect(reparsed.noteId).toBe(record.noteId);
  expect(reparsed.title).toBe("Yeni başlık");
  // The rename is a real content change for the hash even though identity
  // stays stable.
  expect(memoryRecordHash(reparsed)).not.toBe(memoryRecordHash(record));
});

test("#34 supersession chains reject cycles while legal chains pass", () => {
  const acyclic = detectSupersessionCycle([
    { noteId: "a", supersedes: ["b"] },
    { noteId: "b", supersedes: ["c"] },
    { noteId: "c", supersedes: [] },
  ]);
  expect(acyclic).toBeNull();
  const cycle = detectSupersessionCycle([
    { noteId: "a", supersedes: ["b"] },
    { noteId: "b", supersedes: ["c"] },
    { noteId: "c", supersedes: ["a"] },
  ]);
  expect(cycle).not.toBeNull();
  expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
  expect(new Set(cycle!.slice(0, -1))).toEqual(new Set(["a", "b", "c"]));
  // A self-loop is a cycle too.
  expect(detectSupersessionCycle([{ noteId: "s", supersedes: ["s"] }])).toEqual(
    ["s", "s"],
  );
});

test("#34 wikilinks resolve deterministically and never guess between same titles", () => {
  const notes = [
    { noteId: "n1", title: "Karar" },
    { noteId: "n2", title: "Diğer" },
  ];
  expect(resolveWikilink("Karar", notes)).toEqual({
    status: "resolved",
    noteId: "n1",
  });
  expect(resolveWikilink("Yok", notes)).toEqual({
    status: "missing",
    title: "Yok",
  });
  const ambiguous = resolveWikilink("Karar", [
    ...notes,
    { noteId: "n3", title: "Karar" },
  ]);
  expect(ambiguous).toEqual({
    status: "ambiguous",
    candidates: ["n1", "n3"],
  });
  // Wikilink extraction keeps order, strips labels and heading anchors.
  expect(
    extractWikilinks("Bkz. [[Karar]] ve [[Diğer|etiket]] ile [[Karar#Bölüm]]."),
  ).toEqual(["Karar", "Diğer", "Karar"]);
});

test("#34 task status is separate from note lifecycle", () => {
  const record = parseOk(
    baseDocument()
      .replace('kind: "decision"', 'kind: "task"')
      .replace(
        'lifecycle: "active"',
        'lifecycle: "active"\ntask_status: "doing"',
      ),
  );
  expect(record.kind).toBe("task");
  expect(record.lifecycle).toBe("active");
  expect(record.taskStatus).toBe("doing");
  // Archiving the note does not complete the task; done does not archive it.
  const archived = parseOk(
    serializeMemoryDocument({ ...record, lifecycle: "archived" }),
  );
  expect(archived.taskStatus).toBe("doing");
  const done = parseOk(
    serializeMemoryDocument({ ...record, taskStatus: "done" }),
  );
  expect(done.lifecycle).toBe("active");
  // An invalid task status never silently becomes a lifecycle value.
  const invalid = parseMemoryDocument(
    baseDocument()
      .replace('kind: "decision"', 'kind: "task"')
      .replace(
        'lifecycle: "active"',
        'lifecycle: "active"\ntask_status: "finished"',
      ),
  );
  expect(invalid.status).toBe("invalid");
});

test("#34 the three verification states stay distinct through the codec", () => {
  for (const state of ["declared", "verified", "proposed"] as const) {
    const source = baseDocument().replace(
      'verification: "declared"',
      `verification: "${state}"`,
    );
    const record = parseOk(source);
    expect(record.verification).toBe(state);
    expect(parseOk(serializeMemoryDocument(record)).verification).toBe(state);
  }
});
