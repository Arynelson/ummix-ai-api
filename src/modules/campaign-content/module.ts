import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../../config.js';
import { UmmixClient } from '../campaign-assistant/ummix/ummix-client.js';
import { CampaignContentSessionRepository } from './db/session-repository.js';
import { CampaignContentRepository } from './db/content-repository.js';
import { CampaignContentLengthPolicyService } from './domain/length-policy.js';
import { CampaignContentGenerator } from './openai/content-generator.js';
import {
  campaignContentErrorHandler,
  campaignContentRoutes,
} from './routes/campaign-content-routes.js';
import { CampaignContentService } from './services/campaign-content-service.js';
import { CampaignContentContextClient } from './ummix/context-client.js';
import { CampaignContentEmailProvider } from './email/campaign-content-email-provider.js';

export async function registerCampaignContent(
  app: FastifyInstance,
  dependencies: { config: AppConfig; pool: Pool },
): Promise<void> {
  const { config, pool } = dependencies;
  const lengthPolicy = new CampaignContentLengthPolicyService({
    version: config.CAMPAIGN_CONTENT_LENGTH_POLICY_VERSION,
    minWordsPerSecond: config.CAMPAIGN_CONTENT_MIN_WORDS_PER_SECOND,
    maxWordsPerSecond: config.CAMPAIGN_CONTENT_MAX_WORDS_PER_SECOND,
  });
  const service = new CampaignContentService(
    config,
    new CampaignContentSessionRepository(pool),
    new CampaignContentContextClient(config.UMMIX_API_URL, config.UMMIX_SERVICE_TOKEN),
    new CampaignContentRepository(pool),
    new CampaignContentGenerator(config.OPENAI_API_KEY, config.OPENAI_MODEL),
    lengthPolicy,
    new CampaignContentEmailProvider(config),
  );
  const ummix = new UmmixClient(config.UMMIX_API_URL);

  await app.register(
    async (scoped) => {
      await campaignContentRoutes(scoped, { config, service, ummix });
      scoped.setErrorHandler(campaignContentErrorHandler);
    },
    { prefix: '/api/campaigns/:campaignId/ai-content' },
  );
}
