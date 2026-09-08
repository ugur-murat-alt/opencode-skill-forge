import { stat, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { sql, type Kysely } from "kysely";
import type { DB } from "../storage/schema.js";
import { IdentityService, type Identity } from "./identity.js";
import { ForgeError } from "../domain/errors.js";

const inputSchema = z.object({
  project_id: z.string().min(1).max(100),
  client_id: z.string().min(1).max(200),
  path: z.string().min(1).max(4096),
  local_name: z.string().min(1).max(200).optional(),
});

async function fingerprint(path: string): Promise<{
  canonical: string;
  print: string;
}> {
  // Note: stat runs on the SERVICE filesystem (correct for local profile;
  // server profile clients register paths the server cannot see and verify
  // reports stale — documented behavior, not a silent pass).
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw new ForgeError("binding_unavailable", "Yerel dizin okunamadı.", 422);
  }
  let info;
  try {
    info = await stat(canonical);
  } catch {
    throw new ForgeError("binding_unavailable", "Yerel dizin okunamadı.", 422);
  }
  if (!info.isDirectory())
    throw new ForgeError(
      "binding_unavailable",
      "Bağlantı bir dizin olmalıdır.",
      422,
    );
  return {
    canonical,
    print: `${info.dev}:${info.ino}:${info.size}:${Math.round(info.mtimeMs)}`,
  };
}

export class BindingService {
  constructor(readonly db: Kysely<DB>) {}

  async bind(actor: Identity, raw: unknown) {
    const input = inputSchema.strict().parse(raw);
    const { canonical, print } = await fingerprint(resolve(input.path));
    const localName = input.local_name ?? basename(canonical);
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", actor.tenantId)
        .execute();
      const auth = new IdentityService(tx);
      await auth.authorize(actor, "write", input.project_id);
      await tx
        .insertInto("project_bindings")
        .values({
          tenant_id: actor.tenantId,
          user_id: actor.userId,
          project_id: input.project_id,
          client_id: input.client_id,
          path: canonical,
          local_name: localName,
          fs_fingerprint: print,
        })
        .onConflict((oc) =>
          oc
            .columns(["tenant_id", "user_id", "client_id", "path"])
            .doUpdateSet({ local_name: localName, fs_fingerprint: print }),
        )
        .execute();
      const bound = await tx
        .selectFrom("project_bindings")
        .select(["project_id", "local_name"])
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("client_id", "=", input.client_id)
        .where("path", "=", canonical)
        .executeTakeFirstOrThrow();
      if (bound.project_id !== input.project_id)
        throw new ForgeError(
          "binding_conflict",
          "Bu istemci yolu başka projeye bağlı.",
          409,
        );
      return {
        bound: true,
        project_id: bound.project_id,
        local_name: bound.local_name,
      };
    });
  }

  async verify(actor: Identity, raw: unknown) {
    const input = z
      .object({
        client_id: z.string().min(1).max(200),
        path: z.string().min(1).max(4096),
      })
      .strict()
      .parse(raw);
    await new IdentityService(this.db).authorize(actor, "read");
    let canonical: string | null = null;
    try {
      canonical = await realpath(resolve(input.path));
    } catch {
      canonical = null;
    }
    const lookup = (path: string) =>
      this.db
        .selectFrom("project_bindings")
        .select(["project_id", "local_name", "fs_fingerprint"])
        .where("tenant_id", "=", actor.tenantId)
        .where("user_id", "=", actor.userId)
        .where("client_id", "=", input.client_id)
        .where("path", "=", path)
        .executeTakeFirst();
    const row = canonical
      ? await lookup(canonical)
      : await lookup(resolve(input.path));
    if (!row) return { status: "unbound" as const };
    if (!canonical)
      return {
        status: "stale" as const,
        project_id: row.project_id,
        local_name: row.local_name,
      };
    let print: string;
    try {
      print = (await fingerprint(canonical)).print;
    } catch {
      return {
        status: "stale" as const,
        project_id: row.project_id,
        local_name: row.local_name,
      };
    }
    if (print !== row.fs_fingerprint)
      return {
        status: "stale" as const,
        project_id: row.project_id,
        local_name: row.local_name,
      };
    return {
      status: "bound" as const,
      project_id: row.project_id,
      local_name: row.local_name,
    };
  }

  async list(actor: Identity) {
    await new IdentityService(this.db).authorize(actor, "read");
    return this.db
      .selectFrom("project_bindings")
      .select(["project_id", "client_id", "path", "local_name"])
      .where("tenant_id", "=", actor.tenantId)
      .where("user_id", "=", actor.userId)
      .orderBy("client_id")
      .limit(100)
      .execute();
  }
}
