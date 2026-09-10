import { DirectoryReaders } from "./directory-readers.js";
import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  rename,
  lstat,
  readdir,
  rmdir,
  rm,
  unlink,
} from "node:fs/promises";
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
import { secureRead, packageInventory, validatePackagePath } from "./paths.js";
export type SkillScope = "workspace" | "personal" | "project" | "environment";

/** Issue #27/#28: okuyucu kirasi, publish/reclaim sahipliği ve geri kazanım
 * aralığı için test edilebilir süreler. Üretim varsayılanları değişmez. */
export interface PackageStoreLiveness {
  /** Reader/claim lease süresi (varsayılan 60 sn). */
  leaseMs?: number;
  /** Lease yenileme aralığı (varsayılan lease/3). */
  heartbeatMs?: number;
  /** Claim'siz eski kalıntılar için mtime bekleme penceresi (varsayılan 10 dk). */
  reclaimGraceMs?: number;
  /** Tur başına incelenen en fazla dizin girdisi (varsayılan 200). */
  reclaimBudget?: number;
  /** Publisher'ın aktif reclaim claim'ini bekleme süresi (varsayılan 2 sn). */
  claimWaitMs?: number;
}
const LEASE_DEFAULT_MS = 60_000;
const RECLAIM_GRACE_DEFAULT_MS = 10 * 60_000;
const RECLAIM_BUDGET_DEFAULT = 200;
const CLAIM_WAIT_DEFAULT_MS = 2_000;
const CLAIM_POLL_MS = 25;
const RECLAIM_ERROR_LIMIT = 20;
const RECLAIM_ENTRY_LIMIT = 10_000;
const STAGING_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION_NAME = /^[a-f0-9]{64}$/;
const SKILL_DIR_NAME = /^[0-9a-zA-Z-]{1,100}$/;

/** Issue #28: referanssız dizinleri symlink takip etmeden, fd çapalı ve
 * sınırlı biçimde kaldırır. Kaldırma ilkeleri removeRevision ile aynıdır. */
