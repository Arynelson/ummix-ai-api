import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createPool } from './pool.js';

const direction = process.argv[2] === 'down' ? 'down' : 'up';
const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('ummix_ai_platform_migrations'))");
    if (direction === 'up') {
      const files = (await readdir(migrationsDirectory))
        .filter((file) => file.endsWith('_up.sql'))
        .sort();
      for (const file of files) {
        const exists = await client.query(
          `SELECT to_regclass('ai_platform.schema_migrations') AS migration_table`,
        );
        if (exists.rows[0]?.migration_table) {
          const applied = await client.query(
            'SELECT 1 FROM ai_platform.schema_migrations WHERE filename = $1',
            [file],
          );
          if ((applied.rowCount ?? 0) > 0) continue;
        }
        await client.query(await readFile(join(migrationsDirectory, file), 'utf8'));
        await client.query(
          `INSERT INTO ai_platform.schema_migrations (filename)
           VALUES ($1) ON CONFLICT (filename) DO NOTHING`,
          [file],
        );
        process.stdout.write(`Aplicada: ${file}\n`);
      }
      return;
    }

    const files = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith('_down.sql'))
      .sort()
      .reverse();
    const file = files[0];
    if (!file) throw new Error('Nenhuma migration reversível encontrada');
    await client.query(await readFile(join(migrationsDirectory, file), 'utf8'));
    const migrationTable = await client.query<{ migration_table: string | null }>(
      `SELECT to_regclass('ai_platform.schema_migrations') AS migration_table`,
    );
    if (migrationTable.rows[0]?.migration_table) {
      const upFilename = file.replace(/_down\.sql$/u, '_up.sql');
      await client.query(
        'DELETE FROM ai_platform.schema_migrations WHERE filename = $1',
        [upFilename],
      );
    }
    process.stdout.write(`Revertida: ${file}\n`);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('ummix_ai_platform_migrations'))")
      .catch(() => undefined);
    client.release();
    await pool.end();
  }
}

await migrate();
