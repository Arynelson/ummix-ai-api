import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../config.js';
import type { AssistantSession } from '../domain/types.js';
import { AssistantService } from './assistant-service.js';

const config: AppConfig = {
  NODE_ENV: 'test',
  PORT: 3010,
  HOST: '127.0.0.1',
  DATABASE_URL: 'postgresql://test',
  UMMIX_API_URL: 'http://ummix.test/api',
  UMMIX_WEB_URL: 'http://ummix.test',
  AI_WEB_ORIGIN: 'http://assistant.test',
  CAMPAIGN_ASSISTANT_ENABLED: true,
  CAMPAIGN_CONTENT_ENABLED: false,
  AI_HANDOFF_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  AI_HANDOFF_TTL_SECONDS: 60,
  SESSION_TTL_MINUTES: 120,
  MESSAGE_LIMIT_PER_WINDOW: 20,
  MESSAGE_WINDOW_MINUTES: 10,
  OPENAI_MODEL: 'gpt-5.6-sol',
};

describe('AssistantService finalization', () => {
  it('returns the same campaign without creating a second draft', async () => {
    const completedSession = {
      id: '93203443-1fe8-45d0-a90d-8ec96ba8042f',
      userId: '856918db-6f3d-4375-a95c-715177012cca',
      status: 'completed',
      finalizedCampaignId: '147dad44-1eea-411b-9b5d-1f6467d91712',
    } as AssistantSession;
    const repository = {
      findOwned: vi.fn().mockResolvedValue(completedSession),
    };
    const ummix = {
      createDraft: vi.fn(),
      updateCampaign: vi.fn(),
    };
    const service = new AssistantService(
      config,
      repository as never,
      ummix as never,
      {} as never,
    );

    const result = await service.finalize({
      id: completedSession.id,
      token: 'redacted',
      user: {
        id: completedSession.userId,
        fullName: 'Cliente',
        role: 'user',
        userType: 'regular_client',
      },
    });

    expect(result.campaignId).toBe(completedSession.finalizedCampaignId);
    expect(result.wizardStep).toBe(4);
    expect(ummix.createDraft).not.toHaveBeenCalled();
    expect(ummix.updateCampaign).not.toHaveBeenCalled();
  });
});
