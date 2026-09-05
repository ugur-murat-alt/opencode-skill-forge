import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Identity } from "../application/identity.js";
import { IdentityService } from "../application/identity.js";
import type { DatabaseHandle } from "../storage/database.js";
import type { PackageStore } from "../skills/store.js";
import { MigrationImporter } from "./importer.js";
import { LearningMigration } from "./learning.js";
import { RewriteMigration } from "./rewrites.js";
import { FlagMigration, flagMappingSchema } from "./flags.js";
import { ForgeError } from "../domain/errors.js";
const sha = z.string().regex(/^[a-f0-9]{64}$/),
  kind = z.enum(["package", "learning", "rewrites", "flags"]);
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
          enabled: z.boolean().optional(),
          sessions: flagMappingSchema.optional(),
        })
        .strict()
        .parse(request.body);
      const actor = identity(request);
      await new IdentityService(storage.db).authorize(
        actor,
        "write",
        body.project_ref,
      );
      const bytes = decode(
        body.content_base64,
        body.kind === "package" ? 5 * 1024 * 1024 : 16 * 1024 * 1024,
      );
      if (body.kind === "package") {
        if (
          !body.scope ||
          !body.flags ||
          body.enabled !== undefined ||
          body.sessions
        )
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
      }
      if (body.scope || body.flags)
        throw new ForgeError(
          "private_mapping_required",
          "Özel belgeler kişisel kapsamda aktarılır.",
        );
      if (body.kind === "learning") {
        if (body.enabled === undefined || body.sessions)
          throw new ForgeError(
            "learning_mapping_required",
            "Öğrenme aktarımı açık enabled gerektirir.",
          );
        return new LearningMigration(storage).import(
          actor,
          body.project_ref,
          body.source_id,
          body.checksum,
          bytes,
          body.enabled,
        );
      }
      if (body.enabled !== undefined)
        throw new ForgeError(
          "invalid_mapping",
          "Bu belge enabled değeri kullanmaz.",
        );
      if (body.kind === "flags") {
        if (!body.sessions)
          throw new ForgeError(
            "flag_mapping_required",
            "Bayrak aktarımı sessions eşlemesi gerektirir.",
          );
        return new FlagMigration(storage).import(
          actor,
          body.project_ref,
          body.source_id,
          body.checksum,
          bytes,
          body.sessions,
        );
      }
      if (body.sessions)
        throw new ForgeError(
          "invalid_mapping",
          "Rewrite aktarımı sessions eşlemesi kullanmaz.",
        );
      return new RewriteMigration(storage).import(
        actor,
        body.project_ref,
        body.source_id,
        body.checksum,
        bytes,
      );
    },
  );
  app.post("/api/migrations/:kind/:id/rollback", async (request) => {
    const params = z.object({ kind, id: sha }).parse(request.params),
      actor = identity(request);
    const service =
      params.kind === "learning"
        ? new LearningMigration(storage)
        : params.kind === "rewrites"
          ? new RewriteMigration(storage)
          : params.kind === "flags"
            ? new FlagMigration(storage)
            : new MigrationImporter(store(actor, ""));
    return service.rollback(actor, params.id);
  });
  app.get("/api/migrations/:kind/:id/original", async (request, reply) => {
    const params = z
        .object({ kind: z.enum(["learning", "rewrites", "flags"]), id: sha })
        .parse(request.params),
      actor = identity(request),
      service =
        params.kind === "learning"
          ? new LearningMigration(storage)
          : params.kind === "rewrites"
            ? new RewriteMigration(storage)
            : new FlagMigration(storage);
    const bytes = await service.original(actor, params.id);
    return reply
      .header("content-disposition", 'attachment; filename="legacy-source.bin"')
      .type("application/octet-stream")
      .send(bytes);
  });
}
