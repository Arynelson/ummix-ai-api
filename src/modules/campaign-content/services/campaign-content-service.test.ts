import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../config.js';
import type { CampaignContentContext } from '@ummix/ai-contracts';
import type { CampaignContentSessionWithMessages } from '../db/session-repository.js';
import type {
  CampaignContentEmailDelivery,
  CampaignContentRecord,
  ContentWithSessionVersion,
} from '../db/content-repository.js';
import { CampaignContentLengthPolicyService } from '../domain/length-policy.js';
import { CampaignContentService } from './campaign-content-service.js';

const user = {
  id: '856918db-6f3d-4375-a95c-715177012cca',
  role: 'user',
  userType: 'regular_client',
};

const context: CampaignContentContext = {
  contractVersion: '1',
  campaignId: '147dad44-1eea-411b-9b5d-1f6467d91712',
  userId: user.id,
  clientId: '93203443-1fe8-45d0-a90d-8ec96ba8042f',
  campaignName: 'Campanha de inverno',
  brandName: 'Marca teste',
  objective: 'promocao_oferta',
  mediaChannel: 'radio',
  format: 'spot',
  durationSeconds: 30,
  paymentStatus: 'pending_payment',
  canGenerate: true,
  contextVersion: 'services-ai-content-v1',
  startDate: '2026-10-01',
  endDate: '2026-10-30',
  targetAudience: null,
};

const config: AppConfig = {
  NODE_ENV: 'test',
  PORT: 3010,
  HOST: '127.0.0.1',
  DATABASE_URL: 'postgresql://test',
  UMMIX_API_URL: 'http://ummix.test/api',
  UMMIX_WEB_URL: 'http://ummix.test',
  AI_WEB_ORIGIN: 'http://ai-web.test',
  CAMPAIGN_ASSISTANT_ENABLED: true,
  CAMPAIGN_CONTENT_ENABLED: true,
  AI_HANDOFF_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  AI_HANDOFF_TTL_SECONDS: 60,
  SESSION_TTL_MINUTES: 120,
  MESSAGE_LIMIT_PER_WINDOW: 20,
  MESSAGE_WINDOW_MINUTES: 10,
  OPENAI_MODEL: 'gpt-5.6-luna',
  CAMPAIGN_CONTENT_LENGTH_POLICY_VERSION: 'pt-br-v1',
  CAMPAIGN_CONTENT_MIN_WORDS_PER_SECOND: 2.2,
  CAMPAIGN_CONTENT_MAX_WORDS_PER_SECOND: 2.6,
};

function makeSession(overrides: Partial<CampaignContentSessionWithMessages['session']> = {}): CampaignContentSessionWithMessages {
  return {
    session: {
      id: '93203443-1fe8-45d0-a90d-8ec96ba8042f',
      campaignId: context.campaignId,
      userId: user.id,
      status: 'collecting',
      campaignSnapshot: {
        campaignName: context.campaignName,
        brandName: context.brandName,
        objective: context.objective,
        mediaChannel: context.mediaChannel,
        format: context.format,
        durationSeconds: context.durationSeconds,
        paymentStatus: context.paymentStatus,
        startDate: context.startDate,
        endDate: context.endDate,
        targetAudience: context.targetAudience,
        contextVersion: context.contextVersion,
      },
      answers: {},
      currentQuestionKey: 'product_or_service',
      expiresAt: '2026-12-01T23:59:59.000Z',
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
      version: 0,
      ...overrides,
    },
    messages: [],
  };
}

function makeContent(overrides: Partial<CampaignContentRecord> = {}): ContentWithSessionVersion {
  const text = Array.from({ length: 70 }, (_, index) => `palavra${index}`).join(' ');
  return {
    sessionVersion: 1,
    content: {
      id: 'b80b6c68-57cf-45b0-9605-70d53c4dfc1b',
      campaignId: context.campaignId,
      sessionId: '93203443-1fe8-45d0-a90d-8ec96ba8042f',
      generationKey: '147dad44-1eea-411b-9b5d-1f6467d91712',
      status: 'options_ready',
      options: [{ id: 'option-1', text, wordCount: 70, style: 'direto' }],
      selectedOptionId: null,
      selectedTextOriginal: null,
      finalText: null,
      isEdited: false,
      mediaChannel: 'radio',
      contentFormat: 'spot',
      lengthPolicy: { version: 'pt-br-v1', durationSeconds: 30, minWords: 66, maxWords: 78 },
      wordCount: null,
      modelName: 'test-model',
      promptVersion: 'campaign-content-pt-br-v1',
      emailStatus: 'not_sent',
      emailSentAt: null,
      emailLastError: null,
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
      ...overrides,
    },
  };
}

