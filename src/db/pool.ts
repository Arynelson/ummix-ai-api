import pg from 'pg';

const { Pool } = pg;

export function createPool(connectionString: string): pg.Pool {
  const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false';
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl:
      process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized }
        : undefined,
  });
}
