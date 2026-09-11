/**
 * Bağımsız M02 kesinti çocuğu (probe, üretim kodu değil).
 *
 * Ortam değişkenleriyle verilen olayı commit eder; `MARKER` noktasında
 * (PUBLISHED = dosya yayını sonrası/DB öncesi, COMMITTED = DB sonrası/indeks
 * öncesi) tek satır yazıp sonsuza kadar bekler; ebeveyn onu SIGKILL eder.
 * Kilit gerçekten çocuğa aittir; hook yalnız kesinti noktasını sabitler.
 */
import { openDatabase } from "../../../src/storage/database.js";
import { MemoryService } from "../../../src/memory/service.js";
import { MemoryCommitService } from "../../../src/memory/commit.js";
import { VaultWriter } from "../../../src/memory/writer.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
};

const storage = await openDatabase({
  dataDir: required("DATA_DIR"),
  postgresUrl: process.env.POSTGRES_URL || undefined,
});
try {
  const service = new MemoryService(storage.db, undefined, required("VAULT"));
  const marker = required("MARKER");
  const hooks =
    marker === "PUBLISHED"
      ? {
          afterPublish: async () => {
            console.log("PUBLISHED");
            await new Promise(() => {});
          },
        }
      : {
          afterCommitBeforeIndex: async () => {
            console.log("COMMITTED");
            await new Promise(() => {});
          },
        };
  const commits = new MemoryCommitService({
    db: storage.db,
    vaultRoot: required("VAULT"),
    service,
    hooks,
    writer: new VaultWriter(required("VAULT"), { leaseMs: 300 }),
  });
  await commits.commit({
    identity: {
      tenantId: required("TENANT"),
      userId: required("USER"),
    },
    spaceId: required("SPACE"),
    eventId: required("EVENT"),
    sourceKind: "manual",
    content: Buffer.from(required("CONTENT_B64"), "base64").toString("utf8"),
    baseRevision: process.env.BASE_REVISION
      ? Number(process.env.BASE_REVISION)
      : null,
  });
} finally {
  await storage.close();
}
