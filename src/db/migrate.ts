import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { env } from '../config/env.js';
import { pool } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both src/db (tsx) and dist/db (compiled): migrations live in <backend>/migrations
const MIGRATIONS_DIR = path.resolve(here, '../../migrations');
const MIGRATION_LOCK_ID = 727_001;

/** Creates the target database when it does not exist yet (developer convenience). */
async function ensureDatabase(): Promise<void> {
  try {
    const client = await pool.connect();
    client.release();
  } catch (error) {
    if ((error as { code?: string }).code !== '3D000') throw error;

    const target = new URL(env.DATABASE_URL);
    const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''));
    target.pathname = '/postgres';

    const admin = new pg.Client({
      connectionString: target.toString(),
      ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
      console.log(`Created database "${databaseName}"`);
    } finally {
      await admin.end();
    }
  }
}

export async function runMigrations(): Promise<void> {
  await ensureDatabase();

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.name));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`Applied migration ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

// Allow `npm run migrate`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations()
    .then(() => {
      console.log('Migrations complete');
      return pool.end();
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
