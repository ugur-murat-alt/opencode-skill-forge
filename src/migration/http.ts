import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Identity } from "../application/identity.js";
import { IdentityService } from "../application/identity.js";
import type { DatabaseHandle } from "../storage/database.js";
import type { PackageStore } from "../skills/store.js";
import { MigrationImporter } from "./importer.js";
import { ForgeError } from "../domain/errors.js";
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  kind = z.enum(["package"]);
function decode(text: string, max: number) {
  if (
    text.length > Math.ceil(max / 3) * 4 ||
    text.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(text)
  )
    throw new ForgeError(
      "invalid_transfer",
      "Aktarım base64 kodlaması veya boyutu geçersiz.",
    );
  const bytes = Buffer.from(text, "base64");
  if (bytes.length > max || bytes.toString("base64") !== text)
    throw new ForgeError(
      "invalid_transfer",
      "Aktarım byte sınırı/kodlaması geçersiz.",
    );
  return bytes;
}
export function registerMigrationHttp(
  app: FastifyInstance,
  storage: DatabaseHandle,
  identity: (request: FastifyRequest) => Identity,
  store: (actor: Identity, project: string) => PackageStore,
) {
  app.post(
    "/api/migrations/import",
    { bodyLimit: 24 * 1024 * 1024 },
    async (request) => {
      const body = z
        .object({
          kind,
          project_ref: z.string().min(1),
          source_id: sha,
          checksum: sha,
          content_base64: z.string().max(23 * 1024 * 1024),
          scope: z.enum(["personal", "project"]).optional(),
          flags: z
            .object({
              managed: z.boolean(),
              protected: z.boolean(),
              pinned: z.boolean(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(request.body);
      const actor = identity(request);
      await new IdentityService(storage.db).authorize(
        actor,
        "write",
        body.project_ref,
      );
      const bytes = decode(body.content_base64, 5 * 1024 * 1024);
      if (!body.scope || !body.flags)
        throw new ForgeError(
          "package_mapping_required",
          "Paket scope ve yönetim bayrakları gerektirir.",
        );
      return new MigrationImporter(
        store(actor, body.project_ref),
      ).importArchive(
        actor,
        {
          source_id: body.source_id,
          checksum: body.checksum,
          scope: body.scope,
          project_ref: body.project_ref,
          flags: body.flags,
        },
        bytes,
      );
    },
  );
  app.post("/api/migrations/:kind/:id/rollback", async (request) => {
    const params = z.object({ kind, id: sha }).parse(request.params),
      actor = identity(request);
    return new MigrationImporter(store(actor, "")).rollback(actor, params.id);
  });
}
