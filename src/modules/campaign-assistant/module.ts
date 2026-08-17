import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../../config.js';
import { SessionRepository } from './db/session-repository.js';
import { CampaignBriefExtractor } from './openai/extractor.js';
import { assistantErrorHandler, assistantRoutes } from './routes/assistant-routes.js';
import { AssistantService } from './services/assistant-service.js';
import { UmmixClient } from './ummix/ummix-client.js';

export async function registerCampaignAssistant(
  app: FastifyInstance,
  dependencies: { config: AppConfig; pool: Pool },
): Promise<void> {
  const { config, pool } = dependencies;
  const repository = new SessionRepository(pool);
  const ummix = new UmmixClient(config.UMMIX_API_URL);
  const extractor = new CampaignBriefExtractor(config.OPENAI_API_KEY, config.OPENAI_MODEL);
  const assistant = new AssistantService(config, repository, ummix, extractor);

  await app.register(
    async (scoped) => {
      await assistantRoutes(scoped, { config, assistant, ummix });
      scoped.setErrorHandler(assistantErrorHandler);
    },
    { prefix: '/api/campaign-assistant' },
  );
}
