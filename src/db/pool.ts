import pg from 'pg';
import { env } from '../config/env.js';

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error.message);
});

export function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) {
  return pool.query<T>(text, params);
}
