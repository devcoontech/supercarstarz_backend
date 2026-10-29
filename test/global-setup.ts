import 'dotenv/config';

export default async function setup() {
  process.env.NODE_ENV = 'test';
  const url = process.env.TEST_DATABASE_URL ?? '';
  if (!url.includes('_test')) throw new Error('Refusing to run tests: TEST_DATABASE_URL must point at a database whose name contains "_test"');
  const { migrate } = await import('../src/migrate.js');
  const { pool } = await import('../src/db.js');
  await migrate(false);
  await pool.end();
}
