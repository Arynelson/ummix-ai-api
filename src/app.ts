import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { AiPlatformHealth, AiPlatformReadiness } from '@ummix/ai-contracts';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from './config.js';
import { registerCampaignAssistant } from './modules/campaign-assistant/module.js';
import { registerCampaignContent } from './modules/campaign-content/module.js';
import { getCampaignContentModuleStatus } from './modules/campaign-content/module-status.js';
import { registerPlatformAuth } from './modules/platform-auth/module.js';

export async function buildApp(config: AppConfig, pool: Pool) {
  const campaignContentDependenciesConfigured = Boolean(
    config.OPENAI_API_KEY
      && config.UMMIX_SERVICE_TOKEN
      && (!config.CAMPAIGN_CONTENT_EMAIL_ENABLED
        || (config.CAMPAIGN_CONTENT_EMAIL_API_KEY && config.CAMPAIGN_CONTENT_EMAIL_FROM)),
  );
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'headers.authorization'],
    },
    bodyLimit: 32 * 1024,
  });

  await app.register(helmet);
  await app.register(cors, {
    origin: [config.AI_WEB_ORIGIN, config.UMMIX_WEB_URL],
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.get('/health', async (): Promise<AiPlatformHealth> => ({
    status: 'ok',
    modules: {
      'campaign-assistant': {
        enabled: config.CAMPAIGN_ASSISTANT_ENABLED,
        status: config.CAMPAIGN_ASSISTANT_ENABLED ? 'ready' : 'disabled',
      },
      'campaign-content': {
        enabled: config.CAMPAIGN_CONTENT_ENABLED,
        status: getCampaignContentModuleStatus(
          config.CAMPAIGN_CONTENT_ENABLED,
          campaignContentDependenciesConfigured,
        ),
      },
    },
    dependencies: {
      database: 'configured',
      llm: config.OPENAI_API_KEY ? 'configured' : 'not_configured',
    },
  }));

  app.get('/ready', async (_request, reply): Promise<AiPlatformReadiness> => {
    try {
      const result = await pool.query(`
        SELECT
          to_regclass('campaign_assistant.sessions') AS assistant_sessions,
          to_regclass('ai_platform.auth_handoffs') AS auth_handoffs,
          to_regclass('campaign_content.sessions') AS content_sessions,
          to_regclass('campaign_content.messages') AS content_messages,
          to_regclass('campaign_content.contents') AS content_contents
      `);
      const requiredTables = [
        result.rows[0]?.assistant_sessions,
        result.rows[0]?.auth_handoffs,
        ...(config.CAMPAIGN_CONTENT_ENABLED
          ? [
              result.rows[0]?.content_sessions,
              result.rows[0]?.content_messages,
              result.rows[0]?.content_contents,
            ]
          : []),
      ];
      if (requiredTables.some((table) => !table)) {
        throw new Error('database schema is not migrated');
      }
      return {
        status: 'ready',
        dependencies: { database: 'ready' },
      };
    } catch {
      reply.code(503);
      return {
        status: 'not_ready',
        dependencies: { database: 'unavailable' },
      };
    }
  });

  await registerPlatformAuth(app, { config, pool });
  await registerCampaignAssistant(app, { config, pool });
  await registerCampaignContent(app, { config, pool });
  return app;
}
