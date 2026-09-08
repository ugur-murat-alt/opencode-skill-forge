import type { Migration } from "kysely/migration";
// P17: membership role vocabulary becomes founder/admin/writer/reader/auditor.
// Existing rows are remapped; no membership is dropped or escalated.
const ROLE_MAP: Record<string, string> = {
  owner: "founder",
  editor: "writer",
  viewer: "reader",
};
export const roleRenameMigration: Migration = {
  up: async (db) => {
    for (const [from, to] of Object.entries(ROLE_MAP)) {
      await db
        .updateTable("memberships")
        .set({ role: to })
        .where("role", "=", from)
        .execute();
      await db
        .updateTable("project_members")
        .set({ role: to })
        .where("role", "=", from)
        .execute();
    }
  },
};
