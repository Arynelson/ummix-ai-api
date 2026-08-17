import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const requiredEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/ummix_ai',
  UMMIX_API_URL: 'http://localhost:3003/api',
  UMMIX_WEB_URL: 'http://localhost:3000',
  AI_HANDOFF_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('loadConfig', () => {
  it('keeps module flags independent and campaign content disabled by default', () => {
    const config = loadConfig(requiredEnvironment);

    expect(config.CAMPAIGN_ASSISTANT_ENABLED).toBe(true);
    expect(config.CAMPAIGN_CONTENT_ENABLED).toBe(false);
    expect(config.AI_WEB_ORIGIN).toBe('http://localhost:3007');
    expect(config.CAMPAIGN_CONTENT_MIN_WORDS_PER_SECOND).toBe(2.2);
    expect(config.CAMPAIGN_CONTENT_MAX_WORDS_PER_SECOND).toBe(2.6);
  });

  it('treats an empty optional service token as absent', () => {
    expect(loadConfig({
      ...requiredEnvironment,
      UMMIX_SERVICE_TOKEN: '',
    }).UMMIX_SERVICE_TOKEN).toBeUndefined();
  });

  it('rejects a short service token', () => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        UMMIX_SERVICE_TOKEN: 'short',
      }),
    ).toThrow(/UMMIX_SERVICE_TOKEN/);
  });

  it('requires the service token for enabled production integrations', () => {
    expect(() => loadConfig({
      ...requiredEnvironment,
      NODE_ENV: 'production',
    })).toThrow(/UMMIX_SERVICE_TOKEN/);
  });

  it('requires LLM and e-mail credentials when those production features are enabled', () => {
    expect(() => loadConfig({
      ...requiredEnvironment,
      NODE_ENV: 'production',
      UMMIX_SERVICE_TOKEN: 's'.repeat(32),
      CAMPAIGN_CONTENT_ENABLED: 'true',
      CAMPAIGN_CONTENT_EMAIL_ENABLED: 'true',
    })).toThrow(/OPENAI_API_KEY|CAMPAIGN_CONTENT_EMAIL_API_KEY/);
  });

  it('accepts the external production configuration when required credentials exist', () => {
    const config = loadConfig({
      ...requiredEnvironment,
      NODE_ENV: 'production',
      UMMIX_SERVICE_TOKEN: 's'.repeat(32),
      OPENAI_API_KEY: 'openai-test-key',
      CAMPAIGN_CONTENT_ENABLED: 'true',
      CAMPAIGN_CONTENT_EMAIL_ENABLED: 'true',
      CAMPAIGN_CONTENT_EMAIL_API_KEY: 'brevo-test-key',
      CAMPAIGN_CONTENT_EMAIL_FROM: 'falecoma@ummix.com.br',
    });

    expect(config.CAMPAIGN_CONTENT_ENABLED).toBe(true);
    expect(config.CAMPAIGN_CONTENT_EMAIL_ENABLED).toBe(true);
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        AI_HANDOFF_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64'),
      }),
    ).toThrow(/AI_HANDOFF_ENCRYPTION_KEY/);
  });
});
