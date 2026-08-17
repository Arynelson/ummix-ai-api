import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { CampaignContentRepository } from './modules/campaign-content/db/content-repository.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
if (config.CAMPAIGN_CONTENT_ENABLED) {
  const recovery = await new CampaignContentRepository(pool).recoverStaleOperations();
  if (recovery.generations > 0 || recovery.emails > 0) {
    process.stdout.write(`Recuperadas operacoes pendentes: ${JSON.stringify(recovery)}\n`);
  }
}
const app = await buildApp(config, pool);

const shutdown = async () => {
  await app.close();
  await pool.end();
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ port: config.PORT, host: config.HOST });
