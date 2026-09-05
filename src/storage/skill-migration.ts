import type { Migration } from "kysely/migration";
import { sql } from "kysely";
export function skillMigration(backend: "sqlite" | "postgres"): Migration {
  return {
    up: async (db) => {
      await db.schema
        .createTable("skills")
        .addColumn("tenant_id", "text", (c) =>
          c.notNull().references("tenants.id"),
        )
        .addColumn("id", "text", (c) => c.notNull())
        .addColumn("scope_key", "text", (c) => c.notNull())
        .addColumn("project_id", "text")
        .addColumn("owner_id", "text", (c) => c.notNull())
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("description", "text", (c) => c.notNull())
        .addColumn("search_text", "text", (c) => c.notNull())
        .addColumn("active_revision", "text")
        .addColumn("managed", "integer", (c) => c.notNull().defaultTo(1))
        .addColumn("pinned", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("protected", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("archived", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("created_at", "bigint", (c) => c.notNull())
        .addColumn("updated_at", "bigint", (c) => c.notNull())
        .addPrimaryKeyConstraint("skill_pk", ["tenant_id", "id"])
        .addUniqueConstraint("skill_name_scope", [
          "tenant_id",
          "scope_key",
          "name",
        ])
        .addForeignKeyConstraint(
          "skill_owner",
          ["tenant_id", "owner_id"],
          "memberships",
          ["tenant_id", "user_id"],
        )
        .addForeignKeyConstraint(
          "skill_project",
          ["tenant_id", "project_id"],
          "projects",
          ["tenant_id", "id"],
        )
        .execute();
      await db.schema
        .createTable("skill_revisions")
        .addColumn("tenant_id", "text", (c) => c.notNull())
        .addColumn("skill_id", "text", (c) => c.notNull())
        .addColumn("revision", "text", (c) => c.notNull())
        .addColumn("manifest_json", "text", (c) => c.notNull())
        .addColumn("package_path", "text", (c) => c.notNull())
        .addColumn("created_by", "text", (c) => c.notNull())
        .addColumn("run_id", "text")
        .addColumn("validation_json", "text", (c) => c.notNull())
        .addColumn("created_at", "bigint", (c) => c.notNull())
        .addPrimaryKeyConstraint("revision_pk", [
          "tenant_id",
          "skill_id",
          "revision",
        ])
        .addForeignKeyConstraint(
          "revision_skill",
          ["tenant_id", "skill_id"],
          "skills",
          ["tenant_id", "id"],
        )
        .addForeignKeyConstraint(
          "revision_author",
          ["tenant_id", "created_by"],
          "memberships",
          ["tenant_id", "user_id"],
        )
        .addForeignKeyConstraint(
          "revision_run",
          ["tenant_id", "run_id"],
          "runs",
          ["tenant_id", "id"],
        )
        .execute();
      if (backend === "postgres")
        await db.schema
          .alterTable("skills")
          .addForeignKeyConstraint(
            "active_revision_fk",
            ["tenant_id", "id", "active_revision"],
            "skill_revisions",
            ["tenant_id", "skill_id", "revision"],
          )
          .execute();
      else {
        await sql`CREATE TRIGGER skill_active_revision_insert BEFORE INSERT ON skills WHEN NEW.active_revision IS NOT NULL AND NOT EXISTS (SELECT 1 FROM skill_revisions WHERE tenant_id=NEW.tenant_id AND skill_id=NEW.id AND revision=NEW.active_revision) BEGIN SELECT RAISE(ABORT, 'invalid active revision'); END`.execute(
          db,
        );
        await sql`CREATE TRIGGER skill_active_revision_update BEFORE UPDATE OF active_revision ON skills WHEN NEW.active_revision IS NOT NULL AND NOT EXISTS (SELECT 1 FROM skill_revisions WHERE tenant_id=NEW.tenant_id AND skill_id=NEW.id AND revision=NEW.active_revision) BEGIN SELECT RAISE(ABORT, 'invalid active revision'); END`.execute(
          db,
        );
        await sql`CREATE TRIGGER referenced_revision_delete BEFORE DELETE ON skill_revisions WHEN EXISTS (SELECT 1 FROM skills WHERE tenant_id=OLD.tenant_id AND id=OLD.skill_id AND active_revision=OLD.revision) BEGIN SELECT RAISE(ABORT, 'active revision referenced'); END`.execute(
          db,
        );
      }
      await db.schema
        .createIndex("skill_discovery")
        .on("skills")
        .columns(["tenant_id", "scope_key", "archived", "name", "id"])
        .execute();
      await db.schema
        .createTable("skill_overrides")
        .addColumn("tenant_id", "text", (c) => c.notNull())
        .addColumn("project_id", "text", (c) => c.notNull())
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("skill_id", "text", (c) => c.notNull())
        .addPrimaryKeyConstraint("override_pk", [
          "tenant_id",
          "project_id",
          "name",
        ])
        .addForeignKeyConstraint(
          "override_project",
          ["tenant_id", "project_id"],
          "projects",
          ["tenant_id", "id"],
        )
        .addForeignKeyConstraint(
          "override_skill",
          ["tenant_id", "skill_id"],
          "skills",
          ["tenant_id", "id"],
        )
        .execute();
    },
  };
}
