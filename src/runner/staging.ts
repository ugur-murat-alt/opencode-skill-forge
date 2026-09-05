import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { sql } from "kysely";
import { JobQueue } from "../jobs/queue.js";
import { IdentityService } from "../application/identity.js";
import type { Identity } from "../application/identity.js";
import type { Run } from "../storage/schema.js";
import { PackageStore, type SkillScope } from "../skills/store.js";
import { validateInventory, validatePackagePath } from "../skills/paths.js";
import { validatePackage } from "../skills/validate.js";
import { ForgeError } from "../domain/errors.js";
/** A private candidate capability: no host paths, shell, credentials or main history. */
export class EvolutionStaging {
  private pinned = false;
  private operations = new Set<Promise<unknown>>();
  private files: Record<string, Buffer> = {};
  private readFiles = new Set<string>();
  private searched = false;
  private selected?: {
    name: string;
    scope: SkillScope;
    skillId?: string;
    baseRevision: string | null;
  };
  result: unknown = null;
  closed = false;
  constructor(
    readonly store: PackageStore,
    readonly identity: Identity,
    readonly run: Run,
  ) {}
  async dispose() {
    this.closed = true;
    await Promise.allSettled(this.operations);
    if (!this.pinned) return;
    await this.store.storage.db
      .deleteFrom("run_revision_pins")
      .where("tenant_id", "=", this.run.tenant_id)
      .where("run_id", "=", this.run.id)
      .where("fence", "=", this.run.fence)
      .execute();
    this.pinned = false;
  }
  private check() {
    if (this.closed) throw new ForgeError("run_closed", "İş sonlandırılmış.");
  }
  private tool(
    name: string,
    description: string,
    parameters: TSchema,
    action: (args: any) => Promise<unknown>,
  ): AgentTool {
    return {
      name,
      label: name,
      description,
      parameters,
      execute: async (_id, args) => {
        this.check();
        const operation = action(args);
        this.operations.add(operation);
        try {
          const result = await operation;
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: {},
          };
        } finally {
          this.operations.delete(operation);
        }
      },
    };
  }
  tools(): AgentTool[] {
    return [
      this.tool(
        "inventory",
        "Search authorized canonical owners before selecting a candidate. Metadata only.",
        Type.Object({
          query: Type.String({ maxLength: 200 }),
          after: Type.Optional(Type.String({ maxLength: 100 })),
        }),
        async (args) => {
          this.searched = true;
          return this.store.search(this.identity, {
            projectId: this.run.project_id,
            query: args.query,
            after: args.after,
          });
        },
      ),
      this.tool(
        "select",
        "Select one canonical package. Existing packages are pinned to their active revision. Explicit scope is mandatory.",
        Type.Object({
          name: Type.String({ maxLength: 64 }),
          scope: Type.Union([
            Type.Literal("personal"),
            Type.Literal("project"),
            Type.Literal("workspace"),
          ]),
          skill_id: Type.Optional(Type.String({ maxLength: 100 })),
        }),
        async (args) => {
          if (!this.searched)
            throw new ForgeError(
              "inventory_required",
              "Önce kanonik sahip envanterini inceleyin.",
            );
          if (this.selected || this.pinned)
            throw new ForgeError(
              "candidate_already_selected",
              "Bir iş tek kanonik paketi değiştirir.",
            );
          if (args.skill_id) {
            const skill = await this.store.authorizedSkill(
              this.identity,
              args.skill_id,
              true,
            );
            const expected =
              args.scope === "workspace"
                ? "workspace"
                : args.scope === "personal"
                  ? `personal:${this.identity.userId}`
                  : `project:${this.run.project_id}`;
            if (
              skill.scope_key !== expected ||
              skill.name !== args.name ||
              !skill.active_revision
            )
              throw new ForgeError(
                "owner_mismatch",
                "Kanonik ad/kapsam/sürüm eşleşmiyor.",
              );
            await this.store.storage.db.transaction().execute(async (tx) => {
              await tx
                .updateTable("tenants")
                .set({ name: sql`name` })
                .where("id", "=", this.identity.tenantId)
                .execute();
              await new JobQueue(this.store.storage).assertLease(tx, this.run);
              await new IdentityService(tx).authorize(
                this.identity,
                skill.scope_key === "workspace" ? "admin" : "write",
                skill.project_id ?? undefined,
              );
              await tx
                .insertInto("run_revision_pins")
                .values({
                  tenant_id: this.run.tenant_id,
                  run_id: this.run.id,
                  fence: this.run.fence,
                  skill_id: skill.id,
                  revision: skill.active_revision!,
                  created_at: Date.now(),
                })
                .execute();
            });
            this.pinned = true;
            const loaded = await this.store.files(
              this.identity,
              skill.id,
              skill.active_revision,
            );
            this.files = Object.fromEntries(
              Object.entries(loaded.files).map(([path, bytes]) => [
                path,
                Buffer.from(bytes),
              ]),
            );
            this.selected = {
              name: args.name,
              scope: args.scope,
              skillId: skill.id,
              baseRevision: skill.active_revision,
            };
          } else {
            const matches = await this.store.search(this.identity, {
              projectId: this.run.project_id,
              query: args.name,
              limit: 20,
            });
            if (matches.items.some((item) => item.name === args.name))
              throw new ForgeError(
                "canonical_owner_exists",
                "Bu isimde görünür kanonik sahip var; önce onu inceleyin.",
              );
            this.selected = {
              name: args.name,
              scope: args.scope,
              baseRevision: null,
            };
          }
          return {
            ...this.selected,
            files: Object.entries(this.files).map(([path, content]) => ({
              path,
              bytes: content.length,
            })),
          };
        },
      ),
      this.tool(
        "read",
        "Read a candidate file before changing it. Text or base64, bounded to 48 KiB per read.",
        Type.Object({
          path: Type.String({ maxLength: 240 }),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          encoding: Type.Optional(
            Type.Union([Type.Literal("utf8"), Type.Literal("base64")]),
          ),
        }),
        async (args) => {
          validatePackagePath(args.path);
          const bytes = this.files[args.path];
          if (!bytes)
            throw new ForgeError("file_unavailable", "Aday dosyası yok.");
          const offset = args.offset ?? 0,
            end = Math.min(bytes.length, offset + 49152);
          // Large files require sequential reads before write; offsets cannot bypass inspection.
          const marker = `${args.path}:${offset}`;
          if (offset && !this.readFiles.has(marker))
            throw new ForgeError(
              "read_sequence_required",
              "Dosyayı baştan sıralı okuyun.",
            );
          if (end === bytes.length) this.readFiles.add(args.path);
          else this.readFiles.add(`${args.path}:${end}`);
          return {
            path: args.path,
            content: bytes
              .subarray(offset, end)
              .toString(args.encoding ?? "utf8"),
            next_offset: end < bytes.length ? end : null,
          };
        },
      ),
      this.tool(
        "patch",
        "Apply one exact minimal text replacement. Existing content must have been read. Empty old_text creates a new file only.",
        Type.Object({
          path: Type.String({ maxLength: 240 }),
          old_text: Type.String({ maxLength: 65536 }),
          new_text: Type.String({ maxLength: 65536 }),
        }),
        async (args) => {
          if (!this.selected)
            throw new ForgeError("candidate_required", "Önce aday seçin.");
          validatePackagePath(args.path);
          const previous = this.files[args.path];
          if (previous && !this.readFiles.has(args.path))
            throw new ForgeError(
              "read_before_change_required",
              "Değişecek dosyayı önce okuyun.",
            );
          let next: string;
          if (!previous) {
            if (args.old_text)
              throw new ForgeError(
                "patch_conflict",
                "Yeni dosyanın eski metni boş olmalı.",
              );
            next = args.new_text;
          } else {
            const text = previous.toString("utf8"),
              at = text.indexOf(args.old_text);
            if (
              !args.old_text ||
              at < 0 ||
              text.indexOf(args.old_text, at + 1) !== -1
            )
              throw new ForgeError(
                "patch_conflict",
                "Eski metin tam bir kez eşleşmeli.",
              );
            next =
              text.slice(0, at) +
              args.new_text +
              text.slice(at + args.old_text.length);
          }
          const proposed: Record<string, Buffer> = {
            ...this.files,
            [args.path]: Buffer.from(next),
          };
          validateInventory(Object.keys(proposed));
          if (
            Object.values(proposed).reduce(
              (sum, bytes) => sum + bytes.length,
              0,
            ) > 4194304
          )
            throw new ForgeError("package_limit", "Paket boyutu aşıldı.");
          this.files = proposed;
          this.readFiles.delete(args.path);
          return { path: args.path, bytes: this.files[args.path]!.length };
        },
      ),
      this.tool(
        "remove",
        "Remove a previously read candidate file.",
        Type.Object({ path: Type.String({ maxLength: 240 }) }),
        async (args) => {
          validatePackagePath(args.path);
          if (!this.readFiles.has(args.path))
            throw new ForgeError(
              "read_before_change_required",
              "Silinecek dosyayı önce okuyun.",
            );
          delete this.files[args.path];
          this.readFiles.delete(args.path);
          return { removed: args.path };
        },
      ),
      this.tool(
        "validate",
        "Validate candidate structure and manifest. Script tests run independently inside the manager publication gate.",
        Type.Object({}),
        async () => {
          if (!this.selected)
            throw new ForgeError("candidate_required", "Önce aday seçin.");
          const manifest = validatePackage(this.selected.name, this.files);
          return {
            hash: manifest.hash,
            files: manifest.files,
            script_tests: manifest.execution
              ? "required_at_finalize"
              : "not_applicable",
          };
        },
      ),
      this.tool(
        "finalize",
        "Finish once: no-op/reject, or manager-validated atomic create/update. Cannot bypass actual sandbox tests, ACL, CAS or fencing.",
        Type.Object({
          decision: Type.Union([
            Type.Literal("create"),
            Type.Literal("update"),
            Type.Literal("no-op"),
            Type.Literal("reject"),
          ]),
          reason: Type.String({ minLength: 1, maxLength: 1200 }),
        }),
        async (args) => {
          if (["create", "update"].includes(args.decision)) {
            if (
              !this.selected ||
              (args.decision === "update") !== Boolean(this.selected.skillId)
            )
              throw new ForgeError(
                "decision_mismatch",
                "Karar kanonik adayla eşleşmiyor.",
              );
            if (this.selected.skillId && !this.readFiles.has("SKILL.md"))
              throw new ForgeError(
                "owner_read_required",
                "Finalize öncesi güncel SKILL.md okunmalı.",
              );
            const published = await this.store.publishRebased(this.identity, {
              ...this.selected,
              projectId: this.run.project_id,
              files: this.files,
              run: this.run,
            });
            this.result = { ...published, reason: args.reason };
          } else this.result = { decision: args.decision, reason: args.reason };
          this.closed = true;
          return this.result;
        },
      ),
    ];
  }
}
