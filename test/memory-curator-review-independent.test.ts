import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import { openDatabase, type DatabaseHandle } from "../src/storage/database.js";
import { IdentityService, type Identity } from "../src/application/identity.js";
import { MemoryService } from "../src/memory/service.js";
import { MemoryCommitService } from "../src/memory/commit.js";
import { MemoryIndexService } from "../src/memory/index.js";
import { MemoryWriteService } from "../src/memory/writes.js";
import { CuratorReview } from "../src/memory/curator/review.js";
import { sha256Hex } from "../src/memory/files.js";
import { parseMemoryDocument } from "../src/domain/memory.js";
import { resolveVaultRelative, vaultRoot } from "../src/memory/paths.js";

/**
 * Bağımsız M06-B kabulü (9bd4be0, 8f16109, d1472f1): küratör önerilerinin
 * gerçek HTTP onay/ret uçları üzerinden incelenmesi.
 *
 * Kapsam: onayın M02 commit hattından yeni revizyon yazması ve audit'i; ret
 * yolunun hiçbir nota dokunmaması + idempotentliği; stale adayın 409
 * `base_revision_conflict` + `current_revision` ile görünmesi; applied/shadow
 * durumlarının reddi; yabancı kiracı/alan 404'ünün ad/sayı sızdırmaması; çift
 * eşzamanlı onayda tek revizyon; ve `review.ts` ile `writes.ts`'in metadata
 * yeniden kurma desenlerinin aynı alanları koruması (çift-kaynak riski).
 */

interface Ctx {
  root: string;
  config: { url: string; token: string };
  app: Awaited<ReturnType<typeof createHttpServer>>;
  storage: DatabaseHandle;
  identities: IdentityService;
  owner: Identity;
  memory: MemoryService;
  commits: MemoryCommitService;
  review: CuratorReview;
  spaceId: string;
  close: () => Promise<void>;
}

let changeCounter = 0;

