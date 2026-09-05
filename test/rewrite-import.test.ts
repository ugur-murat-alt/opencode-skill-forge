import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openDatabase } from "../src/storage/database.js";
import { IdentityService } from "../src/application/identity.js";
import { RewriteMigration } from "../src/migration/rewrites.js";
const hash = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
for (const backend of [
  "sqlite",
  ...(process.env.FORGE_TEST_POSTGRES_URL ? ["postgres"] : []),
])
  test(`rewrite import ${backend}: source truth, privacy, paging, replay and shared rollback`, async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-rewrites-")),
      storage = await openDatabase({
        dataDir: root,
        ...(backend === "postgres"
          ? { postgresUrl: process.env.FORGE_TEST_POSTGRES_URL }
          : {}),
      });
    try {
      const ids = new IdentityService(storage.db),
        owner = await ids.bootstrapLocal(),
        project = await ids.createProject(owner, "Rewrite migration"),
        service = new RewriteMigration(storage);
      const records = Array.from({ length: 23 }, (_, i) => ({
        ts: 1700000000000 + i,
        sessionID: "legacy-session",
        messageID: `message-${i}`,
        original: `PRIVATE ORIGINAL ${i}`,
        rewritten: `PRIVATE REWRITTEN ${i}`,
        outcome: "rewritten",
        durationMs: 42,
        ...(i === 0 ? {} : { applied: i % 2 === 0 }),
      }));
      const bytes = Buffer.from(
          records.map((r) => JSON.stringify(r)).join("\r\n") +
            "\r\n{malformed\r\n",
        ),
        first = await service.import(
          owner,
          project.id,
          hash("source1"),
          hash(bytes),
          bytes,
        );
      expect(first.review_required).toBe(1);
      expect(JSON.stringify(first)).not.toContain("PRIVATE");
      expect(await service.original(owner, first.receipt_id)).toEqual(bytes);
      const page = await service.list(owner, project.id);
      expect(page.items).toHaveLength(20);
      expect(page.next).not.toBeNull();
      const next = await service.list(owner, project.id, page.next!);
      expect(next.items).toHaveLength(3);
      expect(next.next).toBeNull();
      expect(
        new Set([...page.items, ...next.items].map((x) => x.id)).size,
      ).toBe(23);
      const unknown = [...page.items, ...next.items].find(
        (x) => x.original_preview === "PRIVATE ORIGINAL 0",
      )!;
      expect(unknown.source_applied).toBeNull();
      expect(
        (await service.detail(owner, project.id, unknown.id)).record.original,
      ).toBe("PRIVATE ORIGINAL 0");
      await expect(
        service.detail(
          { ...owner, userId: crypto.randomUUID() },
          project.id,
          unknown.id,
        ),
      ).rejects.toThrow();
      await expect(
        service.original(
          { ...owner, userId: crypto.randomUUID() },
          first.receipt_id,
        ),
      ).rejects.toMatchObject({ code: "migration_unavailable" });
      expect(
        (
          await service.import(
            owner,
            project.id,
            hash("source1"),
            hash(bytes),
            bytes,
          )
        ).replayed,
      ).toBe(true);
      const second = await service.import(
        owner,
        project.id,
        hash("source2"),
        hash(bytes),
        bytes,
      );
      expect(
        second.records.filter((x: any) => x.status === "duplicate"),
      ).toHaveLength(23);
      await service.rollback(owner, first.receipt_id);
      expect((await service.list(owner, project.id)).items).toHaveLength(20);
      await service.rollback(owner, second.receipt_id);
      expect((await service.list(owner, project.id)).items).toHaveLength(0);
      expect(await service.original(owner, second.receipt_id)).toEqual(bytes);
      expect((await service.rollback(owner, second.receipt_id)).replayed).toBe(
        true,
      );
    } finally {
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });
