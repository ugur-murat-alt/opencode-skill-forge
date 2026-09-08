import type { Migration } from "kysely/migration";
// NOTE: SQLite cannot ADD FOREIGN KEY constraints to existing tables, so
// projects.environment_id integrity is enforced by resolveProject,
// createProject and environments.remove instead of DDL.
export const environmentUniquenessMigration: Migration = {
  up: async (db) => {
    const all = await db
      .selectFrom("environments")
      .select(["tenant_id", "id", "name", "created_at"])
      .orderBy("tenant_id")
      .orderBy("name")
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const groups = new Map<string, typeof all>();
    for (const row of all) {
      const key = `${row.tenant_id}\0${row.name}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const kept = list[0]!;
      const dupIds = list.slice(1).map((r) => r.id);
      await db
        .updateTable("projects")
        .set({ environment_id: kept.id })
        .where("tenant_id", "=", kept.tenant_id)
        .where("environment_id", "in", dupIds)
        .execute();
      await db
        .deleteFrom("environments")
        .where("tenant_id", "=", kept.tenant_id)
        .where("id", "in", dupIds)
        .execute();
    }
    const tenants = await db.selectFrom("tenants").select("id").execute();
    for (const tenant of tenants) {
      let def = await db
        .selectFrom("environments")
        .select(["id"])
        .where("tenant_id", "=", tenant.id)
        .where("name", "=", "default")
        .orderBy("created_at")
        .orderBy("id")
        .executeTakeFirst();
      if (!def) {
        const { randomUUID } = await import("node:crypto");
        const row = {
          tenant_id: tenant.id,
          id: randomUUID(),
          name: "default",
          created_at: Date.now(),
        };
        await db
          .insertInto("environments")
          .values(row)
          .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
          .execute();
        def = { id: row.id };
      }
      const live = await db
        .selectFrom("environments")
        .select("id")
        .where("tenant_id", "=", tenant.id)
        .execute();
      const liveIds = new Set(live.map((r) => r.id));
      const orphans = await db
        .selectFrom("projects")
        .select("id")
        .where("tenant_id", "=", tenant.id)
        .execute();
      const broken: string[] = [];
      for (const p of orphans) {
        const current = await db
          .selectFrom("projects")
          .select("environment_id")
          .where("tenant_id", "=", tenant.id)
          .where("id", "=", p.id)
          .executeTakeFirstOrThrow();
        if (!current.environment_id || !liveIds.has(current.environment_id))
          broken.push(p.id);
      }
      if (broken.length)
        await db
          .updateTable("projects")
          .set({ environment_id: def.id })
          .where("tenant_id", "=", tenant.id)
          .where("id", "in", broken)
          .execute();
    }
    try {
      await db.schema
        .createIndex("environment_name_unique")
        .unique()
        .on("environments")
        .columns(["tenant_id", "name"])
        .execute();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("already exists")) throw error;
    }
  },
};