async function bootstrapHttp(): Promise<Ctx> {
  const root = await mkdtemp(join(tmpdir(), "forge-curator-review-ind-"));
  await writeFile(
    join(root, "policy.json"),
    JSON.stringify({ memoryEnabled: true, evolutionEnabled: false }),
    { mode: 0o600 },
  );
  const config = await localConfig(root);
  const app = await createHttpServer(config);
  await app.listen({ host: config.host, port: config.port });
  const storage = await openDatabase({ dataDir: root });
  const identities = new IdentityService(storage.db);
  const owner = await identities.bootstrapLocal();
  const vault = vaultRoot(root);
  const memory = new MemoryService(storage.db, identities, vault);
  const index = new MemoryIndexService(storage.db, vault, memory);
  const commits = new MemoryCommitService({
    db: storage.db,
    vaultRoot: vault,
    service: memory,
    index,
  });
  const review = new CuratorReview({
    db: storage.db,
    service: memory,
    commits,
  });
  const space = await memory.ensureSpace(owner, { type: "personal" });
  return {
    root,
    config: { url: config.url, token: config.token },
    app,
    storage,
    identities,
    owner,
    memory,
    commits,
    review,
    spaceId: space.id,
    close: async () => {
      await app.close();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function headers(ctx: Ctx, init: RequestInit = {}) {
  return {
    host: new URL(ctx.config.url).host,
    authorization: `Bearer ${ctx.config.token}`,
    ...(init.body ? { "content-type": "application/json" } : {}),
  };
}

async function insertChange(ctx: Ctx, overrides: Record<string, unknown> = {}) {
  changeCounter += 1;
  const now = Date.now();
  const row = {
    id: `ind-chg-${changeCounter}`,
    tenant_id: ctx.owner.tenantId,
    space_id: ctx.spaceId,
    extraction_id: null,
    run_id: "run-review-independent",
    mode: "proposal",
    operation: "create",
    note_id: null,
    base_revision: null,
    kind: "preference",
    title: "Bağımsız küratör adayı",
    summary: null,
    body_md: "aday gövdesi",
    rationale: "kaynak kanıtı",
    source_refs_json: JSON.stringify([
      { source_id: "src-1", path: "a.md", section: null, hash: "a".repeat(64) },
    ]),
    claim_class: "user_declaration",
    relation: null,
    target_note_id: null,
    confidence_micros: null,
    risk: "low",
    state: "proposed",
    applied_revision: null,
    reason: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  await ctx.storage.db
    .insertInto("memory_curator_changes")
    .values(row as never)
    .execute();
  return row;
}

async function approve(ctx: Ctx, changeId: string, expectedRevision?: number) {
  return fetch(
    `${ctx.config.url}/api/memory/curator/proposals/${changeId}/approve`,
    {
      method: "POST",
      headers: headers(ctx, { body: "{}" }),
      body: JSON.stringify({
        space_id: ctx.spaceId,
        ...(expectedRevision !== undefined
          ? { expected_revision: expectedRevision }
          : {}),
      }),
    },
  );
}

async function reject(ctx: Ctx, changeId: string, reason?: string) {
  return fetch(
    `${ctx.config.url}/api/memory/curator/proposals/${changeId}/reject`,
    {
      method: "POST",
      headers: headers(ctx, { body: "{}" }),
      body: JSON.stringify({
        space_id: ctx.spaceId,
        ...(reason !== undefined ? { reason } : {}),
      }),
    },
  );
}

async function seedNote(
  ctx: Ctx,
  input: {
    noteId: string;
    title: string;
    body: string;
    kind?: string;
    frontmatterExtras?: string[];
    revision?: number;
  },
): Promise<number> {
  const content = [
    "---",
    "format_version: 1",
    `note_id: ${JSON.stringify(input.noteId)}`,
    `memory_space_id: ${JSON.stringify(ctx.spaceId)}`,
    `kind: ${input.kind ?? "note"}`,
    `title: ${JSON.stringify(input.title)}`,
    ...(input.frontmatterExtras ?? []),
    "---",
    "",
    input.body,
    "",
  ].join("\n");
  const event = await ctx.memory.recordEvent(ctx.owner, {
    spaceId: ctx.spaceId,
    sourceEventKey: `seed-${input.noteId}`,
    sourceKind: "manual",
    contentHash: sha256Hex(content),
  });
  const receipt = await ctx.commits.commit({
    identity: ctx.owner,
    spaceId: ctx.spaceId,
    eventId: event.event.id,
    sourceKind: "manual",
    content,
    noteId: input.noteId,
    baseRevision: input.revision ?? null,
    kind: input.kind,
  });
  return receipt.revision;
}

function errorCode(payload: unknown): string | undefined {
  return (payload as { error?: { code?: string } })?.error?.code;
}

test("onay: adaydan gelen içerik yeni revizyon olarak yazılır, audit düşer", async () => {
  const ctx = await bootstrapHttp();
  try {
    const change = await insertChange(ctx);
    const response = await approve(ctx, String(change.id));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      state: string;
      note_id: string;
      revision: number;
    };
    expect(payload.state).toBe("applied");
    expect(payload.revision).toBe(1);
    const note = await ctx.storage.db
      .selectFrom("memory_notes")
      .selectAll()
      .where("id", "=", payload.note_id)
      .executeTakeFirstOrThrow();
    expect(note.title).toBe("Bağımsız küratör adayı");
    const revision = await ctx.storage.db
      .selectFrom("memory_note_revisions")
      .selectAll()
      .where("note_id", "=", payload.note_id)
      .where("revision", "=", 1)
      .executeTakeFirstOrThrow();
    expect(revision.body_md).toContain("aday gövdesi");
    // Kaynak atıfları adaydan gelir.
    const sources = JSON.parse(revision.sources_json) as { id: string }[];
    expect(sources.map((source) => source.id)).toEqual(["src-1"]);
    // Revision dosyası diskte ve DB hash'i ile uyumlu.
    const file = await readFile(
      resolveVaultRelative(vaultRoot(ctx.root), revision.file_path!),
      "utf8",
    );
    expect(sha256Hex(file)).toBe(revision.content_hash);
    // Liste tazelenir: not sorguda görünür.
    const list = await fetch(
      `${ctx.config.url}/api/memory/notes?space_id=${encodeURIComponent(ctx.spaceId)}`,
      { headers: headers(ctx) },
    );
    const listPayload = (await list.json()) as { items: { id: string }[] };
    expect(listPayload.items.map((item) => item.id)).toContain(payload.note_id);
    const audit = await ctx.storage.db
      .selectFrom("audit_events")
      .select(["detail"])
      .where("kind", "=", "memory.curator.proposal.approved")
      .execute();
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({
      change_id: change.id,
      operation: "create",
      revision: 1,
    });
  } finally {
    await ctx.close();
  }
}, 60000);

test("ret: nota yazım yok, gerekçe saklanır, idempotent; sonra onay 409", async () => {
  const ctx = await bootstrapHttp();
  try {
    const change = await insertChange(ctx);
    const first = await reject(ctx, String(change.id), "kullanıcı istemedi");
    expect(first.status).toBe(200);
    const firstPayload = (await first.json()) as {
      state: string;
      reason: string;
    };
    expect(firstPayload.state).toBe("rejected");
    expect(firstPayload.reason).toBe("kullanıcı istemedi");
    expect(
      await ctx.storage.db.selectFrom("memory_notes").select(["id"]).execute(),
    ).toHaveLength(0);
    const row = await ctx.storage.db
      .selectFrom("memory_curator_changes")
      .select(["state", "reason"])
      .where("id", "=", change.id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe("rejected");
    expect(row.reason).toBe("kullanıcı istemedi");
    // İkinci ret idempotent: aynı durum ve gerekçe, hata yok.
    const second = await reject(ctx, String(change.id));
    expect(second.status).toBe(200);
    const secondPayload = (await second.json()) as { reason: string };
    expect(secondPayload.reason).toBe("kullanıcı istemedi");
    // Reddedilmiş aday onaylanamaz.
    const approveRejected = await approve(ctx, String(change.id));
    expect(approveRejected.status).toBe(409);
    expect(errorCode(await approveRejected.json())).toBe(
      "memory_proposal_state",
    );
    expect(
      await ctx.storage.db.selectFrom("memory_notes").select(["id"]).execute(),
    ).toHaveLength(0);
    const audit = await ctx.storage.db
      .selectFrom("audit_events")
      .select(["kind"])
      .where("kind", "=", "memory.curator.proposal.rejected")
      .execute();
    expect(audit).toHaveLength(2);
  } finally {
    await ctx.close();
  }
}, 60000);

test("stale aday: 409 + current_revision, not değişmez; applied/shadow reddedilir", async () => {
  const ctx = await bootstrapHttp();
  try {
    await seedNote(ctx, {
      noteId: "review-target",
      title: "Hedef not",
      body: "v1 gövde",
    });
    const change = await insertChange(ctx, {
      operation: "update",
      note_id: "review-target",
      base_revision: 1,
      body_md: "aday gövdesi",
    });
    // Not insan tarafından ilerletilir (kanonik belge gövdesi değiştirilir).
    const current = await ctx.memory.readNote(ctx.owner, {
      spaceId: ctx.spaceId,
      noteId: "review-target",
    });
    const marker = current.content!.indexOf("\n---\n");
    const bumped = `${current.content!.slice(0, marker + 5)}v2 gövde\n`;
    const bump = await ctx.memory.recordEvent(ctx.owner, {
      spaceId: ctx.spaceId,
      sourceEventKey: "human-bump",
      sourceKind: "manual",
      contentHash: sha256Hex(bumped),
    });
    await ctx.commits.commit({
      identity: ctx.owner,
      spaceId: ctx.spaceId,
      eventId: bump.event.id,
      sourceKind: "manual",
      content: bumped,
      noteId: "review-target",
      baseRevision: 1,
    });
    const stale = await approve(ctx, String(change.id));
    expect(stale.status).toBe(409);
    const stalePayload = (await stale.json()) as {
      error: { code: string; detail: Record<string, unknown> };
    };
    expect(stalePayload.error.code).toBe("memory_revision_conflict");
    expect(stalePayload.error.detail).toMatchObject({
      current_revision: 2,
      base_revision: 1,
    });
    const row = await ctx.storage.db
      .selectFrom("memory_curator_changes")
      .select(["state", "reason"])
      .where("id", "=", change.id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe("stale");
    expect(row.reason).toBe("base_revision_conflict");
    // Not içeriği korunur (aday üzerine yazmaz).
    const note = await ctx.memory.readNote(ctx.owner, {
      spaceId: ctx.spaceId,
      noteId: "review-target",
    });
    expect(note.content).toContain("v2");
    expect(note.content).not.toContain("aday gövdesi");
    // applied ve shadow adaylar ne onaylanır ne reddedilir.
    const applied = await insertChange(ctx, { state: "applied" });
    const shadow = await insertChange(ctx, { state: "shadow" });
    for (const id of [applied.id, shadow.id]) {
      expect((await reject(ctx, String(id))).status).toBe(409);
      expect((await approve(ctx, String(id))).status).toBe(409);
    }
  } finally {
    await ctx.close();
  }
}, 90000);

test("yabancı kiracı/alan 404: ad veya sayı sızmaz", async () => {
  const ctx = await bootstrapHttp();
  try {
    const change = await insertChange(ctx, {
      title: "Gizli başlık",
      rationale: "Gizli gerekçe",
    });
    await ctx.storage.db
      .insertInto("tenants")
      .values({ id: "ind-tenant-b", name: "B", created_at: Date.now() })
      .execute();
    await ctx.storage.db
      .insertInto("users")
      .values({
        id: "ind-user-b",
        subject: "ind-user-b",
        display_name: "B",
        created_at: Date.now(),
      })
      .execute();
    await ctx.storage.db
      .insertInto("memberships")
      .values({
        tenant_id: "ind-tenant-b",
        user_id: "ind-user-b",
        role: "founder",
      })
      .execute();
    const token = await ctx.identities.issueSession(
      "ind-user-b",
      "session",
      3600_000,
    );
    const foreignHeaders = {
      host: new URL(ctx.config.url).host,
      cookie: `forge_session=${token}; forge_tenant=ind-tenant-b`,
      "x-forge-tenant": "ind-tenant-b",
      "x-forge-csrf": createHash("sha256").update(token).digest("hex"),
      "content-type": "application/json",
    };
    const response = await fetch(
      `${ctx.config.url}/api/memory/curator/proposals/${change.id}/approve`,
      {
        method: "POST",
        headers: foreignHeaders,
        body: JSON.stringify({ space_id: ctx.spaceId }),
      },
    );
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toContain("Gizli başlık");
    expect(text).not.toContain("Gizli gerekçe");
    expect(text).not.toContain(ctx.spaceId);
    // Sahibi de var olmayan alanla aynı 404'ü alır.
    const missingSpace = await fetch(
      `${ctx.config.url}/api/memory/curator/proposals/${change.id}/approve`,
      {
        method: "POST",
        headers: headers(ctx, { body: "{}" }),
        body: JSON.stringify({ space_id: "olmayan-alan" }),
      },
    );
    expect(missingSpace.status).toBe(404);
    expect(errorCode(await missingSpace.json())).toBe(
      "memory_space_unavailable",
    );
  } finally {
    await ctx.close();
  }
}, 60000);

test("çift eşzamanlı onay: tek revizyon, diğeri 409", async () => {
  const ctx = await bootstrapHttp();
  try {
    const change = await insertChange(ctx);
    const [a, b] = await Promise.all([
      approve(ctx, String(change.id)),
      approve(ctx, String(change.id)),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const failed = a.status === 409 ? a : b;
    const code = errorCode(await failed.json());
    // Yarış zamanlamasına göre iki temiz 409 yolu olabilir; ikisi de kabul.
    expect(["memory_event_conflict", "memory_proposal_state"]).toContain(code);
    const notes = await ctx.storage.db
      .selectFrom("memory_notes")
      .select(["id"])
      .execute();
    expect(notes).toHaveLength(1);
    const revisions = await ctx.storage.db
      .selectFrom("memory_note_revisions")
      .select(["revision"])
      .execute();
    expect(revisions.map((row) => row.revision)).toEqual([1]);
    const row = await ctx.storage.db
      .selectFrom("memory_curator_changes")
      .select(["state", "applied_revision"])
      .where("id", "=", change.id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe("applied");
    expect(row.applied_revision).toBe(1);
    console.log(`M06-REVIEW-RACE ${code}`);
  } finally {
    await ctx.close();
  }
}, 60000);

test("çift-kaynak riski: review.ts ve writes.ts aynı metadata alanlarını ve kanonik gövdeyi korur", async () => {
  const ctx = await bootstrapHttp();
  const extras = [
    'custom_field: "korunmalı"',
    `sources: [{"id":"agz-1","kind":"agz","hash":"${"a".repeat(64)}"}]`,
    "valid_from: 1000",
    "valid_until: 2000",
    "created_at: 500",
    "observed_at: 600",
  ];
  try {
    await seedNote(ctx, {
      noteId: "drift-writes",
      title: "Drift notu",
      body: "v1",
      frontmatterExtras: extras,
    });
    await seedNote(ctx, {
      noteId: "drift-review",
      title: "Drift notu",
      body: "v1",
      frontmatterExtras: extras,
    });
    // (a) MemoryWriteService patch'i.
    const writes = new MemoryWriteService({
      db: ctx.storage.db,
      service: ctx.memory,
      commits: ctx.commits,
      vaultRoot: vaultRoot(ctx.root),
    });
    await writes.update(ctx.owner, {
      space_id: ctx.spaceId,
      note_id: "drift-writes",
      expected_revision: 1,
      body: "v2",
    } as never);
    // (b) CuratorReview onayı (update adayı).
    const change = await insertChange(ctx, {
      operation: "update",
      note_id: "drift-review",
      base_revision: 1,
      body_md: "v2",
    });
    const approved = await ctx.review.approve(ctx.owner, {
      spaceId: ctx.spaceId,
      changeId: String(change.id),
    });
    expect(approved.state).toBe("applied");
    const readRecord = async (noteId: string) => {
      const note = await ctx.memory.readNote(ctx.owner, {
        spaceId: ctx.spaceId,
        noteId,
      });
      const parsed = parseMemoryDocument(note.content!);
      if (parsed.status !== "ok") throw new Error("parse");
      return parsed.record;
    };
    const viaWrites = await readRecord("drift-writes");
    const viaReview = await readRecord("drift-review");
    // İki bağımsız yeniden-kurma deseni aynı alanları taşımalı; biri
    // commit.ts metadata şemasından saparsa bu karşılaştırma kırılır.
    expect(viaWrites.sources).toEqual(viaReview.sources);
    expect(viaWrites.unknown).toEqual(viaReview.unknown);
    expect(viaWrites.validFrom).toBe(viaReview.validFrom);
    expect(viaWrites.validUntil).toBe(viaReview.validUntil);
    expect(viaWrites.createdAt).toBe(viaReview.createdAt);
    expect(viaWrites.observedAt).toBe(viaReview.observedAt);
    expect(viaWrites.body).toBe(viaReview.body);
    for (const record of [viaWrites, viaReview]) {
      expect(record.sources).toHaveLength(1);
      expect(record.unknown.custom_field).toBe("korunmalı");
      expect(record.validFrom).toBe(1000);
      expect(record.validUntil).toBe(2000);
      expect(record.createdAt).toBe(500);
    }
  } finally {
    await ctx.close();
  }
}, 90000);