describe('CampaignContentService', () => {
  it('creates a session from the server context and asks for product details', async () => {
    const repository = {
      createOrFindActive: vi.fn().mockResolvedValue(makeSession()),
    };
    const contextClient = {
      getCampaignContext: vi.fn().mockResolvedValue(context),
    };
    const service = new CampaignContentService(config, repository as never, contextClient as never);

    const result = await service.createOrResumeSession({
      campaignId: context.campaignId,
      token: 'user-token',
      user,
    });

    expect(contextClient.getCampaignContext).toHaveBeenCalledWith(context.campaignId, 'user-token');
    expect(repository.createOrFindActive).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: context.campaignId,
      userId: user.id,
      currentQuestionKey: 'product_or_service',
      status: 'collecting',
    }));
    expect(result.campaignContext.objective).toBe('promocao_oferta');
    expect(result.missingFields[0]).toBe('product_or_service');
  });

  it('refuses an ineligible campaign before creating a session', async () => {
    const repository = { createOrFindActive: vi.fn() };
    const contextClient = {
      getCampaignContext: vi.fn().mockResolvedValue({ ...context, canGenerate: false }),
    };
    const service = new CampaignContentService(config, repository as never, contextClient as never);

    await expect(service.createOrResumeSession({
      campaignId: context.campaignId,
      token: 'user-token',
      user,
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(repository.createOrFindActive).not.toHaveBeenCalled();
  });

  it('returns a version conflict instead of overwriting another tab', async () => {
    const existing = makeSession();
    const repository = {
      findOwned: vi.fn().mockResolvedValue(existing),
      appendAnswer: vi.fn().mockResolvedValue({ kind: 'conflict', value: existing }),
    };
    const contextClient = { getCampaignContext: vi.fn().mockResolvedValue(context) };
    const service = new CampaignContentService(config, repository as never, contextClient as never);

    await expect(service.addMessage({
      campaignId: context.campaignId,
      sessionId: existing.session.id,
      token: 'user-token',
      user,
      clientMessageId: '147dad44-1eea-411b-9b5d-1f6467d91712',
      text: 'Produto teste',
      expectedSessionVersion: 0,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reserva, gera e persiste tres opcoes com a politica do snapshot', async () => {
    const session = makeSession({ status: 'ready_to_generate', currentQuestionKey: null });
    const reserved = makeContent();
    const completed = makeContent({
      status: 'options_ready',
      options: [
        { id: 'option-1', text: 'Oferta especial hoje', wordCount: 3, style: 'direto' },
        { id: 'option-2', text: 'Descubra novidades agora', wordCount: 3, style: 'emocional' },
        { id: 'option-3', text: 'Aproveite esta oportunidade', wordCount: 3, style: 'promocional' },
      ],
    });
    const repository = {
      findOwned: vi.fn().mockResolvedValue(session),
    };
    const contextClient = { getCampaignContext: vi.fn().mockResolvedValue(context) };
    const contentRepository = {
      reserveGeneration: vi.fn().mockResolvedValue({ kind: 'reserved', value: reserved }),
      completeGeneration: vi.fn().mockResolvedValue(completed),
      failGeneration: vi.fn(),
    };
    const generator = {
      generate: vi.fn().mockResolvedValue({
        options: completed.content.options,
        modelName: 'test-model',
        promptVersion: 'campaign-content-pt-br-v1',
      }),
    };
    const lengthPolicy = new CampaignContentLengthPolicyService({
      version: 'pt-br-v1',
      minWordsPerSecond: 2.2,
      maxWordsPerSecond: 2.6,
    });
    const service = new CampaignContentService(
      config,
      repository as never,
      contextClient as never,
      contentRepository as never,
      generator as never,
      lengthPolicy,
    );

    const result = await service.generate({
      campaignId: context.campaignId,
      sessionId: session.session.id,
      token: 'user-token',
      user,
      generationKey: '147dad44-1eea-411b-9b5d-1f6467d91712',
    });

    expect(generator.generate).toHaveBeenCalledOnce();
    expect(contentRepository.reserveGeneration).toHaveBeenCalledWith(expect.objectContaining({
      lengthPolicy: { version: 'pt-br-v1', durationSeconds: 30, minWords: 66, maxWords: 78 },
    }));
    expect(result.options).toHaveLength(3);
    expect(result.status).toBe('options_ready');
  });

  it('bloqueia salvar texto editado fora da faixa de duracao', async () => {
    const session = makeSession({ status: 'options_ready', version: 1 });
    const repository = { findOwned: vi.fn().mockResolvedValue(session) };
    const contextClient = { getCampaignContext: vi.fn().mockResolvedValue(context) };
    const contentRepository = { saveSelection: vi.fn() };
    const lengthPolicy = new CampaignContentLengthPolicyService({
      version: 'pt-br-v1',
      minWordsPerSecond: 2.2,
      maxWordsPerSecond: 2.6,
    });
    const service = new CampaignContentService(
      config,
      repository as never,
      contextClient as never,
      contentRepository as never,
      {} as never,
      lengthPolicy,
    );

    await expect(service.saveSelection({
      campaignId: context.campaignId,
      sessionId: session.session.id,
      token: 'user-token',
      user,
      generationId: 'b80b6c68-57cf-45b0-9605-70d53c4dfc1b',
      optionId: 'option-1',
      finalText: 'texto curto demais',
      expectedSessionVersion: 1,
    })).rejects.toMatchObject({ statusCode: 422 });
    expect(contentRepository.saveSelection).not.toHaveBeenCalled();
  });

  it('salva selecao editada e conserva o resultado idempotente', async () => {
    const session = makeSession({ status: 'options_ready', version: 1 });
    const selectedText = Array.from({ length: 70 }, (_, index) => `palavra${index}`).join(' ');
    const saved = makeContent({
      status: 'saved',
      selectedOptionId: 'option-1',
      selectedTextOriginal: selectedText,
      finalText: selectedText,
      wordCount: 70,
    });
    const repository = { findOwned: vi.fn().mockResolvedValue(session) };
    const contextClient = { getCampaignContext: vi.fn().mockResolvedValue(context) };
    const contentRepository = { saveSelection: vi.fn().mockResolvedValue({ kind: 'saved', value: saved }) };
    const lengthPolicy = new CampaignContentLengthPolicyService({
      version: 'pt-br-v1',
      minWordsPerSecond: 2.2,
      maxWordsPerSecond: 2.6,
    });
    const service = new CampaignContentService(
      config,
      repository as never,
      contextClient as never,
      contentRepository as never,
      {} as never,
      lengthPolicy,
    );

    const result = await service.saveSelection({
      campaignId: context.campaignId,
      sessionId: session.session.id,
      token: 'user-token',
      user,
      generationId: saved.content.id,
      optionId: 'option-1',
      finalText: selectedText,
      expectedSessionVersion: 1,
    });

    expect(result.status).toBe('saved');
    expect(contentRepository.saveSelection).toHaveBeenCalledWith(expect.objectContaining({ wordCount: 70 }));
  });

  it('inicia a notificação somente depois de receber o conteúdo salvo', async () => {
    const session = makeSession({ status: 'options_ready', version: 1 });
    const selectedText = Array.from({ length: 70 }, (_, index) => `palavra${index}`).join(' ');
    const saved = makeContent({
      status: 'saved',
      selectedOptionId: 'option-1',
      selectedTextOriginal: selectedText,
      finalText: selectedText,
      wordCount: 70,
      emailStatus: 'pending',
    });
    const delivery: CampaignContentEmailDelivery = {
      content: saved.content,
      campaignSnapshot: session.session.campaignSnapshot,
    };
    const repository = { findOwned: vi.fn().mockResolvedValue(session) };
    const contextClient = { getCampaignContext: vi.fn().mockResolvedValue(context) };
    const contentRepository = {
      saveSelection: vi.fn().mockResolvedValue({ kind: 'saved', value: saved }),
      claimEmailDelivery: vi.fn().mockResolvedValue({ kind: 'claimed', value: delivery }),
      markEmailSent: vi.fn().mockResolvedValue(undefined),
      markEmailFailed: vi.fn().mockResolvedValue(undefined),
    };
    const emailProvider = {
      isEnabled: vi.fn().mockReturnValue(true),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const lengthPolicy = new CampaignContentLengthPolicyService({
      version: 'pt-br-v1',
      minWordsPerSecond: 2.2,
      maxWordsPerSecond: 2.6,
    });
    const service = new CampaignContentService(
      config,
      repository as never,
      contextClient as never,
      contentRepository as never,
      {} as never,
      lengthPolicy,
      emailProvider as never,
    );

    const result = await service.saveSelection({
      campaignId: context.campaignId,
      sessionId: session.session.id,
      token: 'user-token',
      user,
      generationId: saved.content.id,
      optionId: 'option-1',
      finalText: selectedText,
      expectedSessionVersion: 1,
    });

    expect(result.emailStatus).toBe('pending');
    await vi.waitFor(() => expect(emailProvider.send).toHaveBeenCalledOnce());
    expect(contentRepository.claimEmailDelivery).toHaveBeenCalledWith(context.campaignId, saved.content.id);
    expect(contentRepository.markEmailSent).toHaveBeenCalledWith(saved.content.id);
    expect(contentRepository.markEmailFailed).not.toHaveBeenCalled();
  });

  it('mantém o conteúdo salvo e marca falha quando o provider cai', async () => {
    const session = makeSession({ status: 'options_ready', version: 1 });
    const selectedText = Array.from({ length: 70 }, (_, index) => `palavra${index}`).join(' ');
    const saved = makeContent({
      status: 'saved',
      selectedOptionId: 'option-1',
      selectedTextOriginal: selectedText,
      finalText: selectedText,
      wordCount: 70,
      emailStatus: 'pending',
    });
    const contentRepository = {
      saveSelection: vi.fn().mockResolvedValue({ kind: 'saved', value: saved }),
      claimEmailDelivery: vi.fn().mockResolvedValue({
        kind: 'claimed',
        value: { content: saved.content, campaignSnapshot: session.session.campaignSnapshot },
      }),
      markEmailSent: vi.fn(),
      markEmailFailed: vi.fn().mockResolvedValue(undefined),
    };
    const service = new CampaignContentService(
      config,
      { findOwned: vi.fn().mockResolvedValue(session) } as never,
      { getCampaignContext: vi.fn().mockResolvedValue(context) } as never,
      contentRepository as never,
      {} as never,
      new CampaignContentLengthPolicyService({
        version: 'pt-br-v1',
        minWordsPerSecond: 2.2,
        maxWordsPerSecond: 2.6,
      }),
      {
        isEnabled: vi.fn().mockReturnValue(true),
        send: vi.fn().mockRejectedValue(new Error('provider indisponivel')),
      } as never,
    );

    await expect(service.saveSelection({
      campaignId: context.campaignId,
      sessionId: session.session.id,
      token: 'user-token',
      user,
      generationId: saved.content.id,
      optionId: 'option-1',
      finalText: selectedText,
      expectedSessionVersion: 1,
    })).resolves.toMatchObject({ status: 'saved', emailStatus: 'pending' });

    await vi.waitFor(() => expect(contentRepository.markEmailFailed).toHaveBeenCalledWith(
      saved.content.id,
      'provider indisponivel',
    ));
    expect(contentRepository.markEmailSent).not.toHaveBeenCalled();
  });

  it('não reenvia conteúdo já marcado como sent e bloqueia retry de usuário', async () => {
    const saved = makeContent({
      status: 'saved',
      selectedOptionId: 'option-1',
      selectedTextOriginal: 'texto original',
      finalText: 'texto final',
      wordCount: 70,
      emailStatus: 'sent',
    });
    const delivery: CampaignContentEmailDelivery = {
      content: saved.content,
      campaignSnapshot: contextToSnapshot(),
    };
    const contentRepository = {
      claimEmailDelivery: vi.fn().mockResolvedValue({ kind: 'sent', value: delivery }),
    };
    const emailProvider = { isEnabled: vi.fn().mockReturnValue(true), send: vi.fn() };
    const service = new CampaignContentService(
      config,
      {} as never,
      {} as never,
      contentRepository as never,
      {} as never,
      {} as never,
      emailProvider as never,
    );

    await expect(service.retryEmail({
      campaignId: context.campaignId,
      generationId: saved.content.id,
      token: 'admin-token',
      user: { ...user, role: 'admin' },
    })).resolves.toMatchObject({ emailStatus: 'sent' });
    expect(emailProvider.send).not.toHaveBeenCalled();
    await expect(service.retryEmail({
      campaignId: context.campaignId,
      generationId: saved.content.id,
      token: 'user-token',
      user,
    })).rejects.toMatchObject({ statusCode: 403 });
  });
});

function contextToSnapshot(): CampaignContentEmailDelivery['campaignSnapshot'] {
  return {
    campaignName: context.campaignName,
    brandName: context.brandName,
    objective: context.objective,
    mediaChannel: context.mediaChannel,
    format: context.format,
    durationSeconds: context.durationSeconds,
    paymentStatus: context.paymentStatus,
    startDate: context.startDate,
    endDate: context.endDate,
    targetAudience: context.targetAudience,
    contextVersion: context.contextVersion,
  };
}
