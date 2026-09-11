/**
 * Küçük SQLite sürücü adaptörü.
 *
 * Bun çalışırken `bun:sqlite`, Node çalışırken `better-sqlite3` kullanılır.
 * Kaynak AGZ veritabanı yalnız `readonly` açılır ve ek olarak SQLite
 * seviyesinde `PRAGMA query_only=ON` uygulanır. Yazma engeli JavaScript
 * tarafında taklit edilmez; gerçek güvence sürücünün salt-okunur açma
 * modudur (`SQLITE_READONLY`).
 */

import { existsSync } from "node:fs";

export type SqliteDriverName = "bun:sqlite" | "better-sqlite3";

export type SqlValue = null | string | number | bigint | Uint8Array | boolean;

export interface SqliteConnection {
  readonly driver: SqliteDriverName;
  readonly path: string;
  readonly readonly: boolean;
  all<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly SqlValue[],
  ): Row[];
  get<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly SqlValue[],
  ): Row | undefined;
  /** Çok ifadeli SQL çalıştırır; salt-okunur bağlantıda yazma SQLite'ta reddedilir. */
  exec(sql: string): void;
  close(): void;
}

export interface WritableSqliteConnection extends SqliteConnection {
  readonly readonly: false;
  run(sql: string, params?: readonly SqlValue[]): void;
}

interface NativeStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface NativeDatabase {
  prepare(sql: string): NativeStatement;
  exec(sql: string): void;
  close(): void;
}

export async function openReadOnlySqlite(
  path: string,
): Promise<SqliteConnection> {
  if (!existsSync(path)) {
    throw new Error(`sqlite file does not exist: ${path}`);
  }
  const { driver, native } = await openNative(path, true);
  try {
    // Salt-okunurluk açma modundan gelir; query_only ikinci bir SQL kapısıdır
    // ve onun yerine geçmez. Yazma denemesi SQLite tarafından reddedilir.
    native.exec("PRAGMA query_only=ON");
    native.exec("PRAGMA busy_timeout=5000");
    return connection(native, driver, path, true);
  } catch (error) {
    native.close();
    throw error;
  }
}

export async function openWritableSqlite(
  path: string,
): Promise<WritableSqliteConnection> {
  const { driver, native } = await openNative(path, false);
  try {
    native.exec("PRAGMA busy_timeout=5000");
    const base = connection(native, driver, path, false);
    return {
      ...base,
      readonly: false,
      run: (sql, params) => {
        native.prepare(sql).run(...normalizeParams(params));
      },
    };
  } catch (error) {
    native.close();
    throw error;
  }
}

function connection(
  native: NativeDatabase,
  driver: SqliteDriverName,
  path: string,
  readonly: boolean,
): SqliteConnection {
  return {
    driver,
    path,
    readonly,
    all<Row = Record<string, unknown>>(
      sql: string,
      params?: readonly SqlValue[],
    ): Row[] {
      return native.prepare(sql).all(...normalizeParams(params)) as Row[];
    },
    get<Row = Record<string, unknown>>(
      sql: string,
      params?: readonly SqlValue[],
    ): Row | undefined {
      return normalizeRow(
        native.prepare(sql).get(...normalizeParams(params)),
      ) as Row | undefined;
    },
    exec: (sql) => native.exec(sql),
    close: () => native.close(),
  };
}

async function openNative(
  path: string,
  readonly: boolean,
): Promise<{ driver: SqliteDriverName; native: NativeDatabase }> {
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite");
    const native = readonly
      ? new Database(path, { readonly: true })
      : new Database(path, { create: true });
    return {
      driver: "bun:sqlite",
      native: native as unknown as NativeDatabase,
    };
  }
  const { default: Database } = await import("better-sqlite3");
  const native = readonly
    ? new Database(path, { readonly: true, fileMustExist: true })
    : new Database(path);
  return {
    driver: "better-sqlite3",
    native: native as unknown as NativeDatabase,
  };
}

function normalizeParams(params: readonly SqlValue[] | undefined): unknown[] {
  if (!params) return [];
  return params.map((value) =>
    typeof value === "boolean" ? (value ? 1 : 0) : value,
  );
}

function normalizeRow(row: unknown): unknown {
  return row === null || row === undefined ? undefined : row;
}
