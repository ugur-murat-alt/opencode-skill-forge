/**
 * AGZ-Memory schema v11 kimlik sabitleri ve parmak izi hesabı.
 *
 * Kaynak: https://github.com/ugur-murat-alt/agz-memory @ 80096ab,
 * dosyalar `src/db/schema.ts` ve `src/hash.ts` (MIT lisansı).
 *
 * `AGZ_EXPECTED_SCHEMA_V11_FINGERPRINT` kaynak kodun kendi
 * `expectedSchemaFingerprint()` fonksiyonuyla 80096ab üzerinde hesaplandı.
 * Envanter, kaynak `agz_meta.schema_fingerprint` değerini hem kayıtlı
 * değerle hem bu sabitle karşılaştırır; bilinmeyen v11 varyantları
 * mutasyonsuz reddedilir.
 */

import { hashTuple, type HashTupleValue } from "./hash.js";
import type { SqliteConnection } from "./sqlite-driver.js";

export const AGZ_PRODUCT_ID = "agz-memory" as const;
export const AGZ_SUPPORTED_SCHEMA_VERSION = 11 as const;
export const AGZ_HASH_POLICY = "hash-tuple/2" as const;
export const AGZ_APPLICATION_ID = 0x41475a4d;

export const AGZ_EXPECTED_SCHEMA_V11_FINGERPRINT =
  "8d63948dcdfd5404a3e555fe9a194866f4c03cb6825dca503063f4797a57a888";

const SQLITE_MANAGED_FTS_TABLES = new Set([
  "notes_fts_config",
  "notes_fts_data",
  "notes_fts_docsize",
  "notes_fts_idx",
]);

export interface SchemaObjectRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

export function computeSchemaFingerprint(
  db: Pick<SqliteConnection, "all">,
): string {
  const rows = db.all<SchemaObjectRow>(
    `SELECT type, name, tbl_name, sql
       FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name`,
  );
  const fields: HashTupleValue[] = [];
  for (const row of rows) {
    fields.push(
      row.type,
      row.name,
      row.tbl_name,
      SQLITE_MANAGED_FTS_TABLES.has(row.name) ? null : row.sql,
    );
  }
  return hashTuple("schema-fingerprint", 2, fields);
}
