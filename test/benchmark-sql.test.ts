import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("SQL diagnostics preserve real Node SQLite results, rollback, privacy and connection restoration", async () => {
  const { stdout } = await promisify(execFile)(
    "node",
    [
      "--input-type=module",
      "-e",
      `
    import Database from 'better-sqlite3';
    import {Kysely,SqliteDialect,sql} from 'kysely';
    import {sqliteSampler} from './scripts/benchmark-sql.mjs';
    const db=new Kysely({dialect:new SqliteDialect({database:new Database(':memory:')})});
    await db.schema.createTable('skills').addColumn('id','text',c=>c.primaryKey()).execute();
    let original;
    await db.getExecutor().provideConnection(async c=>{original=c.executeQuery});
    const sampler=await sqliteSampler(db);
    try {
      await db.insertInto('skills').values({id:'PRIVATE_VALUE_123'}).execute();
      let failure=false;
      try {await db.insertInto('skills').values({id:'PRIVATE_VALUE_123'}).execute()} catch {failure=true}
      try {await db.transaction().execute(async tx=>{
        await tx.insertInto('skills').values({id:'rolled-back'}).execute();
        throw new Error('rollback');
      })} catch {}
      const rows=await db.selectFrom('skills').selectAll().execute();
      const first=sampler.sample(),reset=sampler.sample();
      for(let i=0;i<270;i++) await sql.raw('select '+i).execute(db);
      const bounded=sampler.totals();
      sampler.close();
      let restored=false;
      await db.getExecutor().provideConnection(async c=>{restored=c.executeQuery===original});
      await db.selectFrom('skills').selectAll().execute();
      console.log(JSON.stringify({failure,rows,first,reset,bounded,restored,after:sampler.totals()}));
    } finally {sampler.close();await db.destroy()}
  `,
    ],
    { timeout: 10000 },
  );
  const result = JSON.parse(stdout);
  expect(result.failure).toBe(true);
  expect(result.rows).toEqual([{ id: "PRIVATE_VALUE_123" }]);
  const writes = result.first.find(
    (row: { operation: string }) => row.operation === "insert",
  );
  expect(writes).toMatchObject({ table: "skills", calls: 3, errors: 1 });
  expect(writes.synchronous_ms).toBeGreaterThan(0);
  expect(
    result.first.some(
      (row: { operation: string }) => row.operation === "rollback",
    ),
  ).toBe(true);
  expect(result.reset).toEqual([]);
  expect(result.bounded.length).toBeLessThanOrEqual(257);
  expect(
    result.bounded.some(
      (row: { fingerprint: string }) => row.fingerprint === "overflow",
    ),
  ).toBe(true);
  expect(JSON.stringify(result.first)).not.toContain("PRIVATE_VALUE_123");
  expect(result.restored).toBe(true);
  expect(result.after).toEqual(result.bounded);
});
