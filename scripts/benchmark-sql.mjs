import { createHash } from "node:crypto";

/** Instrument only the owned SQLite connection. Never record SQL text or parameters. */
export async function sqliteSampler(db) {
  const limit = 256,
    signatures = new Map();
  const tables = new Set(
    "skills skill_revisions skill_observations revision_readers tenants users memberships projects project_members project_bindings auth_sessions audit_events".split(
      " ",
    ),
  );
  const totals = new Map();
  let window = new Map();
  function signature(sql) {
    let value = signatures.get(sql);
    if (value) return value;
    if (signatures.size >= limit)
      return { fingerprint: "overflow", operation: "other", table: "other" };
    value = {
      fingerprint: createHash("sha256").update(sql).digest("hex"),
      operation:
        /^(select|insert|update|delete|begin|commit|rollback|pragma)\b/i
          .exec(sql.trim())?.[1]
          .toLowerCase() ?? "other",
    };
    const table = /\b(?:from|into|update)\s+["`]?([a-z_]+)/i
      .exec(sql)?.[1]
      ?.toLowerCase();
    value.table = tables.has(table) ? table : "other";
    signatures.set(sql, value);
    return value;
  }
  function record(key, elapsed, failed) {
    for (const map of [totals, window]) {
      let row = map.get(key.fingerprint);
      if (!row) {
        row = {
          ...key,
          calls: 0,
          errors: 0,
          synchronous_ms: 0,
          max_synchronous_ms: 0,
        };
        map.set(key.fingerprint, row);
      }
      row.calls++;
      row.errors += failed ? 1 : 0;
      row.synchronous_ms += elapsed;
      row.max_synchronous_ms = Math.max(row.max_synchronous_ms, elapsed);
    }
  }
  let connection, original, wrapper;
  await db.getExecutor().provideConnection(async (value) => {
    connection = value;
    original = value.executeQuery;
    wrapper = function (query) {
      const key = signature(query.sql),
        start = performance.now();
      let result;
      try {
        result = Reflect.apply(original, this, [query]);
      } catch (error) {
        record(key, performance.now() - start, true);
        throw error;
      }
      // Kysely's locked SQLite driver executes prepare/all/run synchronously before returning its Promise.
      // Exclude later promise/connection-queue waits from this duration.
      const elapsed = performance.now() - start;
      return Promise.resolve(result).then(
        (value) => {
          record(key, elapsed, false);
          return value;
        },
        (error) => {
          record(key, elapsed, true);
          throw error;
        },
      );
    };
    value.executeQuery = wrapper;
  });
  function snapshot(map) {
    return [...map.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) => b.synchronous_ms - a.synchronous_ms);
  }
  return {
    sample() {
      const result = snapshot(window);
      window = new Map();
      return result;
    },
    totals() {
      return snapshot(totals);
    },
    close() {
      if (connection.executeQuery === wrapper)
        connection.executeQuery = original;
    },
  };
}
