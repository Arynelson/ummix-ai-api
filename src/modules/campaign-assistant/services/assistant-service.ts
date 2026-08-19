import type { AppConfig } from '../../../config.js';
import { SessionRepository } from '../db/session-repository.js';
import {
  applyExtractedPatch,
  campaignLocations,
  canCalculateComparison,
  initialState,
  isReadyToFinalize,
  missingFields,
  nextAssistantTurn,
} from '../domain/state-machine.js';
import type {
  AssistantSession,
  AudienceCatalogOption,
  AudienceFilterSelection,
  CampaignState,
  ChatMessage,
  ClientSnapshot,
  ExtractedCampaignPatch,
  ValidatedCampaignPatch,
} from '../domain/types.js';
import {
  CampaignBriefExtractor,
  OpenAIUnavailableError,
} from '../openai/extractor.js';
import { mapAudienceFiltersToTargetAudience } from '../domain/audience-filter-mapper.js';
import {
  currentDateInBrazil,
  normalizeContextualPatch,
} from '../domain/contextual-input.js';
import { UmmixClient, type UmmixUser } from '../ummix/ummix-client.js';

export interface SessionView {
  id: string;
  status: AssistantSession['status'];
  client: ClientSnapshot;
  state: CampaignState;
  messages: ChatMessage[];
  missingFields: ReturnType<typeof missingFields>;
  quickReplies: string[];
  readyToFinalize: boolean;
  expiresAt: string;
  finalization: {
    campaignId: string;
    wizardStep: 4;
    reviewUrl: string;
  } | null;
}

