import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../config.js';
import type { AssistantSession } from '../domain/types.js';
import { initialState } from '../domain/state-machine.js';
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
  OPENAI_MODEL: 'gpt-5.6-luna',
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

  it('normalizes decimal reach and integer planning fields before the services patch', async () => {
    const state = {
      ...initialState(100, 'varejo'),
      productService: 'Clínica',
      objective: 'reconhecimento_marca' as const,
      audienceDescription: 'Mulheres adultas',
      audienceFilters: [
        {
          questionId: 'age-question',
          question: 'Faixa etária',
          questionOriginal: 'P3. Qual sua idade?',
          optionId: 'age-option',
          option: '30 a 34 anos',
        },
      ],
      location: { cityId: 'city', cityName: 'Goiânia', stateUf: 'GO' },
      locations: [{ cityId: 'city', cityName: 'Goiânia', stateUf: 'GO' }],
      maximumBudget: 1000,
      desiredStartDate: '2026-08-20',
      selectedChannel: 'radio' as const,
      comparison: {
        radio: {
          channel: 'radio' as const,
          available: true,
          cpm: 20.123,
          frequency: 2.6,
          periodWeeks: 3.4,
          totalImpressions: 1000.6,
          inventory: 999.4,
          audienceImpacts: 1234.56,
          projectedLeads: 10.5,
          projectedSales: 1.2,
          reasonUnavailable: null,
        },
        tv: {
          channel: 'tv' as const,
          available: false,
          cpm: null,
          frequency: null,
          periodWeeks: null,
          totalImpressions: null,
          inventory: null,
          audienceImpacts: null,
          projectedLeads: null,
          projectedSales: null,
          reasonUnavailable: 'Sem dados',
        },
        recommendedChannel: 'radio' as const,
        rationale: 'Rádio',
      },
    };
    const session = {
      id: '93203443-1fe8-45d0-a90d-8ec96ba8042f',
      userId: '856918db-6f3d-4375-a95c-715177012cca',
      userType: 'regular_client',
      clientId: '7ed901e4-3adf-45f4-a60d-17908424045f',
      clientSnapshot: {
        id: '7ed901e4-3adf-45f4-a60d-17908424045f',
        fullName: 'Cliente',
        companyName: 'Empresa',
        companyBrand: 'Marca',
        businessActivity: 'varejo',
        isActive: true,
      },
      status: 'ready',
      state,
      messages: [],
      finalizedCampaignId: null,
      finalizedAt: null,
      reviewReachedAt: null,
      expiresAt: '2099-01-01T00:00:00.000Z',
      createdAt: '2026-08-18T00:00:00.000Z',
      updatedAt: '2026-08-18T00:00:00.000Z',
      version: 1,
    } as AssistantSession;
    const finalizingSession = { ...session, status: 'finalizing', version: 2 } as AssistantSession;
    const repository = {
      findOwned: vi.fn().mockResolvedValue(session),
      claimFinalization: vi.fn().mockResolvedValue({ session: finalizingSession, claimed: true }),
      rememberDraft: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue({ ...finalizingSession, status: 'completed' }),
      trackMetric: vi.fn().mockResolvedValue(undefined),
    };
    const ummix = {
      createDraft: vi.fn().mockResolvedValue({
        id: '147dad44-1eea-411b-9b5d-1f6467d91712',
        wizardStep: 1,
        updatedAt: '2026-08-18T00:00:00.000Z',
      }),
      updateCampaign: vi.fn().mockResolvedValue({}),
    };
    const service = new AssistantService(
      config,
      repository as never,
      ummix as never,
      {} as never,
    );

    const result = await service.finalize({
      id: session.id,
      token: 'redacted',
      user: {
        id: session.userId,
        fullName: 'Cliente',
        role: 'user',
        userType: 'regular_client',
      },
    });

    expect(ummix.updateCampaign).toHaveBeenCalledWith(
      'redacted',
      '147dad44-1eea-411b-9b5d-1f6467d91712',
      expect.objectContaining({
        audienceReach: 1235,
        totalReach: 1235,
        impressoesContratadas: 1001,
        frequency: 3,
        period: 3,
        targetAudience: expect.objectContaining({
          idadeFaixas: ['30-34'],
          selections: [
            {
              question: 'Faixa etária',
              answers: ['30 a 34 anos'],
            },
          ],
        }),
      }),
    );
    expect(result.wizardStep).toBe(4);
    expect(result.reviewUrl).toContain(
      '/wizard?campaignId=147dad44-1eea-411b-9b5d-1f6467d91712&step=4&source=ai_assistant&assistantSessionId=93203443-1fe8-45d0-a90d-8ec96ba8042f',
    );
  });

  it('keeps only audience options that exist in the remote catalog', async () => {
    const location = { cityId: 'city', cityName: 'Goiânia', stateUf: 'GO' };
    const state = {
      ...initialState(100, 'varejo', [location]),
      productService: 'Clínica',
      objective: 'reconhecimento_marca' as const,
    };
    const session = {
      id: '93203443-1fe8-45d0-a90d-8ec96ba8042f',
      userId: '856918db-6f3d-4375-a95c-715177012cca',
      userType: 'regular_client',
      clientId: '7ed901e4-3adf-45f4-a60d-17908424045f',
      clientSnapshot: {
        id: '7ed901e4-3adf-4375-a95c-715177012cca',
        fullName: 'Cliente',
        companyName: 'Empresa',
        companyBrand: 'Marca',
        businessActivity: 'varejo',
        isActive: true,
      },
      status: 'collecting',
      state,
      messages: [],
      finalizedCampaignId: null,
      finalizedAt: null,
      reviewReachedAt: null,
      expiresAt: '2099-01-01T00:00:00.000Z',
      createdAt: '2026-08-18T00:00:00.000Z',
      updatedAt: '2026-08-18T00:00:00.000Z',
      version: 1,
    } as AssistantSession;
    let savedState = state;
    const repository = {
      findOwned: vi.fn().mockResolvedValue(session),
      countRecentMessages: vi.fn().mockResolvedValue(0),
      trackMetric: vi.fn().mockResolvedValue(undefined),
      saveTurn: vi.fn().mockImplementation(async (input) => {
        savedState = input.state;
        return { ...session, state: input.state, messages: input.messages, version: 2 };
      }),
    };
    const ummix = {
      getAudienceCatalog: vi.fn().mockResolvedValue([
        {
          questionId: '11111111-1111-4111-8111-111111111111',
          question: 'Gênero',
          category: 'perfil',
          optionId: '22222222-2222-4222-8222-222222222222',
          option: 'Feminino',
        },
      ]),
    };
    const extractor = {
      extract: vi.fn().mockResolvedValue({
        productService: null,
        objective: null,
        audienceDescription: 'Mulheres adultas',
        audienceFilters: [
          {
            questionId: '11111111-1111-4111-8111-111111111111',
            optionId: '22222222-2222-4222-8222-222222222222',
            confidence: 0.95,
          },
          {
            questionId: '33333333-3333-4333-8333-333333333333',
            optionId: '44444444-4444-4444-8444-444444444444',
            confidence: 0.99,
          },
        ],
        cityName: null,
        stateUf: null,
        maximumBudget: null,
        desiredStartDate: null,
        selectedChannel: null,
      }),
    };
    const service = new AssistantService(
      config,
      repository as never,
      ummix as never,
      extractor as never,
    );

    await service.sendMessage({
      id: session.id,
      token: 'redacted',
      user: {
        id: session.userId,
        fullName: 'Cliente',
        role: 'user',
        userType: 'regular_client',
      },
      message: 'Mulheres adultas',
    });

    expect(savedState.audienceFilters).toEqual([
      {
        questionId: '11111111-1111-4111-8111-111111111111',
        question: 'Gênero',
        category: 'perfil',
        optionId: '22222222-2222-4222-8222-222222222222',
        option: 'Feminino',
      },
    ]);
  });
});
