import { DirectoryReaders } from "./directory-readers.js";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, rename, lstat } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { sql, type Kysely } from "kysely";
import type { DatabaseHandle } from "../storage/database.js";
import type { DB, Run, Skill, SkillRevision } from "../storage/schema.js";
import { IdentityService, type Identity } from "../application/identity.js";
import { SettingsService } from "../application/settings.js";
import type { Settings } from "../domain/settings.js";
import { EnvironmentService } from "../application/environments.js";
import { scoreSkill, scopePriority } from "./scoring.js";
import { JobQueue } from "../jobs/queue.js";
import { ForgeError } from "../domain/errors.js";
import { validatePackage, type PackageManifest } from "./validate.js";
import { secureRead, packageInventory } from "./paths.js";
export type SkillScope = "workspace" | "personal" | "project" | "environment";

/** Environment- and workspace-scoped skills require admin to change. */
export function scopeWritePermission(scopeKey: string): "admin" | "write" {
  return scopeKey === "workspace" ||
    scopeKey === "environment" ||
    scopeKey.startsWith("environment:")
    ? "admin"
    : "write";
}
export interface ScriptValidation {
  hash: string;
  passed: boolean;
  sandbox: string;
  report: unknown;
}
export function searchText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[İı]/g, "i")
    .toLocaleLowerCase("en-US");
}
export class PackageStore {
  private directories = new DirectoryReaders();
  private readers = new Map<
    string,
    {
      id: string;
      count: number;
      ready: Promise<{ skill: Skill; row: SkillRevision }>;
    }
  >();
  constructor(
    readonly storage: DatabaseHandle,
    readonly dataDir: string,
    readonly validateScripts?: (
      path: string,
      manifest: PackageManifest,
    ) => Promise<ScriptValidation>,
    readonly policy: Settings = {},
  ) {}
  private async scope(
    identity: Identity,
    scope: SkillScope,
    projectId?: string,
  ) {
    if ((scope === "project" || scope === "environment") && !projectId)
      throw new ForgeError(
        "project_required",
        "Proje/ortam kapsamı açık project_ref gerektirir.",
      );
    if (scope === "environment") {
      const resolved = await new EnvironmentService(
        this.storage.db,
      ).resolveProject(identity.tenantId, projectId!);
      return `environment:${resolved.environment_id}`;
    }
    return scope === "personal"
      ? `personal:${identity.userId}`
      : scope === "project"
        ? `project:${projectId}`
        : "workspace";
  }
  async authorizedSkill(identity: Identity, id: string, write = false) {
    const skill = await this.storage.db
      .selectFrom("skills")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (
      !skill ||
      (skill.scope_key.startsWith("personal:") &&
        skill.owner_id !== identity.userId)
    )
      throw new ForgeError(
        "skill_unavailable",
        "Skill bulunamadı veya yetkiniz yok.",
        404,
      );
    await this.assertEnvAccess(this.storage.db, identity, skill.scope_key);
    await new IdentityService(this.storage.db).authorize(
      identity,
      write ? scopeWritePermission(skill.scope_key) : "read",
      skill.project_id ?? undefined,
    );
    return skill;
  }
  /** Environment skills load only for actors with a project in that environment. */
  private async assertEnvAccess(
    db: Kysely<DB>,
    identity: Identity,
    scopeKey: string,
  ) {
    if (!scopeKey.startsWith("environment:")) return;
    const envId = scopeKey.slice("environment:".length);
    const member = await db
      .selectFrom("memberships")
      .select("role")
      .where("tenant_id", "=", identity.tenantId)
      .where("user_id", "=", identity.userId)
      .executeTakeFirst();
    if (member && (member.role === "founder" || member.role === "admin"))
      return;
    const access = await db
      .selectFrom("project_members as pm")
      .innerJoin("projects as p", (join) =>
        join
          .onRef("p.tenant_id", "=", "pm.tenant_id")
          .onRef("p.id", "=", "pm.project_id"),
      )
      .select("pm.project_id")
      .where("pm.tenant_id", "=", identity.tenantId)
      .where("pm.user_id", "=", identity.userId)
      .where("p.environment_id", "=", envId)
      .limit(1)
      .executeTakeFirst();
    if (!access)
      throw new ForgeError(
        "skill_unavailable",
        "Skill bulunamadı veya yetkiniz yok.",
        404,
      );
  }
  private canonicalPath(path: string) {
    const root = resolve(this.dataDir),
      result = resolve(root, path),
      rel = relative(root, result);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw new ForgeError(
        "unsafe_package_path",
        "Paket yolu veri deposu dışında.",
      );
    return result;
  }
  /** Holds a durable revision reference only for the callback's actual read lifetime. */
  async withRevision<T>(
    identity: Identity,
    skillId: string,
    revision: string,
    read: (skill: Skill, row: SkillRevision) => Promise<T>,
    audit = false,
  ): Promise<T> {
    const key = JSON.stringify([
      identity.tenantId,
      identity.userId,
      skillId,
      revision,
      audit,
    ]);
    let entry = this.readers.get(key);
    if (!entry) {
      const id = randomUUID();
      const ready = this.storage.db.transaction().execute(async (tx) => {
        await tx
          .updateTable("tenants")
          .set({ name: sql`name` })
          .where("id", "=", identity.tenantId)
          .execute();
        const skill = await tx
          .selectFrom("skills")
          .selectAll()
          .where("tenant_id", "=", identity.tenantId)
          .where("id", "=", skillId)
          .executeTakeFirst();
        if (
          !skill ||
          (!audit &&
            skill.scope_key.startsWith("personal:") &&
            skill.owner_id !== identity.userId)
        )
          throw new ForgeError(
            "skill_unavailable",
            "Paket bulunamadı veya yetkiniz yok.",
            404,
          );
        await this.assertEnvAccess(tx, identity, skill.scope_key);
        await new IdentityService(tx).authorize(
          identity,
          audit ? "admin" : "read",
          audit ? undefined : (skill.project_id ?? undefined),
        );
        const row = await tx
          .selectFrom("skill_revisions")
          .selectAll()
          .where("tenant_id", "=", identity.tenantId)
          .where("skill_id", "=", skillId)
          .where("revision", "=", revision)
          .executeTakeFirst();
        if (!row)
          throw new ForgeError(
            "revision_unavailable",
            "Paket sürümü bulunamadı.",
            404,
          );
        await tx
          .insertInto("revision_readers")
          .values({
            tenant_id: identity.tenantId,
            id,
            skill_id: skillId,
            revision,
            created_at: Date.now(),
          })
          .execute();
        return { skill, row };
      });
      entry = { id, count: 0, ready };
      this.readers.set(key, entry);
    }
    entry.count++;
    try {
      const snapshot = await entry.ready;
      // TOCTOU close: re-resolve current access; the queued snapshot may
      // predate an env move, personal transfer or membership change.
      const current = await this.storage.db
        .selectFrom("skills")
        .select(["scope_key", "owner_id", "project_id"])
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", skillId)
        .executeTakeFirst();
      if (
        !current ||
        (!audit &&
          current.scope_key.startsWith("personal:") &&
          current.owner_id !== identity.userId)
      )
        throw new ForgeError(
          "skill_unavailable",
          "Paket bulunamadı veya yetkiniz yok.",
          404,
        );
      await this.assertEnvAccess(this.storage.db, identity, current.scope_key);
      // Share only the lifetime guard; each request rechecks authorization and reads real bytes.
      await new IdentityService(this.storage.db).authorize(
        identity,
        audit ? "admin" : "read",
        audit ? undefined : (current.project_id ?? undefined),
      );
      return await read(snapshot.skill, snapshot.row);
    } finally {
      entry.count--;
      if (entry.count === 0) {
        this.readers.delete(key);
        await entry.ready.then(
          async () => {
            await this.storage.db
              .deleteFrom("revision_readers")
              .where("tenant_id", "=", identity.tenantId)
              .where("id", "=", entry!.id)
              .execute();
          },
          () => undefined,
        );
      }
    }
  }
  async files(
    identity: Identity,
    skillId: string,
    revision: string,
    selectedPaths?: string[],
  ) {
    return this.withRevision(identity, skillId, revision, async (skill, row) =>
      this.directories.withDirectory(
        this.canonicalPath(row.package_path),
        async (reader) => {
          const manifest = JSON.parse(row.manifest_json) as PackageManifest,
            files: Record<string, Buffer> = {};
          const inventory = await reader.inventory();
          if (
            JSON.stringify(inventory) !==
            JSON.stringify(manifest.files.map((file) => file.path).sort())
          )
            throw new ForgeError(
              "revision_corrupt",
              "Paket dosya envanteri değişti.",
              409,
            );
          for (const file of manifest.files.filter(
            (file) => !selectedPaths || selectedPaths.includes(file.path),
          )) {
            const bytes = await reader.read(file.path);
            if (
              bytes.length !== file.bytes ||
              createHash("sha256").update(bytes).digest("hex") !== file.hash
            )
              throw new ForgeError(
                "revision_corrupt",
                "Değişmez paket sürümü hash kontrolünden geçmedi.",
                409,
              );
            files[file.path] = bytes;
          }
          return {
            skill,
            manifest,
            files,
            path: this.canonicalPath(row.package_path),
          };
        },
      ),
    );
  }
  async publishRebased(
    identity: Identity,
    input: Parameters<PackageStore["publish"]>[1],
  ) {
    try {
      return await this.publish(identity, input);
    } catch (error) {
      if (
        !(error instanceof ForgeError) ||
        error.code !== "revision_conflict" ||
        !input.skillId ||
        !input.baseRevision
      )
        throw error;
    }
    const current = await this.authorizedSkill(identity, input.skillId, true);
    if (
      !current.active_revision ||
      current.active_revision === input.baseRevision
    )
      throw new ForgeError(
        "revision_conflict",
        "Paket yeniden tabanlanamadı.",
        409,
      );
    const base = await this.files(identity, input.skillId, input.baseRevision);
    const latest = await this.files(
      identity,
      input.skillId,
      current.active_revision,
    );
    const merged: Record<string, Buffer> = {};
    const same = (a: Buffer | undefined, b: Buffer | undefined) =>
      a === undefined || b === undefined ? a === b : a.equals(b);
    for (const path of new Set([
      ...Object.keys(base.files),
      ...Object.keys(latest.files),
      ...Object.keys(input.files),
    ])) {
      const before = base.files[path],
        live = latest.files[path],
        proposed = input.files[path];
      const oursChanged = !same(before, proposed),
        theirsChanged = !same(before, live);
      if (oursChanged && theirsChanged && !same(proposed, live))
        throw new ForgeError(
          "rebase_conflict",
          "Aynı dosyada farklı değişiklikler var; güncel sürümü okuyun.",
          409,
        );
      const result = oursChanged ? proposed : live;
      if (result !== undefined) merged[path] = result;
    }
    // One attempt only: full validation and live CAS/ACL/fencing run again.
    return this.publish(identity, {
      ...input,
      baseRevision: current.active_revision,
      files: merged,
    });
  }
  async publish(
    identity: Identity,
    input: {
      name: string;
      scope: SkillScope;
      projectId?: string;
      skillId?: string;
      baseRevision: string | null;
      files: Record<string, Buffer>;
      run?: Run;
      importReceipt?: {
        id: string;
        sourceId: string;
        sourceChecksum: string;
        flags: { managed: boolean; protected: boolean; pinned: boolean };
      };
    },
  ) {
    const scope = await this.scope(identity, input.scope, input.projectId);
    let resolvedScope = scope;
    if (input.scope === "environment" && !input.projectId && input.skillId) {
      // Update of an environment skill after its last project left the
      // environment: keep the stored scope_key instead of requiring a
      // representative project. New environment skills still need one.
      const current = await this.storage.db
        .selectFrom("skills")
        .select("scope_key")
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", input.skillId)
        .executeTakeFirst();
      if (current?.scope_key.startsWith("environment:"))
        resolvedScope = current.scope_key;
    }
    const auth = new IdentityService(this.storage.db);
    await auth.authorize(
      identity,
      scopeWritePermission(input.scope),
      input.projectId,
    );
    const manifest = validatePackage(input.name, input.files);
    const existing = input.skillId
      ? await this.authorizedSkill(identity, input.skillId, true)
      : await this.storage.db
          .selectFrom("skills")
          .selectAll()
          .where("tenant_id", "=", identity.tenantId)
          .where("scope_key", "=", resolvedScope)
          .where("name", "=", input.name)
          .executeTakeFirst();
    if (
      existing &&
      (existing.name !== input.name || existing.scope_key !== resolvedScope)
    )
      throw new ForgeError(
        "scope_change_denied",
        "Paket güncellemesi örtük isim/kapsam değiştiremez.",
        409,
      );
    if ((existing?.active_revision ?? null) !== input.baseRevision)
      throw new ForgeError(
        "revision_conflict",
        "Paket başka yazar tarafından güncellendi.",
        409,
      );
    if (
      existing &&
      (!existing.managed || existing.protected || existing.pinned)
    )
      throw new ForgeError(
        "skill_protected",
        "Skill otomatik yazıma kapalı.",
        403,
      );
    if (existing?.active_revision === manifest.hash)
      return {
        skill_id: existing.id,
        revision: manifest.hash,
        decision: "no-op" as const,
      };
    const id = existing?.id ?? randomUUID();
    const stagingRoot = this.canonicalPath(
      join(
        "tenants",
        createHash("sha256").update(identity.tenantId).digest("hex"),
        "staging",
        randomUUID(),
      ),
    );
    const candidate = join(stagingRoot, input.name);
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    for (const [path, bytes] of Object.entries(input.files)) {
      const target = join(candidate, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const fd = await open(target, "wx", 0o600);
      try {
        await fd.writeFile(bytes);
        await fd.sync();
      } finally {
        await fd.close();
      }
    }
    let tests: ScriptValidation | null = null;
    if (manifest.execution) {
      if (!this.validateScripts)
        throw new ForgeError(
          "sandbox_unavailable",
          "Script doğrulama sandbox'ı hazır değil.",
          503,
        );
      tests = await this.validateScripts(candidate, manifest);
      if (!tests.passed || tests.hash !== manifest.hash)
        throw new ForgeError(
          "candidate_tests_failed",
          "Script davranış testleri geçmedi.",
          422,
        );
    }
    // Re-read after tests: a script/test must not mutate the candidate it certifies.
    if (
      JSON.stringify(await packageInventory(candidate)) !==
      JSON.stringify(manifest.files.map((file) => file.path).sort())
    )
      throw new ForgeError(
        "candidate_changed",
        "Test sırasında aday dosya envanteri değişti.",
        409,
      );
    for (const file of manifest.files)
      if (
        createHash("sha256")
          .update(await secureRead(candidate, file.path))
          .digest("hex") !== file.hash
      )
        throw new ForgeError(
          "candidate_changed",
          "Test sırasında aday paketi değişti.",
          409,
        );
    const packageRelative = join(
      "tenants",
      createHash("sha256").update(identity.tenantId).digest("hex"),
      "packages",
      createHash("sha256").update(resolvedScope).digest("hex").slice(0, 20),
      id,
      "revisions",
      manifest.hash,
      input.name,
    );
    const destination = this.canonicalPath(packageRelative);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await rename(candidate, destination);
    } catch (error) {
      if (
        !["EEXIST", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
      for (const file of manifest.files)
        if (
          createHash("sha256")
            .update(await secureRead(destination, file.path))
            .digest("hex") !== file.hash
        )
          throw new ForgeError(
            "revision_corrupt",
            "Mevcut immutable dizin değişmiş.",
            409,
          );
    }
    if (process.platform !== "win32") {
      const fd = await open(dirname(destination), "r");
      try {
        await fd.sync();
      } finally {
        await fd.close();
      }
    }
    try {
      return await this.storage.db.transaction().execute(async (tx) => {
        // Lock authorization membership through the short publication transaction.
        await tx
          .updateTable("memberships")
          .set({ role: sql`role` })
          .where("tenant_id", "=", identity.tenantId)
          .where("user_id", "=", identity.userId)
          .execute();
        await new IdentityService(tx).authorize(
          identity,
          scopeWritePermission(input.scope),
          input.projectId,
        );
        if (input.run)
          await new JobQueue(this.storage).assertLease(tx, input.run);
        const now = Date.now();
        if (!existing)
          await tx
            .insertInto("skills")
            .values({
              tenant_id: identity.tenantId,
              id,
              scope_key: resolvedScope,
              project_id: input.scope === "project" ? input.projectId! : null,
              owner_id: identity.userId,
              name: input.name,
              description: manifest.description,
              search_text: searchText(`${input.name} ${manifest.description}`),
              active_revision: null,
              managed: 1,
              pinned: 0,
              protected: 0,
              archived: 0,
              created_at: now,
              updated_at: now,
            })
            .execute();
        await tx
          .insertInto("skill_revisions")
          .values({
            tenant_id: identity.tenantId,
            skill_id: id,
            revision: manifest.hash,
            manifest_json: JSON.stringify(manifest),
            package_path: packageRelative,
            created_by: identity.userId,
            run_id: input.run?.id ?? null,
            validation_json: JSON.stringify({
              hash: manifest.hash,
              passed: true,
              scripts: tests,
            }),
            created_at: now,
          })
          .onConflict((oc) =>
            oc.columns(["tenant_id", "skill_id", "revision"]).doNothing(),
          )
          .execute();
        let update = tx
          .updateTable("skills")
          .set({
            active_revision: manifest.hash,
            description: manifest.description,
            search_text: searchText(`${input.name} ${manifest.description}`),
            updated_at: sql<number>`case when updated_at >= ${now} then updated_at + 1 else ${now} end`,
          })
          .where("tenant_id", "=", identity.tenantId)
          .where("id", "=", id)
          .where("managed", "=", 1)
          .where("protected", "=", 0)
          .where("pinned", "=", 0);
        update =
          input.baseRevision === null
            ? update.where("active_revision", "is", null)
            : update.where("active_revision", "=", input.baseRevision);
        if (Number((await update.executeTakeFirst()).numUpdatedRows) !== 1)
          throw new ForgeError(
            "revision_conflict",
            "Paket eşzamanlı değişti veya korumaya alındı.",
            409,
          );
        await tx
          .insertInto("audit_events")
          .values({
            tenant_id: identity.tenantId,
            id: randomUUID(),
            user_id: identity.userId,
            project_id: input.projectId ?? null,
            kind: "skill.published",
            detail: JSON.stringify({
              skill_id: id,
              revision: manifest.hash,
              base_revision: input.baseRevision,
            }),
            created_at: now,
          })
          .execute();
        if (input.importReceipt) {
          if (existing || !input.projectId)
            throw new ForgeError(
              "migration_target_exists",
              "Aktarım yalnız yeni paket oluşturabilir.",
              409,
            );
          const receipt = input.importReceipt;
          await tx
            .updateTable("skills")
            .set({
              managed: receipt.flags.managed ? 1 : 0,
              protected: receipt.flags.protected ? 1 : 0,
              pinned: receipt.flags.pinned ? 1 : 0,
            })
            .where("tenant_id", "=", identity.tenantId)
            .where("id", "=", id)
            .execute();
          await tx
            .insertInto("migration_receipts")
            .values({
              tenant_id: identity.tenantId,
              id: receipt.id,
              user_id: identity.userId,
              project_id: input.projectId,
              source_id: receipt.sourceId,
              source_checksum: receipt.sourceChecksum,
              skill_id: id,
              revision: manifest.hash,
              skill_generation: now + 1,
              flags_json: JSON.stringify(receipt.flags),
              state: "applied",
              created_at: now,
              updated_at: now,
            })
            .execute();
        }
        return {
          skill_id: id,
          revision: manifest.hash,
          decision: existing ? ("update" as const) : ("create" as const),
        };
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505" || code?.startsWith("SQLITE_CONSTRAINT"))
        throw new ForgeError(
          "revision_conflict",
          "Paket adı/sürümü eşzamanlı yayınlandı.",
          409,
        );
      throw error;
    }
  }
  /** Explicit scope move with CAS, re-authorization and audit. Pins survive. */
  async setScope(
    identity: Identity,
    skillId: string,
    input: {
      scope: SkillScope;
      projectId?: string;
      expectedRevision: string | null;
    },
  ) {
    const target = await this.scope(identity, input.scope, input.projectId);
    return this.storage.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("tenants")
        .set({ name: sql`name` })
        .where("id", "=", identity.tenantId)
        .execute();
      const auth = new IdentityService(tx);
      const skill = await tx
        .selectFrom("skills")
        .selectAll()
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", skillId)
        .executeTakeFirst();
      if (
        !skill ||
        (skill.scope_key.startsWith("personal:") &&
          skill.owner_id !== identity.userId)
      )
        throw new ForgeError(
          "skill_unavailable",
          "Skill bulunamadı veya yetkiniz yok.",
          404,
        );
      await auth.authorize(
        identity,
        scopeWritePermission(skill.scope_key),
        skill.project_id ?? undefined,
      );
      await auth.authorize(
        identity,
        scopeWritePermission(target),
        input.scope === "project" ? input.projectId : undefined,
      );
      if ((skill.active_revision ?? null) !== input.expectedRevision)
        throw new ForgeError(
          "revision_conflict",
          "Kapsam taşınırken sürüm değişti; güncel sürümü okuyun.",
          409,
        );
      const clash = await tx
        .selectFrom("skills")
        .select("id")
        .where("tenant_id", "=", identity.tenantId)
        .where("scope_key", "=", target)
        .where("name", "=", skill.name)
        .where("id", "!=", skill.id)
        .executeTakeFirst();
      if (clash)
        throw new ForgeError(
          "scope_change_conflict",
          "Hedef kapsamda aynı adlı skill var.",
          409,
        );
      const now = Date.now();
      const moved =
        input.expectedRevision === null
          ? await tx
              .updateTable("skills")
              .set({
                scope_key: target,
                project_id: input.scope === "project" ? input.projectId! : null,
                updated_at: now,
              })
              .where("tenant_id", "=", identity.tenantId)
              .where("id", "=", skill.id)
              .where("active_revision", "is", null)
              .executeTakeFirst()
          : await tx
              .updateTable("skills")
              .set({
                scope_key: target,
                project_id: input.scope === "project" ? input.projectId! : null,
                updated_at: now,
              })
              .where("tenant_id", "=", identity.tenantId)
              .where("id", "=", skill.id)
              .where("active_revision", "=", input.expectedRevision)
              .executeTakeFirst();
      if (Number(moved.numUpdatedRows ?? 0) < 1)
        throw new ForgeError(
          "revision_conflict",
          "Kapsam taşınırken sürüm değişti; güncel sürümü okuyun.",
          409,
        );
      await tx
        .insertInto("audit_events")
        .values({
          tenant_id: identity.tenantId,
          id: randomUUID(),
          user_id: identity.userId,
          project_id: skill.project_id,
          kind: "skill.scope_changed",
          detail: JSON.stringify({
            skill_id: skill.id,
            from: skill.scope_key,
            to: target,
            revision: skill.active_revision,
          }),
          created_at: now,
        })
        .execute();
      return {
        id: skill.id,
        scope_key: target,
        active_revision: skill.active_revision,
      };
    });
  }
  async search(
    identity: Identity,
    input: {
      projectId: string;
      query?: string;
      scope?: SkillScope;
      after?: string;
      limit?: number;
    },
  ) {
    await new IdentityService(this.storage.db).authorize(
      identity,
      "read",
      input.projectId,
    );
    const scopes = input.scope
      ? [await this.scope(identity, input.scope, input.projectId)]
      : [
          "workspace",
          `personal:${identity.userId}`,
          `project:${input.projectId}`,
          `environment:${
            (
              await new EnvironmentService(this.storage.db).resolveProject(
                identity.tenantId,
                input.projectId,
              )
            ).environment_id
          }`,
        ];
    const effective = await new SettingsService(
      new IdentityService(this.storage.db),
      this.policy,
    ).effective(identity, input.projectId);
    const minScore = effective.values.searchMinScore ?? 0;
    const limit = Math.max(
      1,
      Math.min(20, effective.values.searchMaxResults ?? 20, input.limit ?? 5),
    );
    const terms = searchText(input.query ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 10);
    let query = this.storage.db
      .selectFrom("skills")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("scope_key", "in", scopes)
      .where("archived", "=", 0)
      .where("active_revision", "is not", null);
    for (const term of terms)
      query = query.where(
        sql<boolean>`search_text like ${`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} escape ${"\\"}`,
      );
    const rows = await query.orderBy("id").limit(100).execute();
    const since = Date.now() - 30 * 86400000;
    const usageRows = rows.length
      ? await this.storage.db
          .selectFrom("skill_observations")
          .select(["skill_id", (eb) => eb.fn.countAll<number>().as("n")])
          .where("tenant_id", "=", identity.tenantId)
          .where(
            "skill_id",
            "in",
            rows.map((r) => r.id),
          )
          .where("kind", "in", ["loaded", "entrypoint_executed"])
          .where("created_at", ">", since)
          .groupBy("skill_id")
          .execute()
      : [];
    const usage = new Map(usageRows.map((r) => [r.skill_id, Number(r.n)]));
    type Ranked = { row: (typeof rows)[number]; score: number; why: string[] };
    const ranked: Ranked[] = rows
      .map((row) => ({
        row,
        ...scoreSkill(input.query ?? "", {
          name: row.name,
          description: row.description,
          updatedAt: row.updated_at,
          usage: usage.get(row.id) ?? 0,
        }),
      }))
      .filter((r) => r.score >= minScore && (!input.query || r.score > 0))
      .sort(
        (a, b) =>
          b.score - a.score ||
          scopePriority(b.row.scope_key) - scopePriority(a.row.scope_key) ||
          b.row.updated_at - a.row.updated_at ||
          (a.row.id < b.row.id ? -1 : 1),
      );
    const merged: (Ranked & { other_scopes: string[]; other_ids: string[] })[] =
      [];
    for (const item of ranked) {
      const key = item.row.name.normalize("NFKC").toLowerCase();
      const existing = merged.find(
        (m) => m.row.name.normalize("NFKC").toLowerCase() === key,
      );
      if (existing) {
        existing.other_scopes.push(item.row.scope_key);
        existing.other_ids.push(item.row.id);
      } else merged.push({ ...item, other_scopes: [], other_ids: [] });
    }
    let start = 0;
    // Cursor resume is best-effort under concurrent writes: the ranking is
    // recomputed (score desc, scope priority, recency, id) and reading
    // continues after the anchor; a deleted anchor falls back to the nearest
    // position, which may skip or repeat entries on a changed dataset.
    if (input.after) {
      const sep = input.after.indexOf(":");
      const score = Number(input.after.slice(0, sep));
      const id = input.after.slice(sep + 1);
      if (sep <= 0 || !id || !Number.isFinite(score) || score < 0 || score > 1)
        throw new ForgeError("invalid_cursor", "Sayfa anahtarı geçersiz.");
      const anchor = merged.findIndex(
        (m) => m.score.toFixed(3) === score.toFixed(3) && m.row.id === id,
      );
      if (anchor >= 0) start = anchor + 1;
      else
        start = merged.findIndex(
          (m) =>
            m.score < score ||
            (m.score.toFixed(3) === score.toFixed(3) && m.row.id > id),
        );
      if (start < 0) start = merged.length;
    }
    const page = merged.slice(start, start + limit);
    const last = page[page.length - 1];
    return {
      items: page.map((item) => ({
        skill_id: item.row.id,
        name: item.row.name,
        description: item.row.description,
        scope: item.row.scope_key,
        revision: item.row.active_revision,
        updated_at: item.row.updated_at,
        managed: Boolean(item.row.managed),
        pinned: Boolean(item.row.pinned),
        protected: Boolean(item.row.protected),
        reason: input.query ? "metadata_match" : "inventory",
        score: item.score,
        why: item.why,
        other_scopes: item.other_scopes,
        other_skill_ids: item.other_ids,
      })),
      next:
        start + limit < merged.length && last
          ? `${last.score.toFixed(3)}:${last.row.id}`
          : null,
    };
  }
  async reconcile(
    identity: Identity,
    after?: { skill_id: string; revision: string },
  ) {
    await new IdentityService(this.storage.db).authorize(identity, "admin");
    const { rows, pins } = await this.storage.db
      .transaction()
      .execute(async (tx) => {
        await tx
          .updateTable("tenants")
          .set({ name: sql`name` })
          .where("id", "=", identity.tenantId)
          .execute();
        await new IdentityService(tx).authorize(identity, "admin");
        let query = tx
          .selectFrom("skill_revisions")
          .select(["skill_id", "revision", "package_path", "manifest_json"])
          .where("tenant_id", "=", identity.tenantId);
        if (after)
          query = query.where((eb) =>
            eb.or([
              eb("skill_id", ">", after.skill_id),
              eb.and([
                eb("skill_id", "=", after.skill_id),
                eb("revision", ">", after.revision),
              ]),
            ]),
          );
        const rows = await query
          .orderBy("skill_id")
          .orderBy("revision")
          .limit(26)
          .execute();
        const pins = rows.slice(0, 25).map((row) => ({
          tenant_id: identity.tenantId,
          id: randomUUID(),
          skill_id: row.skill_id,
          revision: row.revision,
          created_at: Date.now(),
        }));
        if (pins.length)
          await tx.insertInto("revision_readers").values(pins).execute();
        return { rows, pins };
      });
    const issues: {
      skill_id: string;
      revision: string;
      reason: "missing_or_corrupt";
    }[] = [];
    try {
      for (const row of rows.slice(0, 25)) {
        try {
          const manifest = JSON.parse(row.manifest_json) as PackageManifest;
          if (
            manifest.hash !== row.revision ||
            !Array.isArray(manifest.files) ||
            manifest.files.length > 256
          )
            throw Error("manifest");
          const root = this.canonicalPath(row.package_path),
            stat = await lstat(root);
          if (!stat.isDirectory() || stat.isSymbolicLink())
            throw Error("directory");
          if (
            JSON.stringify(await packageInventory(root)) !==
            JSON.stringify(manifest.files.map((file) => file.path).sort())
          )
            throw Error("inventory");
          for (const file of manifest.files) {
            const bytes = await secureRead(root, file.path);
            if (
              bytes.length !== file.bytes ||
              createHash("sha256").update(bytes).digest("hex") !== file.hash
            )
              throw Error("hash");
          }
        } catch (error) {
          if (error instanceof ForgeError && error.status === 403) throw error;
          issues.push({
            skill_id: row.skill_id,
            revision: row.revision,
            reason: "missing_or_corrupt",
          });
        }
      }
    } finally {
      if (pins.length)
        await this.storage.db
          .deleteFrom("revision_readers")
          .where("tenant_id", "=", identity.tenantId)
          .where(
            "id",
            "in",
            pins.map((pin) => pin.id),
          )
          .execute();
    }
    await new IdentityService(this.storage.db).authorize(identity, "admin");
    return {
      checked: Math.min(rows.length, 25),
      issues,
      next:
        rows.length > 25
          ? { skill_id: rows[24]!.skill_id, revision: rows[24]!.revision }
          : null,
      action: "verified_preserved" as const,
    };
  }
}