export class AssistantService {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: SessionRepository,
    private readonly ummix: UmmixClient,
    private readonly extractor: CampaignBriefExtractor,
  ) {}

  async getContext(token: string, user: UmmixUser) {
    const clients = await this.ummix.getAvailableClients(token, user);
    return {
      user: {
        id: user.id,
        fullName: user.fullName,
        userType: user.userType,
      },
      clients,
      requiresClientSelection: user.userType !== 'regular_client',
    };
  }

  async createSession(input: {
    token: string;
    user: UmmixUser;
    clientId?: string;
  }): Promise<SessionView> {
    const [client, minimumInvestment, locationOptions, stateOptions] = await Promise.all([
      this.ummix.getAuthorizedClient(input.token, input.user, input.clientId),
      this.ummix.getMinimumInvestment(input.token),
      this.ummix.getAvailableLocations(input.token),
      this.ummix.getAvailableStates(input.token).catch(() => []),
    ]);
    const state = initialState(
      minimumInvestment,
      client.businessActivity,
      locationOptions,
      stateOptions,
    );
    const initialTurn = nextAssistantTurn(state, {
      clientName: displayClient(client),
    });
    const initialMessage: ChatMessage = {
      role: 'assistant',
      content: initialTurn.message,
      createdAt: new Date().toISOString(),
    };
    const session = await this.repository.create({
      userId: input.user.id,
      userType: input.user.userType,
      client,
      state,
      initialMessage,
      ttlMinutes: this.config.SESSION_TTL_MINUTES,
    });
    await this.repository.trackMetric({
      sessionId: session.id,
      userType: session.userType,
      eventName: 'session_started',
    });
    return this.toView(session);
  }

  async getSession(id: string, userId: string, token?: string): Promise<SessionView> {
    const session = await this.requireOwnedSession(id, userId);
    if (!session.state.locationOptions?.length && token) {
      session.state = {
        ...session.state,
        locationOptions: await this.ummix.getAvailableLocations(token),
      };
    }
    if (!session.state.stateOptions?.length && token) {
      session.state = {
        ...session.state,
        stateOptions: await this.ummix.getAvailableStates(token).catch(() => []),
      };
    }
    return this.toView(session);
  }

  async sendMessage(input: {
    id: string;
    token: string;
    user: UmmixUser;
    message: string;
  }): Promise<
    SessionView & {
      assistantMessage: string;
      fallbackToManual: boolean;
    }
  > {
    const session = await this.requireActiveSession(input.id, input.user.id);
    const recentMessages = await this.repository.countRecentMessages(
      session.id,
      this.config.MESSAGE_WINDOW_MINUTES,
    );
    if (recentMessages >= this.config.MESSAGE_LIMIT_PER_WINDOW) {
      throw new AssistantHttpError(
        429,
        `Limite de ${this.config.MESSAGE_LIMIT_PER_WINDOW} mensagens por ${this.config.MESSAGE_WINDOW_MINUTES} minutos atingido.`,
      );
    }
    await this.repository.trackMetric({
      sessionId: session.id,
      userType: session.userType,
      eventName: 'message_sent',
    });

    let nextState = session.state;
    if (!nextState.locationOptions?.length) {
      const [locationOptions, stateOptions] = await Promise.all([
        this.ummix.getAvailableLocations(input.token),
        this.ummix.getAvailableStates(input.token).catch(() => []),
      ]);
      nextState = { ...nextState, locationOptions, stateOptions };
    }
    let fallbackToManual = false;
    try {
      const fullAudienceCatalog = await this.ummix
        .getAudienceCatalog(input.token)
        .catch(() => [] as AudienceCatalogOption[]);
      const currentField = missingFields(nextState)[0] ?? null;
      const referenceDate = currentDateInBrazil();
      const audienceCatalog = selectAudienceCatalog(
        input.message,
        fullAudienceCatalog,
        currentField === 'audienceDescription',
      );
      const extractedPatch = await this.extractor.extract({
        message: input.message,
        currentState: nextState,
        userId: input.user.id,
        audienceCatalog,
        currentField,
        referenceDate,
      });
      const patch = normalizeContextualPatch(extractedPatch, {
        message: input.message,
        currentField,
        referenceDate,
      });
      nextState = applyExtractedPatch(
        nextState,
        validateAudiencePatch(patch, audienceCatalog),
      );
      nextState = await this.resolveLocationIfPresent(input.token, nextState, patch);

      if (canCalculateComparison(nextState) && !nextState.comparison) {
        nextState = {
          ...nextState,
          comparison: await this.ummix.compareChannels(input.token, nextState),
        };
      }
    } catch (error) {
      fallbackToManual = error instanceof OpenAIUnavailableError;
      await this.repository.trackMetric({
        sessionId: session.id,
        userType: session.userType,
        eventName: fallbackToManual ? 'manual_fallback' : 'error',
        metadata: { stage: fallbackToManual ? 'llm' : 'message_processing' },
      });
    }

    const turn = nextAssistantTurn(nextState, {
      llmUnavailable: fallbackToManual,
      clientName: displayClient(session.clientSnapshot),
    });
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      ...session.messages,
      { role: 'user', content: input.message, createdAt: now },
      { role: 'assistant', content: turn.message, createdAt: now },
    ];
    const becameReady = isReadyToFinalize(nextState) && session.status !== 'ready';
    const saved = await this.repository.saveTurn({
      id: session.id,
      userId: input.user.id,
      expectedVersion: session.version,
      state: nextState,
      messages,
      status: isReadyToFinalize(nextState) ? 'ready' : 'collecting',
      ttlMinutes: this.config.SESSION_TTL_MINUTES,
    });
    if (!saved) {
      throw new AssistantHttpError(
        409,
        'A sessão foi atualizada em outra janela. Recarregue antes de continuar.',
      );
    }
    if (becameReady) {
      await this.repository.trackMetric({
        sessionId: saved.id,
        userType: saved.userType,
        eventName: 'proposal_ready',
      });
    }

    return {
      ...this.toView(saved),
      assistantMessage: turn.message,
      fallbackToManual,
    };
  }

  async selectLocations(input: {
    id: string;
    token: string;
    user: UmmixUser;
    cityIds: string[];
  }): Promise<SessionView & { assistantMessage: string; fallbackToManual: false }> {
    const session = await this.requireActiveSession(input.id, input.user.id);
    const requestedIds = [...new Set(input.cityIds)];
    const locationOptions =
      session.state.locationOptions?.length
        ? session.state.locationOptions
        : await this.ummix.getAvailableLocations(input.token);
    const byId = new Map(locationOptions.map((location) => [location.cityId, location]));
    const selectedLocations = requestedIds
      .map((cityId) => byId.get(cityId))
      .filter((location): location is NonNullable<typeof location> => Boolean(location));

    if (selectedLocations.length !== requestedIds.length) {
      throw new AssistantHttpError(
        422,
        'Uma ou mais praças não estão disponíveis para campanha.',
      );
    }

    let nextState: CampaignState = {
      ...session.state,
      locationOptions,
      locations: selectedLocations,
      location: selectedLocations[0] ?? null,
      unresolvedLocation: null,
      comparison: null,
      selectedChannel: null,
    };
    if (canCalculateComparison(nextState)) {
      nextState = {
        ...nextState,
        comparison: await this.ummix.compareChannels(input.token, nextState),
      };
    }

    const turn = nextAssistantTurn(nextState, {
      clientName: displayClient(session.clientSnapshot),
    });
    const now = new Date().toISOString();
    const cityLabels = selectedLocations.map(
      (location) =>
        `${location.cityName}${location.stateUf ? `/${location.stateUf}` : ''}`,
    );
    const messages: ChatMessage[] = [
      ...session.messages,
      {
        role: 'user',
        content: `Praças selecionadas: ${cityLabels.join(', ')}`,
        createdAt: now,
      },
      { role: 'assistant', content: turn.message, createdAt: now },
    ];
    const saved = await this.repository.saveTurn({
      id: session.id,
      userId: input.user.id,
      expectedVersion: session.version,
      state: nextState,
      messages,
      status: isReadyToFinalize(nextState) ? 'ready' : 'collecting',
      ttlMinutes: this.config.SESSION_TTL_MINUTES,
    });
    if (!saved) {
      throw new AssistantHttpError(
        409,
        'A sessão foi atualizada em outra janela. Recarregue antes de continuar.',
      );
    }
    await this.repository.trackMetric({
      sessionId: saved.id,
      userType: saved.userType,
      eventName: 'message_sent',
    });
    return {
      ...this.toView(saved),
      assistantMessage: turn.message,
      fallbackToManual: false,
    };
  }

  async finalize(input: {
    id: string;
    token: string;
    user: UmmixUser;
  }): Promise<{ campaignId: string; wizardStep: 4; reviewUrl: string }> {
    let session = await this.requireOwnedSession(input.id, input.user.id);
    if (session.status === 'completed' && session.finalizedCampaignId) {
      return this.finalizationResult(session.id, session.finalizedCampaignId);
    }
    if (session.status === 'expired') {
      throw new AssistantHttpError(410, 'A sessão expirou. Inicie uma nova proposta.');
    }
    if (!isReadyToFinalize(session.state)) {
      throw new AssistantHttpError(422, 'A proposta ainda possui campos obrigatórios pendentes.');
    }

    const claim = await this.repository.claimFinalization(session.id, input.user.id);
    session = claim.session ?? session;
    let campaignId = session.finalizedCampaignId;
    if (!claim.claimed && !campaignId) {
      throw new AssistantHttpError(409, 'A criação do rascunho já está em andamento.');
    }
    if (!campaignId) {
      try {
        const draft = await this.ummix.createDraft(input.token, {
          campaignName: campaignName(session.state),
          clientId: session.clientId,
        });
        campaignId = draft.id;
        await this.repository.rememberDraft(session.id, input.user.id, campaignId);
      } catch (error) {
        await this.repository.releaseFinalization(session.id, input.user.id);
        throw error;
      }
    }

    const payload = buildCampaignPayload(session, campaignId);
    await this.ummix.updateCampaign(input.token, campaignId, payload);
    await this.repository.complete(session.id, input.user.id, campaignId);
    await this.repository.trackMetric({
      sessionId: session.id,
      userType: session.userType,
      eventName: 'draft_created',
      metadata: { channel: session.state.selectedChannel },
    });
    return this.finalizationResult(session.id, campaignId);
  }

  async markReviewReached(id: string, user: UmmixUser): Promise<void> {
    const marked = await this.repository.markReviewReached(id, user.id);
    if (!marked) throw new AssistantHttpError(404, 'Sessão concluída não encontrada');
    await this.repository.trackMetric({
      sessionId: id,
      userType: user.userType,
      eventName: 'review_reached',
    });
  }

  async deleteSession(id: string, userId: string): Promise<void> {
    const deleted = await this.repository.deleteOwned(id, userId);
    if (!deleted) throw new AssistantHttpError(404, 'Sessão não encontrada');
  }

  private async resolveLocationIfPresent(
    token: string,
    state: CampaignState,
    patch: ExtractedCampaignPatch,
  ): Promise<CampaignState> {
    if (!patch.cityName) return state;
    const location = await this.ummix.resolveLocation(token, patch.cityName, patch.stateUf);
    return {
      ...state,
      location,
      locations: location ? [location] : [],
      unresolvedLocation: location
        ? null
        : [patch.cityName, patch.stateUf].filter(Boolean).join('/'),
      comparison: location ? state.comparison : null,
    };
  }

  private async requireOwnedSession(id: string, userId: string): Promise<AssistantSession> {
    const session = await this.repository.findOwned(id, userId);
    if (!session) throw new AssistantHttpError(404, 'Sessão não encontrada');
    return session;
  }

  private async requireActiveSession(id: string, userId: string): Promise<AssistantSession> {
    const session = await this.requireOwnedSession(id, userId);
    if (new Date(session.expiresAt).getTime() <= Date.now() || session.status === 'expired') {
      throw new AssistantHttpError(410, 'A sessão expirou. Inicie uma nova proposta.');
    }
    if (session.status === 'completed') {
      throw new AssistantHttpError(409, 'Esta sessão já foi concluída.');
    }
    if (session.status === 'finalizing') {
      throw new AssistantHttpError(409, 'Esta sessão está sendo finalizada.');
    }
    return session;
  }

  private toView(session: AssistantSession): SessionView {
    const turn = nextAssistantTurn(session.state, {
      clientName: displayClient(session.clientSnapshot),
    });
    return {
      id: session.id,
      status: session.status,
      client: session.clientSnapshot,
      state: session.state,
      messages: session.messages,
      missingFields: session.status === 'completed' ? [] : missingFields(session.state),
      quickReplies: session.status === 'completed' ? [] : turn.quickReplies,
      readyToFinalize: session.status === 'ready' && isReadyToFinalize(session.state),
      expiresAt: session.expiresAt,
      finalization: session.finalizedCampaignId
        ? this.finalizationResult(session.id, session.finalizedCampaignId)
        : null,
    };
  }

  private finalizationResult(sessionId: string, campaignId: string) {
    const parameters = new URLSearchParams({
      campaignId,
      step: '4',
      source: 'ai_assistant',
      assistantSessionId: sessionId,
    });
    return {
      campaignId,
      wizardStep: 4 as const,
      reviewUrl: `${this.config.UMMIX_WEB_URL}/wizard?${parameters.toString()}`,
    };
  }
}

