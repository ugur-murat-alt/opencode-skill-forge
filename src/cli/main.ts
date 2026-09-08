#!/usr/bin/env node
import { backupPostgres, restorePostgres } from "../backup/postgres.js";
import { backupSqlite, restoreSqlite } from "../backup/sqlite.js";
import { remoteMigrationUpload } from "../migration/remote.js";
import { importDiscovery, readMigrationJson } from "../migration/batch.js";
import { MigrationImporter } from "../migration/importer.js";
import { PackageStore } from "../skills/store.js";
import { SettingsService } from "../application/settings.js";
import { DockerExecutor } from "../execution/docker.js";
import { discoverLegacy } from "../migration/discover.js";
import { writeFile, realpath } from "node:fs/promises";
import {
  installClient,
  uninstallClient,
  installationFingerprint,
} from "../clients/installer.js";
import { clientHook, readHookInput } from "../clients/hook.js";
import { openDatabase } from "../storage/database.js";
import { SecretVault } from "../storage/secrets.js";
import { JobQueue } from "../jobs/queue.js";
import { ForgeWorker } from "../jobs/worker.js";
import { productionHandler } from "../runner/handler.js";
import { IdentityService } from "../application/identity.js";
import { ensureDefaultEnvironment } from "../application/environments.js";
import { parseArgs } from "node:util";
import {
  resolve,
  dirname,
  basename,
  relative,
  isAbsolute,
  sep,
} from "node:path";
import { localConfig, PRODUCT_VERSION } from "./config.js";
import { serve } from "../http/server.js";
import { ensureDaemon, daemonHealth, stopDaemon } from "./daemon.js";
import { bridge } from "../mcp/bridge.js";
import { errorEnvelope, ForgeError } from "../domain/errors.js";
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "database-name": { type: "string" },
      "data-dir": { type: "string" },
      "server-url": { type: "string" },
      "legacy-home": { type: "string" },
      "scan-limit": { type: "string" },
      output: { type: "string" },
      manifest: { type: "string" },
      mapping: { type: "string" },
      receipt: { type: "string" },
      port: { type: "string" },
      client: { type: "string" },
      "project-ref": { type: "string" },
      "tenant-id": { type: "string" },
      "tenant-name": { type: "string" },
      subject: { type: "string" },
      "display-name": { type: "string" },
      project: { type: "string" },
      version: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.version) {
    process.stdout.write(`${PRODUCT_VERSION}\n`);
    return;
  }
  if (values.help || !positionals.length) {
    process.stdout.write(
      "Skill Forge\n  backup / restore --data-dir <kaynak> --output <yeni-dizin>  SQLite/PostgreSQL yedekleme\n  serve   Yerel kimlikli HTTP/MCP servisi\n  stop    Yerel servisi kimlikli ve kontrollü durdur\n  worker  Ayrı süreçte kalıcı iş tüketicisi\n  mcp     Bağımsız servise stdio köprüsü (gerekiyorsa başlatır)\n  install / uninstall  Projeye Codex veya Claude resmi MCP/hook kurulumu\n  login   Tek kullanımlık web giriş kodu\n  doctor  Servis kimliği/sürüm/sağlık kontrolü\n  migration-scan --project <dizin>  Eski veriyi salt okunur keşfet\n  migration-import --manifest <json> --mapping <json>  Seçilen paketleri aktar\n  migration-rollback --receipt <id>  Değişmemiş aktarımı geri al\n  migration-upload --server-url <origin> --tenant-id <id> --manifest <json> --mapping <json>  Uzak aktarım\n  --data-dir <dizin> --port <port>\n",
    );
    return;
  }
  if (positionals[0] === "migration-scan") {
    if (!values.project)
      throw new ForgeError(
        "project_required",
        "Salt okunur keşif için --project gerekiyor.",
      );
    const report = await discoverLegacy({
      projectRoot: values.project,
      home: values["legacy-home"],
      maxEntries: values["scan-limit"]
        ? Number(values["scan-limit"])
        : undefined,
    });
    if (values.output) {
      const requested = resolve(values.output);
      const output = resolve(
        await realpath(dirname(requested)),
        basename(requested),
      );
      for (const root of report.roots) {
        let source = root.path;
        try {
          source = await realpath(source);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const path = relative(source, output);
        if (
          !path ||
          (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
        )
          throw new ForgeError(
            "source_write_denied",
            "Manifest kaynak veri alanına yazılamaz.",
          );
      }
      await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      process.stdout.write(
        JSON.stringify({
          manifest: output,
          items: report.items.length,
          truncated: report.truncated,
          checksum: report.checksum,
        }) + "\n",
      );
    } else process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  if (positionals[0] === "migration-upload") {
    if (
      !values["server-url"] ||
      !values["tenant-id"] ||
      !values.manifest ||
      !values.mapping
    )
      throw new ForgeError(
        "migration_arguments",
        "--server-url, --tenant-id, --manifest ve --mapping gerekiyor.",
      );
    const upload = remoteMigrationUpload(
      values["server-url"],
      values["tenant-id"],
      process.env.SKILL_FORGE_REMOTE_TOKEN ?? "",
    );
    const report = await importDiscovery(
      undefined,
      undefined,
      await readMigrationJson(values.manifest),
      await readMigrationJson(values.mapping),
      upload,
    );
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (report.failed) process.exitCode = 1;
    return;
  }
  if (positionals[0] === "backup" || positionals[0] === "restore") {
    if (!values["data-dir"] || !values.output)
      throw new ForgeError(
        "backup_paths_required",
        "--data-dir kaynak ve --output yeni hedef dizin gerekiyor.",
      );
    const url = process.env.SKILL_FORGE_POSTGRES_URL;
    if (url && positionals[0] === "restore" && !values["database-name"])
      throw new ForgeError(
        "database_name_required",
        "Restore için --database-name yeni DB adı gerekiyor.",
      );
    const report = url
      ? positionals[0] === "backup"
        ? await backupPostgres(values["data-dir"], values.output, url)
        : await restorePostgres(
            values["data-dir"],
            values.output,
            url,
            values["database-name"]!,
          )
      : await (positionals[0] === "backup" ? backupSqlite : restoreSqlite)(
          values["data-dir"],
          values.output,
        );
    process.stdout.write(JSON.stringify(report) + "\n");
    return;
  }
  const config = await localConfig(
    values["data-dir"],
    values.port === undefined ? undefined : Number(values.port),
  );
  switch (positionals[0]) {
    case "migration-import":
    case "migration-rollback": {
      if (config.profile === "server")
        throw new ForgeError(
          "local_identity_required",
          "Bu komut yerel cihaz sahibinin aktarımı içindir; server kimliği taklit edilemez.",
          403,
        );
      const rollback = positionals[0] === "migration-rollback";
      if (
        rollback
          ? !/^[a-f0-9]{64}$/.test(values.receipt ?? "")
          : !values.manifest || !values.mapping
      )
        throw new ForgeError(
          "migration_arguments",
          "Aktarım için --manifest ve --mapping; geri alma için --receipt gerekiyor.",
        );
      const manifest = rollback
        ? undefined
        : await readMigrationJson(values.manifest!);
      const mapping = rollback
        ? undefined
        : await readMigrationJson(values.mapping!);
      const storage = await openDatabase({ dataDir: config.dataDir });
      try {
        const identities = new IdentityService(storage.db),
          actor = await identities.bootstrapLocal(),
          settings = new SettingsService(identities, config.policy);
        const importer = new MigrationImporter(
          new PackageStore(storage, config.dataDir, async (path, manifest) => {
            const project = (mapping as { project_ref?: string } | undefined)
              ?.project_ref;
            const effective = await settings.effective(actor, project);
            return new DockerExecutor(config.dataDir, {
              trustScope: `${actor.tenantId}:${actor.userId}`,
              allowDependencyInstall: effective.values.dependencyInstall,
              allowedOrigins: effective.values.scriptAllowedOrigins,
            }).validate(path, manifest);
          }),
        );
        if (rollback)
          process.stdout.write(
            JSON.stringify(await importer.rollback(actor, values.receipt!)) +
              "\n",
          );
        else {
          const report = await importDiscovery(
            importer,
            actor,
            manifest,
            mapping,
          );
          process.stdout.write(JSON.stringify(report, null, 2) + "\n");
          if (report.failed) process.exitCode = 1;
        }
      } finally {
        await storage.close();
      }
      break;
    }
    case "serve": {
      const app = await serve(config);
      process.stderr.write(`Skill Forge ${PRODUCT_VERSION}: ${config.url}\n`);
      let closing = false;
      const close = () => {
        if (!closing) {
          closing = true;
          void app.close().then(() => {
            process.exitCode = 0;
          });
        }
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
      break;
    }
    case "bootstrap-server": {
      if (
        config.profile !== "server" ||
        !values["tenant-id"] ||
        !values["tenant-name"] ||
        !values.subject ||
        !values["display-name"]
      )
        throw new ForgeError(
          "bootstrap_arguments",
          "Server profilinde --tenant-id, --tenant-name, --subject issuer|sub ve --display-name gerekiyor.",
        );
      const storage = await openDatabase({
        dataDir: config.dataDir,
        postgresUrl: config.postgresUrl,
      });
      try {
        const result = await storage.db.transaction().execute(async (tx) => {
          const tenantId = values["tenant-id"]!,
            now = Date.now();
          await tx
            .insertInto("tenants")
            .values({
              id: tenantId,
              name: values["tenant-name"]!,
              created_at: now,
            })
            .onConflict((oc) => oc.column("id").doNothing())
            .execute();
          await tx
            .insertInto("users")
            .values({
              id: crypto.randomUUID(),
              subject: values.subject!,
              display_name: values["display-name"]!,
              created_at: now,
            })
            .onConflict((oc) => oc.column("subject").doNothing())
            .execute();
          const user = await tx
            .selectFrom("users")
            .select("id")
            .where("subject", "=", values.subject!)
            .executeTakeFirstOrThrow();
          await tx
            .insertInto("memberships")
            .values({ tenant_id: tenantId, user_id: user.id, role: "founder" })
            .onConflict((oc) =>
              oc.columns(["tenant_id", "user_id"]).doNothing(),
            )
            .execute();
          await ensureDefaultEnvironment(tx, tenantId);
          return {
            tenant_id: tenantId,
            user_id: user.id,
            status: "configured",
          };
        });
        process.stdout.write(JSON.stringify(result) + "\n");
      } finally {
        await storage.close();
      }
      break;
    }
    case "hook": {
      if (
        !["codex", "claude"].includes(values.client ?? "") ||
        !values["project-ref"]
      ) {
        process.stdout.write("{}\n");
        return;
      }
      process.stdout.write(
        JSON.stringify(
          await clientHook(
            config,
            resolve(process.argv[1]!),
            values.client as "codex" | "claude",
            values["project-ref"],
            await readHookInput(process.stdin),
          ),
        ) + "\n",
      );
      break;
    }
    case "install":
    case "uninstall": {
      if (!["codex", "claude"].includes(values.client ?? "") || !values.project)
        throw new ForgeError(
          "installation_arguments",
          "--client codex|claude ve --project mutlak/yetkili proje dizini gerekiyor.",
        );
      const client = values.client as "codex" | "claude";
      if (positionals[0] === "uninstall") {
        process.stdout.write(
          JSON.stringify(
            await uninstallClient(client, values.project, config.dataDir),
          ) + "\n",
        );
        break;
      }
      if (!values["project-ref"])
        throw new ForgeError(
          "project_required",
          "Kurulum açık --project-ref gerektirir.",
        );
      await ensureDaemon(config, resolve(process.argv[1]!));
      const check = await fetch(
        `${config.url}/api/settings/effective?project_ref=${encodeURIComponent(values["project-ref"])}`,
        { headers: { authorization: `Bearer ${config.token}` } },
      );
      if (!check.ok)
        throw new ForgeError(
          "project_unavailable",
          "Kurulum projesi servis tarafından doğrulanamadı.",
          403,
        );
      const installed = await installClient({
        client,
        projectRoot: values.project,
        projectRef: values["project-ref"],
        dataDir: config.dataDir,
        entry: resolve(process.argv[1]!),
        port: config.port,
      });
      const registration = await fetch(`${config.url}/api/installations`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: installationFingerprint([client, resolve(values.project)]),
          project_ref: values["project-ref"],
          client,
          directory: resolve(values.project),
          event: "installed",
        }),
      });
      if (!registration.ok)
        throw new ForgeError(
          "installation_registration_failed",
          "Dosyalar kuruldu; servis kaydı başarısız. Aynı install komutu güvenle tekrarlanabilir.",
        );
      process.stdout.write(JSON.stringify(installed) + "\n");
      break;
    }
    case "worker": {
      const storage = await openDatabase({
        dataDir: config.dataDir,
        postgresUrl: config.postgresUrl,
      });
      if (config.profile !== "server")
        await new IdentityService(storage.db).bootstrapLocal();
      const vault = await SecretVault.open(config.dataDir);
      const worker = new ForgeWorker(
        new JobQueue(storage, config.policy),
        productionHandler(
          storage,
          config.dataDir,
          vault,
          config.profile !== "server",
        ),
        { postgresUrl: config.postgresUrl },
      );
      await worker.start();
      process.stderr.write("Skill Forge worker hazır\n");
      let closing = false;
      const close = () => {
        if (!closing) {
          closing = true;
          void worker
            .stop()
            .then(() => storage.close())
            .then(() => {
              process.exitCode = 0;
            });
        }
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
      break;
    }
    case "mcp":
      await ensureDaemon(config, resolve(process.argv[1]!));
      await bridge(config);
      break;
    case "login": {
      await ensureDaemon(config, resolve(process.argv[1]!));
      const response = await fetch(`${config.url}/api/pairing`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}` },
      });
      if (!response.ok)
        throw new ForgeError("pairing_failed", "Giriş kodu oluşturulamadı.");
      const value = (await response.json()) as { code: string };
      process.stdout.write(
        `${config.url}\nEşleme kodu (5 dakika, tek kullanım): ${value.code}\n`,
      );
      break;
    }
    case "stop": {
      process.stdout.write(JSON.stringify(await stopDaemon(config)) + "\n");
      break;
    }
    case "doctor": {
      const healthy = await daemonHealth(config);
      process.stdout.write(
        JSON.stringify({
          service: "skill-forge",
          version: PRODUCT_VERSION,
          status: healthy ? "healthy" : "unavailable",
          dataDir: config.dataDir,
          url: config.url,
        }) + "\n",
      );
      if (!healthy) process.exitCode = 1;
      break;
    }
    default:
      throw new ForgeError(
        "unknown_command",
        `Bilinmeyen komut: ${positionals[0]}`,
      );
  }
}
main().catch((error: unknown) => {
  process.stderr.write(JSON.stringify(errorEnvelope(error)) + "\n");
  process.exitCode = 1;
});