async function removeTreeAnchored(
  root: string,
  relativePath: string,
  maxEntries = RECLAIM_ENTRY_LIMIT,
): Promise<void> {
  validatePackagePath(relativePath);
  if (process.platform !== "linux")
    throw new ForgeError(
      "safe_delete_unavailable",
      "Güvenli geri kazanım bu platformda hazır değil.",
      503,
    );
  const resolvedRoot = resolve(root);
  const segments = relativePath.split("/");
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  try {
    let current = "/";
    for (const segment of [
      "",
      ...resolvedRoot.split("/").filter(Boolean),
      ...segments.slice(0, -1),
    ]) {
      if (segment) current = join(current, segment);
      const handle = await open(
        current,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(handle);
      current = `/proc/self/fd/${handle.fd}`;
    }
    const name = segments.at(-1)!;
    const target = join(current, name);
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new ForgeError(
        "unsafe_path",
        "Geri kazanım hedefi gerçek dizin değil.",
      );
    let visited = 0;
    async function erase(parent: string, entry: string): Promise<void> {
      if (++visited > maxEntries)
        throw new ForgeError(
          "cleanup_limit",
          "Geri kazanım girdi sınırı aşıldı.",
        );
      try {
        const child = join(parent, entry);
        const childInfo = await lstat(child);
        if (!childInfo.isDirectory() || childInfo.isSymbolicLink()) {
          await unlink(child);
          return;
        }
        const handle = await open(
          child,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          const anchor = `/proc/self/fd/${handle.fd}`;
          for (const nested of await readdir(anchor))
            await erase(anchor, nested);
        } finally {
          await handle.close();
        }
        await rmdir(child);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await erase(current, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    await Promise.allSettled(handles.reverse().map((handle) => handle.close()));
  }
}

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
interface ReaderEntry {
  id: string;
  tenantId: string;
  count: number;
  ready: Promise<{ skill: Skill; row: SkillRevision }>;
  /** Pin insert'i commit etti mi; commit öncesi yokluk lease kaybı sayılmaz. */
  sealed: boolean;
  leaseLost: boolean;
}
interface Claim {
  tenantId: string;
  kind: "revision" | "staging";
  key: string;
  lost: boolean;
}
interface ReclaimSkipped {
  referenced: number;
  claims: number;
  symlinks: number;
  grace: number;
}
interface ReclaimError {
  path: string;
  reason: string;
}
const emptySkipped = (): ReclaimSkipped => ({
  referenced: 0,
  claims: 0,
  symlinks: 0,
  grace: 0,
});
export class PackageStore {
  private directories = new DirectoryReaders();
  private readers = new Map<string, ReaderEntry>();
  /** Issue #27: lease süresi ve yenileme DB saatinden hesaplanır. */
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly reclaimGraceMs: number;
  readonly reclaimBudget: number;
  readonly claimWaitMs: number;
  constructor(
    readonly storage: DatabaseHandle,
    readonly dataDir: string,
    readonly validateScripts?: (
      path: string,
      manifest: PackageManifest,
    ) => Promise<ScriptValidation>,
    readonly policy: Settings = {},
    liveness: PackageStoreLiveness = {},
  ) {
    this.leaseMs = Math.max(50, liveness.leaseMs ?? LEASE_DEFAULT_MS);
    this.heartbeatMs = Math.max(
      10,
      Math.min(
        this.leaseMs - 10,
        liveness.heartbeatMs ?? Math.floor(this.leaseMs / 3),
      ),
    );
    this.reclaimGraceMs = Math.max(
      0,
      liveness.reclaimGraceMs ?? RECLAIM_GRACE_DEFAULT_MS,
    );
    this.reclaimBudget = Math.max(
      1,
      liveness.reclaimBudget ?? RECLAIM_BUDGET_DEFAULT,
    );
    this.claimWaitMs = Math.max(
      0,
      liveness.claimWaitMs ?? CLAIM_WAIT_DEFAULT_MS,
    );
  }
  /** Process generation for revision reader liveness (issue #12). */
  readonly generation = randomUUID();
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
  private heartbeat?: ReturnType<typeof setInterval>;
  private touchInFlight?: Promise<void>;
  /** Issue #27: yenileme hatası sessizce yutulmaz; etkilenen pin'ler
   * sonuç kabulünden önce tek tek doğrulanır (bkz. assertReadLease). */
  private touchReaders() {
    if (this.readers.size === 0 || this.touchInFlight) return;
    this.touchInFlight = this.touchReadersOnce()
      .catch((error) => {
        process.stderr.write(
          `Okuyucu lease yenilemesi doğrulanacak: ${(error as Error).message}\n`,
        );
      })
      .finally(() => {
        this.touchInFlight = undefined;
      });
  }
  private async touchReadersOnce() {
    const now = await this.storage.now();
    const refreshed = await this.storage.db
      .updateTable("revision_readers")
      .set({ expires_at: now + this.leaseMs })
      .where("owner", "=", this.generation)
      .where("kind", "=", "read")
      .returning("id")
      .execute();
    const live = new Set(refreshed.map((row) => row.id));
    const missing = [...this.readers.values()].filter(
      (reader) => !live.has(reader.id),
    );
    if (!missing.length) return;
    // Yarış payı: insert henüz commit etmemiş olabilir; var olan satırları doğrula.
    const present = await this.storage.db
      .selectFrom("revision_readers")
      .select("id")
      .where("owner", "=", this.generation)
      .where("tenant_id", "in", [
        ...new Set(missing.map((reader) => reader.tenantId)),
      ])
      .where(
        "id",
        "in",
        missing.map((reader) => reader.id),
      )
      .execute();
    const ids = new Set(present.map((row) => row.id));
    for (const reader of missing)
      if (reader.sealed && !ids.has(reader.id)) reader.leaseLost = true;
  }
  private readerLeaseError() {
    // Mevcut hata sözlüğü kodu yeniden kullanılır: kilit kaybı okuyucunun
    // kapandığı anlamına gelir ve sonuç kabul edilmez.
    return new ForgeError(
      "reader_closed",
      "Okuma kilidi kaybedildi; sonuç kabul edilmedi.",
      409,
    );
  }
  /** Issue #27: yeni I/O ve sonuç kabulü yalnız geçerli sahipli lease ile yapılır. */
  private async assertReadLease(
    entry: ReaderEntry,
    tenantId: string,
    skillId: string,
    revision: string,
  ) {
    if (entry.leaseLost) throw this.readerLeaseError();
    try {
      const now = await this.storage.now();
      const pin = await this.storage.db
        .selectFrom("revision_readers")
        .select(["owner", "expires_at"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", entry.id)
        .executeTakeFirst();
      if (
        !pin ||
        pin.owner !== this.generation ||
        pin.expires_at === null ||
        pin.expires_at <= now
      ) {
        entry.leaseLost = true;
        throw this.readerLeaseError();
      }
      // Fiziksel silme koordinasyonu: tombstone (revision satırı) önce iner.
      const survives = await this.storage.db
        .selectFrom("skill_revisions")
        .select("revision")
        .where("tenant_id", "=", tenantId)
        .where("skill_id", "=", skillId)
        .where("revision", "=", revision)
        .executeTakeFirst();
      if (!survives) {
        entry.leaseLost = true;
        throw this.readerLeaseError();
      }
    } catch (error) {
      if (error instanceof ForgeError) throw error;
      entry.leaseLost = true;
      throw this.readerLeaseError();
    }
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
      // Issue #27: expiry DB saatinden üretilir; uygulama saati kayması
      // lease süresini erkene çekemez. Entry, ilk await'ten önce map'e
      // yazılır ki eşzamanlı okumalar tek pin paylaşsın.
      const ready = (async () => {
        const insertedAt = await this.storage.now();
        return this.storage.db.transaction().execute(async (tx) => {
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
              created_at: insertedAt,
              owner: this.generation,
              expires_at: insertedAt + this.leaseMs,
              kind: "read",
            })
            .execute();
          return { skill, row };
        });
      })();
      entry = {
        id,
        tenantId: identity.tenantId,
        count: 0,
        ready,
        sealed: false,
        leaseLost: false,
      };
      void ready.then(
        () => {
          entry!.sealed = true;
        },
        () => undefined,
      );
      this.readers.set(key, entry);
    }
    entry.count++;
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.touchReaders(), this.heartbeatMs);
      this.heartbeat.unref?.();
    }
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
      await this.assertReadLease(entry, identity.tenantId, skillId, revision);
      const result = await read(snapshot.skill, snapshot.row);
      // I/O tamamlanmış olsa da sonuç, silme tombstone'u inmiş bir lease ile kabul edilmez.
      await this.assertReadLease(entry, identity.tenantId, skillId, revision);
      return result;
    } finally {
      entry.count--;
      if (entry.count === 0) {
        this.readers.delete(key);
        if (this.readers.size === 0) {
          clearInterval(this.heartbeat);
          this.heartbeat = undefined;
        }
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
    let resolvedScope: string;
    if (input.scope === "environment" && input.skillId && !input.projectId) {
      // Issue #7: an existing environment skill keeps its stored scope even
      // when its environment lost every representative project. Authorized
      // manager writes ride the stored scope; creating a NEW environment
      // package still requires an explicit project_ref.
      const current = await this.authorizedSkill(identity, input.skillId, true);
      if (!current.scope_key.startsWith("environment:"))
        throw new ForgeError(
          "project_required",
          "Proje/ortam kapsamı açık project_ref gerektirir.",
        );
      resolvedScope = current.scope_key;
    } else {
      resolvedScope = await this.scope(identity, input.scope, input.projectId);
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
    // Issue #13: the caller owns its staging area; every failure after
    // creation (validation, sandbox, candidate change, DB/CAS) reclaims it.
    // After a successful rename the staging root is already empty, so the
    // finally never touches the immutable destination.
    // Issue #28: ownership is a DB claim with a heartbeat so a live long
    // validation survives reclaim, while a dead/stalled one expires.
    const stagingRelative = relative(resolve(this.dataDir), stagingRoot);
    const stagingClaim = await this.tryAcquireClaim(
      identity.tenantId,
      "staging",
      stagingRelative,
    );
    if (!stagingClaim)
      throw new ForgeError(
        "candidate_changed",
        "Staging alanı sahipliği alınamadı; yeniden yayınlayın.",
        409,
      );
    let revisionClaim: Claim | null = null;
    try {
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
      // Uzun doğrulama bitti: staging sahipliği hâlâ bizde mi?
      await this.assertClaim(stagingClaim);
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
      // Issue #28: reclaim aynı destination'ı bizi beklemeden silemez.
      const revisionKey = `${id}/${manifest.hash}`;
      revisionClaim = await this.acquireClaimWithWait(
        identity.tenantId,
        "revision",
        revisionKey,
        this.claimWaitMs,
      );
      if (!revisionClaim)
        throw new ForgeError(
          "revision_conflict",
          "Aynı sürüm dizini başka bir yayın veya geri kazanım tarafından kullanılıyor.",
          409,
        );
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
      await this.assertClaim(revisionClaim);
      if (process.platform !== "win32") {
        const fd = await open(dirname(destination), "r");
        try {
          await fd.sync();
        } finally {
          await fd.close();
        }
      }
      // Commit kapısı için DB saati; claim bu andan sonra tazelenmiş olmalı.
      const claimNow = await this.storage.now();
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
          // Issue #28: commit öncesi sahiplik kapısı. Claim süresi dolup
          // reclaim dizini geri kazandıysa DB satırı yazılmaz.
          const claimRow = await tx
            .selectFrom("package_claims")
            .select(["owner", "expires_at"])
            .where("tenant_id", "=", identity.tenantId)
            .where("kind", "=", "revision")
            .where("claim_key", "=", revisionKey)
            .executeTakeFirst();
          if (
            !claimRow ||
            claimRow.owner !== this.generation ||
            claimRow.expires_at <= claimNow
          )
            throw new ForgeError(
              "revision_conflict",
              "Sürüm dizini bu işlem sırasında geri kazanıldı; yeniden deneyin.",
              409,
            );
          // Issue #2: verify the current source scope inside the publication
          // transaction. A concurrent setScope() changes scope_key/project_id
          // without touching active_revision, so the CAS below alone cannot
          // detect it; the stale-authorized publish must stop here too.
          if (existing) {
            const current = await tx
              .selectFrom("skills")
              .select(["scope_key", "project_id"])
              .where("tenant_id", "=", identity.tenantId)
              .where("id", "=", id)
              .executeTakeFirst();
            if (
              current?.scope_key !== resolvedScope ||
              current.project_id !==
                (input.scope === "project" ? input.projectId! : null)
            )
              throw new ForgeError(
                "revision_conflict",
                "Paket kapsamı eşzamanlı değişti; güncel yetkiyle yeniden yayınlayın.",
                409,
              );
          }
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
                search_text: searchText(
                  `${input.name} ${manifest.description}`,
                ),
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
          update = update
            .where("scope_key", "=", resolvedScope)
            .where(
              "project_id",
              input.scope === "project" ? "=" : "is",
              input.scope === "project" ? input.projectId! : null,
            );
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
    } finally {
      if (revisionClaim) await this.releaseClaim(revisionClaim);
      await this.releaseClaim(stagingClaim);
      await rm(stagingRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
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
    // Issue #6: bounded keyset scan. Each request walks the next batch of
    // candidates in stable id order (ranked within the batch). Cursor forms:
    //   `scan:<id>`            — scan phase: continue after this candidate id
    //   `<score>:<resultId>`   — legacy rank anchor inside the FIRST batch
    //   `<score>:<resultId>:<prevBatchLastId|->` — rank anchor inside the
    //                             batch that follows prevBatchLastId
    // so traversal reaches the whole authorized set without arbitrary cuts.
    const BATCH = 100;
    let candidateAnchor: string | null = null;
    let rankAnchor: { score: number; id: string } | null = null;
    const invalidCursor = () =>
      new ForgeError("invalid_cursor", "Sayfa anahtarı geçersiz.");
    if (input.after) {
      if (input.after.startsWith("scan:")) {
        candidateAnchor = input.after.slice("scan:".length);
        if (!candidateAnchor) throw invalidCursor();
      } else {
        const parts = input.after.split(":");
        const score = Number(parts[0]);
        const id = parts[1];
        if (
          parts.length < 2 ||
          parts.length > 3 ||
          !id ||
          !Number.isFinite(score) ||
          score < 0 ||
          score > 1
        )
          throw invalidCursor();
        rankAnchor = { score, id };
        if (parts.length === 3) {
          if (!parts[2]!) throw invalidCursor();
          // "-" marks the first batch; otherwise re-fetch that batch.
          candidateAnchor = parts[2] === "-" ? null : parts[2]!;
        }
      }
    }
    if (candidateAnchor) query = query.where("id", ">", candidateAnchor);
    const scannedRows = await query
      .orderBy("id")
      .limit(BATCH + 1)
      .execute();
    const moreCandidates = scannedRows.length > BATCH;
    const rows = moreCandidates ? scannedRows.slice(0, BATCH) : scannedRows;
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
    // Rank anchors resume inside the current batch and stay best-effort under
    // concurrent writes (same caveat as before); `scan:` anchors advance the
    // keyset deterministically by candidate id.
    if (rankAnchor) {
      const sep = rankAnchor.id;
      const anchor = merged.findIndex(
        (m) =>
          m.score.toFixed(3) === rankAnchor!.score.toFixed(3) &&
          m.row.id === sep,
      );
      if (anchor >= 0) start = anchor + 1;
      else
        start = merged.findIndex(
          (m) =>
            m.score < rankAnchor!.score ||
            (m.score.toFixed(3) === rankAnchor!.score.toFixed(3) &&
              m.row.id > sep),
        );
      if (start < 0) start = merged.length;
    }
    const page = merged.slice(start, start + limit);
    const last = page[page.length - 1];
    const lastCandidate = rows[rows.length - 1];
    let next: string | null = null;
    if (start + limit < merged.length && last) {
      // Rank anchor inside this batch; the third part re-fetches the batch.
      next = `${last.score.toFixed(3)}:${last.row.id}:${candidateAnchor ?? "-"}`;
    } else if (moreCandidates && lastCandidate)
      next = `scan:${lastCandidate.id}`;
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
      next,
      // Bounded work per request: candidate rows scanned plus one usage
      // aggregate for the batch (issue #6 acceptance: measured, not silent).
      scanned: rows.length,
    };
  }
  /** Issue #12/#27: süresi geçmiş sahipli okuma pin'lerini atomik expiry
   * koşuluyla temizler. Seçim ile DELETE arasında yenilenen pin silinmez. */
  private async sweepReaders(tenantId: string, now: number) {
    const candidates = await this.storage.db
      .selectFrom("revision_readers")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("expires_at", "is not", null)
      .where("expires_at", "<", now)
      .limit(1000)
      .execute();
    if (!candidates.length) return 0;
    const deleted = await this.storage.db
      .deleteFrom("revision_readers")
      .where("tenant_id", "=", tenantId)
      .where(
        "id",
        "in",
        candidates.map((row) => row.id),
      )
      // Bariyer: aradaki heartbeat pin'i yenilediyse koşul tutmaz.
      .where("expires_at", "<", now)
      .returning("id")
      .execute();
    process.stderr.write(
      `Okuyucu uzlaştırması: ${deleted.length} süresi geçmiş okuma kilidi temizlendi` +
        (candidates.length > deleted.length
          ? `; ${candidates.length - deleted.length} pin yenilendi\n`
          : "\n"),
    );
    return deleted.length;
  }
  /** Issue #27/#28: açık yönetici mutasyonu. SQLite/PostgreSQL ortak yolu. */
  async reclaim(
    identity: Identity,
    options: {
      /** Bu DB zamanından eski sahipsiz (yedek) pin'leri açıkça kurtarır. */
      recoverOwnerlessBefore?: number;
      /** Denetim kaydı yalnız HTTP mutasyonu gibi açık çağrılarda yazılır. */
      audit?: boolean;
    } = {},
  ) {
    await new IdentityService(this.storage.db).authorize(identity, "admin");
    const now = await this.storage.now();
    const clearedReaders = await this.sweepReaders(identity.tenantId, now);
    const scan = await this.reclaimScan(identity.tenantId, now);
    let reclaimedOwnerless = 0;
    if (options.recoverOwnerlessBefore !== undefined) {
      const cutoff = options.recoverOwnerlessBefore;
      if (!Number.isFinite(cutoff) || cutoff <= 0 || cutoff > now)
        throw new ForgeError(
          "invalid_input",
          "Sahipsiz pin kurtarma kesimi DB saatinden ileri olamaz.",
          400,
        );
      const recovered = await this.storage.db
        .deleteFrom("revision_readers")
        .where("tenant_id", "=", identity.tenantId)
        .where("owner", "is", null)
        .where("created_at", "<", cutoff)
        .returning("id")
        .execute();
      reclaimedOwnerless = recovered.length;
    }
    const result = {
      cleared_readers: clearedReaders,
      reclaimed_staging: scan.reclaimed_staging,
      reclaimed_revisions: scan.reclaimed_revisions,
      reclaimed_ownerless: reclaimedOwnerless,
      skipped: scan.skipped,
      failed: scan.failed,
      errors: scan.errors,
      reclaim_complete: scan.reclaim_complete,
    };
    if (options.audit)
      await this.storage.db
        .insertInto("audit_events")
        .values({
          tenant_id: identity.tenantId,
          id: randomUUID(),
          user_id: identity.userId,
          project_id: null,
          kind: "package.reclaim",
          detail: JSON.stringify({
            cleared_readers: result.cleared_readers,
            reclaimed_staging: result.reclaimed_staging,
            reclaimed_revisions: result.reclaimed_revisions,
            reclaimed_ownerless: result.reclaimed_ownerless,
            failed: result.failed,
          }),
          created_at: now,
        })
        .execute();
    if (result.reclaimed_staging + result.reclaimed_revisions + result.failed)
      process.stderr.write(
        `Depo geri kazanımı: ${result.reclaimed_staging} staging, ${result.reclaimed_revisions} revision, ${result.failed} hata\n`,
      );
    return result;
  }
  /** Issue #28: HTTP GET yalnız bu salt raporu çağırır; dosya silmez. */
  async reconcile(
    identity: Identity,
    after?: { skill_id: string; revision: string },
    options: { reclaim?: boolean; recoverOwnerlessBefore?: number } = {},
  ) {
    const mutation =
      options.reclaim === false
        ? {
            cleared_readers: 0,
            reclaimed_staging: 0,
            reclaimed_revisions: 0,
            reclaimed_ownerless: 0,
            skipped: emptySkipped(),
            failed: 0,
            errors: [] as ReclaimError[],
            reclaim_complete: false,
          }
        : await this.reclaim(identity, {
            recoverOwnerlessBefore: options.recoverOwnerlessBefore,
          });
    const report = await this.integrityReport(identity, after);
    return { ...report, ...mutation };
  }
  /** Bütünlük taraması: pin'ler sahipli ve sürelidir; crash sonrası sweep kurtarır. */
  private async integrityReport(
    identity: Identity,
    after?: { skill_id: string; revision: string },
  ) {
    await new IdentityService(this.storage.db).authorize(identity, "admin");
    const insertedAt = await this.storage.now();
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
          created_at: insertedAt,
          owner: this.generation,
          expires_at: insertedAt + this.leaseMs,
          kind: "integrity" as const,
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
          .execute()
          .catch((error) => {
            // Temizlik hatası raporu düşürmez; pin süresi dolunca sweep kurtarır.
            process.stderr.write(
              `Bütünlük pini temizliği sonraki süpürmeye bırakıldı: ${(error as Error).message}\n`,
            );
          });
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
  private claims = new Map<string, Claim>();
  private claimHeartbeat?: ReturnType<typeof setInterval>;
  private claimTouchInFlight?: Promise<void>;
  private claimId(claim: Claim) {
    return `${claim.kind}\u0000${claim.key}`;
  }
  private registerClaim(
    tenantId: string,
    kind: Claim["kind"],
    key: string,
  ): Claim {
    const claim: Claim = { tenantId, kind, key, lost: false };
    this.claims.set(this.claimId(claim), claim);
    if (!this.claimHeartbeat) {
      this.claimHeartbeat = setInterval(
        () => this.touchClaims(),
        this.heartbeatMs,
      );
      this.claimHeartbeat.unref?.();
    }
    return claim;
  }
  private touchClaims() {
    if (!this.claims.size || this.claimTouchInFlight) return;
    this.claimTouchInFlight = this.touchClaimsOnce()
      .catch((error) => {
        process.stderr.write(
          `Claim yenilemesi doğrulanacak: ${(error as Error).message}\n`,
        );
      })
      .finally(() => {
        this.claimTouchInFlight = undefined;
      });
  }
  private async touchClaimsOnce() {
    const now = await this.storage.now();
    const refreshed = await this.storage.db
      .updateTable("package_claims")
      .set({ expires_at: now + this.leaseMs })
      .where("owner", "=", this.generation)
      .returning(["kind", "claim_key"])
      .execute();
    const live = new Set(
      refreshed.map((row) => `${row.kind}\u0000${row.claim_key}`),
    );
    for (const [id, claim] of this.claims) if (!live.has(id)) claim.lost = true;
  }
  private claimError(claim: Claim) {
    return claim.kind === "staging"
      ? // Staging sahipliği kaybı aday alanının geri kazanılmasıdır.
        new ForgeError(
          "candidate_changed",
          "Staging alanı sahipliği kaybedildi; yeniden yayınlayın.",
          409,
        )
      : new ForgeError(
          "revision_conflict",
          "Sürüm dizini sahipliği kaybedildi; yeniden deneyin.",
          409,
        );
  }
  /** Issue #28: yayıncı, sahipliği kaybettiyse yeni I/O/sonuç kabul etmez. */
  private async assertClaim(claim: Claim) {
    if (claim.lost) throw this.claimError(claim);
    try {
      const now = await this.storage.now();
      const row = await this.storage.db
        .selectFrom("package_claims")
        .select(["owner", "expires_at"])
        .where("tenant_id", "=", claim.tenantId)
        .where("kind", "=", claim.kind)
        .where("claim_key", "=", claim.key)
        .executeTakeFirst();
      if (!row || row.owner !== this.generation) {
        claim.lost = true;
        throw this.claimError(claim);
      }
      if (row.expires_at <= now) {
        const renewed = await this.storage.db
          .updateTable("package_claims")
          .set({ expires_at: now + this.leaseMs })
          .where("tenant_id", "=", claim.tenantId)
          .where("kind", "=", claim.kind)
          .where("claim_key", "=", claim.key)
          .where("owner", "=", this.generation)
          .returning("owner")
          .executeTakeFirst();
        if (!renewed) {
          claim.lost = true;
          throw this.claimError(claim);
        }
      }
    } catch (error) {
      if (error instanceof ForgeError) throw error;
      throw this.claimError(claim);
    }
  }
  private async releaseClaim(claim: Claim) {
    this.claims.delete(this.claimId(claim));
    if (!this.claims.size) {
      clearInterval(this.claimHeartbeat);
      this.claimHeartbeat = undefined;
    }
    await this.storage.db
      .deleteFrom("package_claims")
      .where("tenant_id", "=", claim.tenantId)
      .where("kind", "=", claim.kind)
      .where("claim_key", "=", claim.key)
      .where("owner", "=", this.generation)
      .execute()
      .catch((error) => {
        process.stderr.write(
          `Claim bırakılamadı (${claim.kind}/${claim.key}): ${(error as Error).message}\n`,
        );
      });
  }
  private async tryAcquireClaim(
    tenantId: string,
    kind: Claim["kind"],
    key: string,
  ): Promise<Claim | null> {
    const now = await this.storage.now();
    const inserted = await this.storage.db
      .insertInto("package_claims")
      .values({
        tenant_id: tenantId,
        kind,
        claim_key: key,
        owner: this.generation,
        created_at: now,
        expires_at: now + this.leaseMs,
      })
      .onConflict((oc) =>
        oc.columns(["tenant_id", "kind", "claim_key"]).doNothing(),
      )
      .returning("owner")
      .executeTakeFirst();
    if (inserted?.owner === this.generation)
      return this.registerClaim(tenantId, kind, key);
    const taken = await this.storage.db
      .updateTable("package_claims")
      .set({
        owner: this.generation,
        created_at: now,
        expires_at: now + this.leaseMs,
      })
      .where("tenant_id", "=", tenantId)
      .where("kind", "=", kind)
      .where("claim_key", "=", key)
      .where("expires_at", "<", now)
      .returning("owner")
      .executeTakeFirst();
    return taken?.owner === this.generation
      ? this.registerClaim(tenantId, kind, key)
      : null;
  }
  private async acquireClaimWithWait(
    tenantId: string,
    kind: Claim["kind"],
    key: string,
    waitMs: number,
  ): Promise<Claim | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const claim = await this.tryAcquireClaim(tenantId, kind, key);
      if (claim) return claim;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_MS));
    }
  }
  private reclaimReason(error: unknown) {
    if (error instanceof ForgeError) return error.code;
    return (error as NodeJS.ErrnoException).code ?? "reclaim_remove_failed";
  }
  /** ENOENT yokluk sayılır; diğer FS hataları tanılama için yükseltilir. */
  private async statOptional(path: string) {
    return lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  }
  private async reclaimStagingEntry(
    tenantId: string,
    relativePath: string,
    graceCutoff: number,
    now: number,
  ): Promise<"reclaimed" | "grace" | "claim" | "symlink" | "gone"> {
    const full = this.canonicalPath(relativePath);
    const info = await this.statOptional(full);
    if (!info) return "gone";
    if (info.isSymbolicLink() || !info.isDirectory()) return "symlink";
    const existing = await this.storage.db
      .selectFrom("package_claims")
      .select(["owner", "expires_at"])
      .where("tenant_id", "=", tenantId)
      .where("kind", "=", "staging")
      .where("claim_key", "=", relativePath)
      .executeTakeFirst();
    if (existing && existing.expires_at > now) return "claim";
    const expiredClaim = Boolean(existing);
    const claim = await this.tryAcquireClaim(tenantId, "staging", relativePath);
    if (!claim) return "claim";
    try {
      if (!expiredClaim && info.mtimeMs > graceCutoff) return "grace";
      const fresh = await this.statOptional(full);
      if (!fresh || fresh.isSymbolicLink() || !fresh.isDirectory())
        return "gone";
      await removeTreeAnchored(this.dataDir, relativePath);
      return "reclaimed";
    } finally {
      await this.releaseClaim(claim);
    }
  }
  private async reclaimRevisionEntry(
    tenantId: string,
    relativePath: string,
    skillId: string,
    revision: string,
    graceCutoff: number,
    now: number,
  ): Promise<
    "reclaimed" | "grace" | "claim" | "symlink" | "gone" | "referenced"
  > {
    const full = this.canonicalPath(relativePath);
    const info = await this.statOptional(full);
    if (!info) return "gone";
    if (info.isSymbolicLink() || !info.isDirectory()) return "symlink";
    const claimKey = `${skillId}/${revision}`;
    const existing = await this.storage.db
      .selectFrom("package_claims")
      .select(["owner", "expires_at"])
      .where("tenant_id", "=", tenantId)
      .where("kind", "=", "revision")
      .where("claim_key", "=", claimKey)
      .executeTakeFirst();
    if (existing && existing.expires_at > now) return "claim";
    const expiredClaim = Boolean(existing);
    const referenced = await this.storage.db
      .selectFrom("skill_revisions")
      .select("revision")
      .where("tenant_id", "=", tenantId)
      .where("skill_id", "=", skillId)
      .where("revision", "=", revision)
      .executeTakeFirst();
    if (referenced) return "referenced";
    const claim = await this.tryAcquireClaim(tenantId, "revision", claimKey);
    if (!claim) return "claim";
    try {
      // Bariyer: claim sonrası referans yeniden okunur; aradaki publish kazanır.
      const stillReferenced = await this.storage.db
        .selectFrom("skill_revisions")
        .select("revision")
        .where("tenant_id", "=", tenantId)
        .where("skill_id", "=", skillId)
        .where("revision", "=", revision)
        .executeTakeFirst();
      if (stillReferenced) return "referenced";
      if (!expiredClaim && info.mtimeMs > graceCutoff) return "grace";
      const fresh = await lstat(full).catch(() => null);
      if (!fresh || fresh.isSymbolicLink() || !fresh.isDirectory())
        return "gone";
      await removeTreeAnchored(this.dataDir, relativePath);
      return "reclaimed";
    } finally {
      await this.releaseClaim(claim);
    }
  }
  /** Issue #28: bounded tur + kararlı imleç; başarı/atlama/hata ayrı sayılır. */
  private async reclaimScan(tenantId: string, now: number) {
    const tenantDir = join(
      "tenants",
      createHash("sha256").update(tenantId).digest("hex"),
    );
    const stagingRootRelative = join(tenantDir, "staging");
    const packagesRootRelative = join(tenantDir, "packages");
    const state = await this.storage.db
      .selectFrom("package_scan_state")
      .select(["staging_cursor", "packages_cursor"])
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();
    let stagingCursor = state?.staging_cursor ?? "";
    let packagesCursor = state?.packages_cursor ?? "";
    let budget = this.reclaimBudget;
    const skipped = emptySkipped();
    const errors: ReclaimError[] = [];
    let failed = 0;
    let reclaimedStaging = 0;
    let reclaimedRevisions = 0;
    const graceCutoff = now - this.reclaimGraceMs;
    const note = (
      outcome: "grace" | "claim" | "symlink" | "referenced" | "gone",
    ) => {
      if (outcome === "grace") skipped.grace++;
      else if (outcome === "claim") skipped.claims++;
      else if (outcome === "symlink") skipped.symlinks++;
      else if (outcome === "referenced") skipped.referenced++;
    };
    /** Okuma hatası boş liste sayılmaz; tanılamaya eklenir (ENOENT yokluk). */
    const listing = async (path: string, label: string) => {
      try {
        return await readdir(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        failed++;
        if (errors.length < RECLAIM_ERROR_LIMIT)
          errors.push({ path: label, reason: this.reclaimReason(error) });
        return [];
      }
    };
    // 1) Staging alanları: her turda imleçten devam eder, sona gelince sarar.
    const stagingRootPath = this.canonicalPath(stagingRootRelative);
    const stagingNames = (await listing(stagingRootPath, stagingRootRelative))
      .filter((name) => STAGING_NAME.test(name))
      .sort();
    let stagingLast = stagingCursor;
    let stagingWrapped = false;
    for (const name of stagingNames) {
      if (name <= stagingLast) continue;
      if (budget <= 0) break;
      budget--;
      stagingLast = name;
      const relativePath = `${stagingRootRelative}/${name}`;
      try {
        const outcome = await this.reclaimStagingEntry(
          tenantId,
          relativePath,
          graceCutoff,
          now,
        );
        if (outcome === "reclaimed") reclaimedStaging++;
        else note(outcome);
      } catch (error) {
        failed++;
        if (errors.length < RECLAIM_ERROR_LIMIT)
          errors.push({
            path: relativePath,
            reason: this.reclaimReason(error),
          });
      }
    }
    if (!stagingNames.some((name) => name > stagingLast)) {
      stagingLast = "";
      stagingWrapped = true;
    }
    stagingCursor = stagingLast;
    // 2) Paket ağacı: lexicographic DFS, kararlı devam imleci.
    let packagesLast = packagesCursor;
    let exhausted = true;
    const packagesRoot = this.canonicalPath(packagesRootRelative);
    const scopeNames = (await listing(packagesRoot, packagesRootRelative))
      .filter((name) => /^[a-f0-9]{20}$/.test(name))
      .sort();
    outer: for (const scope of scopeNames) {
      const scopeDir = this.canonicalPath(`${packagesRootRelative}/${scope}`);
      let scopeInfo: Awaited<ReturnType<typeof lstat>> | null;
      try {
        scopeInfo = await this.statOptional(scopeDir);
      } catch (error) {
        failed++;
        if (errors.length < RECLAIM_ERROR_LIMIT)
          errors.push({
            path: `${packagesRootRelative}/${scope}`,
            reason: this.reclaimReason(error),
          });
        continue;
      }
      if (
        !scopeInfo ||
        !scopeInfo.isDirectory() ||
        scopeInfo.isSymbolicLink()
      ) {
        if (scopeInfo?.isSymbolicLink()) skipped.symlinks++;
        continue;
      }
      const skillNames = (
        await listing(scopeDir, `${packagesRootRelative}/${scope}`)
      )
        .filter((name) => SKILL_DIR_NAME.test(name))
        .sort();
      for (const skill of skillNames) {
        const revisionsRelative = `${packagesRootRelative}/${scope}/${skill}/revisions`;
        const revisionsDir = this.canonicalPath(revisionsRelative);
        let revisionsInfo: Awaited<ReturnType<typeof lstat>> | null;
        try {
          revisionsInfo = await this.statOptional(revisionsDir);
        } catch (error) {
          failed++;
          if (errors.length < RECLAIM_ERROR_LIMIT)
            errors.push({
              path: revisionsRelative,
              reason: this.reclaimReason(error),
            });
          continue;
        }
        if (
          !revisionsInfo ||
          !revisionsInfo.isDirectory() ||
          revisionsInfo.isSymbolicLink()
        ) {
          if (revisionsInfo?.isSymbolicLink()) skipped.symlinks++;
          continue;
        }
        const revisionNames = (await listing(revisionsDir, revisionsRelative))
          .filter((name) => REVISION_NAME.test(name))
          .sort();
        for (const revision of revisionNames) {
          const cursorKey = `${scope}/${skill}/${revision}`;
          if (packagesLast && cursorKey <= packagesLast) continue;
          if (budget <= 0) {
            exhausted = false;
            break outer;
          }
          budget--;
          packagesLast = cursorKey;
          const relativePath = `${revisionsRelative}/${revision}`;
          try {
            const outcome = await this.reclaimRevisionEntry(
              tenantId,
              relativePath,
              skill,
              revision,
              graceCutoff,
              now,
            );
            if (outcome === "reclaimed") reclaimedRevisions++;
            else note(outcome);
          } catch (error) {
            failed++;
            if (errors.length < RECLAIM_ERROR_LIMIT)
              errors.push({
                path: `${skill}/revisions/${revision}`,
                reason: this.reclaimReason(error),
              });
          }
        }
      }
    }
    if (exhausted) {
      packagesLast = "";
      packagesCursor = "";
    } else packagesCursor = packagesLast;
    await this.storage.db
      .insertInto("package_scan_state")
      .values({
        tenant_id: tenantId,
        staging_cursor: stagingCursor,
        packages_cursor: packagesCursor,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column("tenant_id").doUpdateSet({
          staging_cursor: stagingCursor,
          packages_cursor: packagesCursor,
          updated_at: now,
        }),
      )
      .execute();
    return {
      reclaimed_staging: reclaimedStaging,
      reclaimed_revisions: reclaimedRevisions,
      skipped,
      failed,
      errors,
      reclaim_complete: stagingWrapped && exhausted,
    };
  }
}