export class AssistantHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AssistantHttpError';
  }
}

function displayClient(client: ClientSnapshot): string {
  return client.companyName || client.companyBrand || client.fullName;
}

function campaignName(state: CampaignState): string {
  const base = state.productService || 'Campanha com IA';
  return `Campanha - ${base}`.slice(0, 120);
}

function buildCampaignPayload(
  session: AssistantSession,
  campaignId: string,
): Record<string, unknown> {
  const state = session.state;
  const locations = campaignLocations(state);
  const channel = state.selectedChannel;
  const plan = channel && state.comparison ? state.comparison[channel] : null;
  if (
    !channel ||
    !plan ||
    !state.objective ||
    locations.length === 0 ||
    !state.maximumBudget ||
    !state.desiredStartDate
  ) {
    throw new AssistantHttpError(422, 'Proposta incompleta');
  }
  const periodWeeks = plan.periodWeeks ?? 1;
  const primaryLocation = locations[0]!;
  const cityNames = locations.map((location) => location.cityName);
  const cityIds = locations.map((location) => location.cityId);
  const states = [
    ...new Set(
      locations
        .map((location) => location.stateUf)
        .filter((stateUf): stateUf is string => Boolean(stateUf)),
    ),
  ];
  const audienceFilters = state.audienceFilters ?? [];
  const contractedPlan = contractPlanToBudget(state.maximumBudget, plan);

  return {
    campaignName: campaignName(state),
    brandName:
      state.objective === 'reconhecimento_marca'
        ? state.productService
        : session.clientSnapshot.companyBrand ?? session.clientSnapshot.companyName ?? undefined,
    objective: state.objective,
    startDate: state.desiredStartDate,
    endDate: addPeriod(state.desiredStartDate, periodWeeks),
    totalInvestment: contractedPlan.totalInvestment,
    targetAudience: {
      description: state.audienceDescription,
      cidade: primaryLocation.cityName,
      cities: cityNames,
      cityId: primaryLocation.cityId,
      cityIds,
      states,
      // Mantém também os nomes canônicos consumidos pelo mapper do services.
      cidades: cityNames,
      estados: states,
      ...mapAudienceFiltersToTargetAudience(audienceFilters),
      audienceFilters,
    },
    mediaChannel: channel,
    ...(channel === 'radio' ? { spotDurationRadio: '15' } : { spotDurationTv: '15' }),
    audienceReach: contractedPlan.totalReach,
    baseCpm: plan.cpm ?? 0,
    finalCpm: plan.cpm ?? 0,
    clientId: session.clientId,
    aiDimensioning: {
      source: 'ai_assistant',
      assistantSessionId: session.id,
      generatedDraftId: campaignId,
      budgetIsHardCap: true,
      durationSeconds: state.durationSeconds,
      comparison: state.comparison,
    },
    impressoesContratadas: contractedPlan.totalImpressions,
    brandStrength: state.brandStrength,
    format: channel === 'radio' ? 'spot' : 'vt',
    frequency: contractedPlan.frequency,
    period: Math.max(1, toNonNegativeInteger(periodWeeks, 1)),
    totalReach: contractedPlan.totalReach,
  };
}

