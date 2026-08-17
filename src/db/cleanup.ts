import { loadConfig } from '../config.js';
import { createPool } from './pool.js';
import { SessionRepository } from '../modules/campaign-assistant/db/session-repository.js';
import { PostgresHandoffRepository } from '../modules/platform-auth/handoff-repository.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const repository = new SessionRepository(pool);
const handoffs = new PostgresHandoffRepository(pool);

try {
  const [assistant, expiredHandoffs] = await Promise.all([
    repository.expireAndPurge(),
    handoffs.purgeExpired(),
  ]);
  process.stdout.write(`${JSON.stringify({ ...assistant, expiredHandoffs })}\n`);
} finally {
  await pool.end();
}
