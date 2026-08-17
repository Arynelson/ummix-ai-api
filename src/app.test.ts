import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import type { AppConfig } from './config.js';

const config: AppConfig = {
  NODE_ENV: 'test',
  PORT: 3010,
  HOST: '127.0.0.1',
  DATABASE_URL: 'postgresql://test',
  UMMIX_API_URL: 'http://ummix.test/api',
  UMMIX_WEB_URL: 'http://ummix.test',
  AI_WEB_ORIGIN: 'http://ai-web.test',
  CAMPAIGN_ASSISTANT_ENABLED: true,
  CAMPAIGN_CONTENT_ENABLED: false,
  AI_HANDOFF_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  AI_HANDOFF_TTL_SECONDS: 60,
  SESSION_TTL_MINUTES: 120,
  MESSAGE_LIMIT_PER_WINDOW: 20,
  MESSAGE_WINDOW_MINUTES: 10,
  OPENAI_MODEL: 'gpt-5.6-luna',
};

describe('platform health', () => {
  it('reports module readiness independently without exposing configuration values', async () => {
    const app = await buildApp(config, {} as Pool);

    try {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: 'ok',
        modules: {
          'campaign-assistant': { enabled: true, status: 'ready' },
          'campaign-content': { enabled: false, status: 'disabled' },
        },
        dependencies: {
          database: 'configured',
          llm: 'not_configured',
        },
      });
      expect(response.body).not.toContain('postgresql://test');
      const routes = app.printRoutes().replace(/[\s│├└─]+/gu, '');
      expect(routes).toContain('api/auth/handoff(POST)');
      expect(routes).toContain('campaign-assistant/auth/handoff/exchange(POST)');
      expect(routes).toContain('/:campaignId/ai-content');
      expect(routes).toContain('generate(POST)');
      expect(routes).toContain('selection(PUT)');
      const disabledContent = await app.inject({
        method: 'GET',
        url: '/api/campaigns/147dad44-1eea-411b-9b5d-1f6467d91712/ai-content',
      });
      expect(disabledContent.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  }, 15_000);

  it('reports database readiness without exposing the database error', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{
          assistant_sessions: 'campaign_assistant.sessions',
          auth_handoffs: 'ai_platform.auth_handoffs',
        }],
      })
      .mockRejectedValueOnce(new Error('password=must-not-leak'));
    const app = await buildApp(config, { query } as unknown as Pool);

    try {
      const ready = await app.inject({ method: 'GET', url: '/ready' });
      const unavailable = await app.inject({ method: 'GET', url: '/ready' });

      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({
        status: 'ready',
        dependencies: { database: 'ready' },
      });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toEqual({
        status: 'not_ready',
        dependencies: { database: 'unavailable' },
      });
      expect(unavailable.body).not.toContain('must-not-leak');
    } finally {
      await app.close();
    }
  }, 15_000);

  it('stays not ready when the database exists but migrations are missing', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ assistant_sessions: null, auth_handoffs: null }],
    });
    const app = await buildApp(config, { query } as unknown as Pool);

    try {
      const response = await app.inject({ method: 'GET', url: '/ready' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: 'not_ready',
        dependencies: { database: 'unavailable' },
      });
      expect(response.body).not.toContain('schema is not migrated');
    } finally {
      await app.close();
    }
  });
});