function contractPlanToBudget(
  maximumBudget: number,
  plan: NonNullable<CampaignState['comparison']>['radio'],
): {
  frequency: number;
  totalReach: number;
  totalImpressions: number;
  totalInvestment: number;
} {
  const frequency = Math.max(1, toNonNegativeInteger(plan.frequency, 1));
  const cpm = Number(plan.cpm ?? 0);
  if (!(cpm > 0) || !Number.isFinite(cpm)) {
    throw new AssistantHttpError(422, 'Plano de mídia sem CPM válido');
  }

  const budget = Math.max(0, maximumBudget);
  const reachByBudget = Math.floor((budget * 1000) / (cpm * frequency));
  const availableAudience = Math.floor(
    Math.max(0, Number(plan.audienceImpacts ?? plan.inventory ?? 0)),
  );
  const totalReach = Math.min(reachByBudget, availableAudience);
  const totalImpressions = totalReach * frequency;
  const calculatedInvestment = Math.round((totalImpressions * cpm) / 10) / 100;

  return {
    frequency,
    totalReach,
    totalImpressions,
    totalInvestment: Math.min(budget, calculatedInvestment),
  };
}

function toNonNegativeInteger(value: number | null | undefined, fallback = 0): number {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.round(numeric));
}

function validateAudiencePatch(
  patch: ExtractedCampaignPatch,
  catalog: AudienceCatalogOption[],
): ValidatedCampaignPatch {
  if (!patch.audienceDescription || patch.audienceFilters === undefined) {
    const { audienceFilters: _audienceFilters, ...withoutAudienceFilters } = patch;
    return withoutAudienceFilters;
  }

  const allowed = new Map(
    catalog.map((option) => [
      `${option.questionId}:${option.optionId}`,
      {
        questionId: option.questionId,
        question: option.question,
        optionId: option.optionId,
        option: option.option,
        ...(option.questionOriginal ? { questionOriginal: option.questionOriginal } : {}),
        ...(option.category !== undefined ? { category: option.category } : {}),
      },
    ]),
  );
  const validated = (patch.audienceFilters ?? [])
    .filter((candidate) => candidate.confidence >= 0.7)
    .map((candidate) => allowed.get(`${candidate.questionId}:${candidate.optionId}`))
    .filter((selection): selection is AudienceFilterSelection => Boolean(selection));

  return { ...patch, audienceFilters: dedupeAudienceFilters(validated) };
}

