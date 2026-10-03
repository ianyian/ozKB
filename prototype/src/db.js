// Database access. Uses Neon (or any Postgres) when DATABASE_URL is set,
// otherwise an embedded Postgres (PGlite) stored under ./.data for local runs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

let impl = null;
export let dbKind = "none";

export async function initDb() {
  if (impl) return impl;
  if (process.env.DATABASE_URL) {
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX || 5) });
    impl = {
      query: (sql, params) => pool.query(sql, params),
      exec: (sql) => pool.query(sql),
      close: () => pool.end(),
    };
    dbKind = "postgres";
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = path.join(process.env.DATA_DIR || path.join(ROOT, ".data"), "pglite");
    fs.mkdirSync(dir, { recursive: true });
    const db = new PGlite(dir);
    await db.waitReady;
    impl = {
      query: (sql, params) => db.query(sql, params),
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
    };
    dbKind = "pglite";
  }
  await impl.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
  return impl;
}

export async function q(sql, params = []) {
  const r = await impl.query(sql, params);
  return r.rows;
}
export async function one(sql, params = []) {
  return (await q(sql, params))[0] || null;
}
export async function exec(sql) {
  return impl.exec(sql);
}
