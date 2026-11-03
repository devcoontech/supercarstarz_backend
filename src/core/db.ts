import pg from 'pg';
import { config } from './config.js';

// Return int8 (counts, sums) and numeric as numbers; our values are far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

// Supabase serves its own CA chain, so the certificate is not verified against the system store.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
});

export type Q = Pick<pg.PoolClient, 'query'>;

/** Run `fn` in a transaction; rolls back on any thrown error. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