function dedupeAudienceFilters(filters: AudienceFilterSelection[]): AudienceFilterSelection[] {
  const unique = new Map<string, AudienceFilterSelection>();
  for (const filter of filters) {
    unique.set(`${filter.questionId}:${filter.optionId}`, filter);
  }
  return [...unique.values()];
}

function selectAudienceCatalog(
  message: string,
  catalog: AudienceCatalogOption[],
  forceForCurrentQuestion = false,
): AudienceCatalogOption[] {
  if (!forceForCurrentQuestion && !mentionsAudience(message)) return [];

  const terms = tokenize(message);
  const dimensionPattern = /sexo|gener|idade|faixa|renda|escolar|ocup|regi|filh|relig|ra[cç]a|cor/i;
  const ranked = catalog
    .map((option) => {
      const searchable = `${option.question} ${option.questionOriginal ?? ''} ${option.option}`.toLocaleLowerCase('pt-BR');
      const termScore = terms.reduce(
        (score, term) => score + (searchable.includes(term) ? 3 : 0),
        0,
      );
      const profileScore = /perfil|publico/.test(option.category?.toLocaleLowerCase('pt-BR') ?? '') ? 1 : 0;
      const dimensionScore = dimensionPattern.test(option.question) ? 1 : 0;
      return { option, score: termScore + profileScore + dimensionScore };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (forceForCurrentQuestion) {
    const rankedIds = new Set(
      ranked.map((item) => `${item.option.questionId}:${item.option.optionId}`),
    );
    return [
      ...ranked.map((item) => item.option),
      ...catalog.filter(
        (option) => !rankedIds.has(`${option.questionId}:${option.optionId}`),
      ),
    ].slice(0, 400);
  }

  return (ranked.length > 0 ? ranked.map((item) => item.option) : catalog).slice(0, 400);
}

function mentionsAudience(message: string): boolean {
  return /p[uú]blico|alcan[cç]ar|idade|anos|mulher|homem|femin|mascul|renda|classe|fam[ií]lia|interessad|cliente/i.test(
    message,
  );
}

function tokenize(message: string): string[] {
  const stopWords = new Set([
    'para',
    'meu',
    'minha',
    'com',
    'que',
    'uma',
    'uns',
    'umas',
    'dos',
    'das',
    'de',
    'do',
    'da',
    'e',
    'a',
    'o',
  ]);
  return normalizeText(message)
    .split(/\s+/)
    .filter((term) => term.length >= 3 && !stopWords.has(term));
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('pt-BR');
}

function addPeriod(startDate: string, periodWeeks: number): string {
  const date = new Date(`${startDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Math.max(1, periodWeeks) * 7 - 1);
  return date.toISOString().slice(0, 10);
}
