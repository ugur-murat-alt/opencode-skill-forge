import { randomUUID } from "node:crypto";
import type { Client } from "pg";
export interface BackupRevision {
  tenant_id: string;
  skill_id: string;
  revision: string;
}
export async function pinPostgres(client: Client, revisions: BackupRevision[]) {
  const pins = revisions.map((row) => ({ ...row, id: randomUUID() }));
  await client.query("BEGIN");
  try {
    for (const tenant of [
      ...new Set(revisions.map((row) => row.tenant_id)),
    ].sort())
      await client.query("UPDATE tenants SET name = name WHERE id = $1", [
        tenant,
      ]);
    for (let start = 0; start < pins.length; start += 250) {
      const group = pins.slice(start, start + 250);
      await client.query(
        "INSERT INTO revision_readers (tenant_id, id, skill_id, revision, created_at) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::bigint[])",
        [
          group.map((r) => r.tenant_id),
          group.map((r) => r.id),
          group.map((r) => r.skill_id),
          group.map((r) => r.revision),
          group.map(() => Date.now()),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return async () => {
    for (let start = 0; start < pins.length; start += 250) {
      const group = pins.slice(start, start + 250);
      await client.query(
        "DELETE FROM revision_readers WHERE (tenant_id, id) IN (SELECT * FROM unnest($1::text[], $2::text[]))",
        [group.map((r) => r.tenant_id), group.map((r) => r.id)],
      );
    }
  };
}
