import { createHash } from 'node:crypto';
import {
  buildRationale,
  campaignLocations,
  chooseRecommendedChannel,
} from '../domain/state-machine.js';
import type {
  AudienceCatalogOption,
  AudienceFilterSelection,
  CampaignLocation,
  CampaignState,
  ChannelComparison,
  ClientSnapshot,
  MediaChannel,
  MediaPlan,
  StateOption,
} from '../domain/types.js';
import { mapAudienceFiltersToTargetAudience } from '../domain/audience-filter-mapper.js';

export interface UmmixUser {
  id: string;
  fullName: string;
  userType: 'regular_client' | 'marketing_agency' | 'paid_traffic_manager';
  role: string;
}

interface UmmixClientResponse {
  id: string;
  fullName: string;
  companyName?: string | null;
  companyBrand?: string | null;
  businessActivity?: string | null;
  isActive: boolean;
}

interface CityResponse {
  id: string;
  name: string;
  is_active?: boolean;
  state?: { uf?: string | null };
}

interface StateResponse {
  id: string;
  name: string;
  uf: string;
  is_active?: boolean;
}

interface QuestionOptionResponse {
  id: string;
  text: string;
  is_active?: boolean;
}

interface QuestionResponse {
  id: string;
  title?: string;
  label?: string;
  category?: string | null;
  options?: QuestionOptionResponse[];
  stage?: string;
  type?: string;
  config?: {
    originalExcelColumn?: string;
    originalCategory?: string;
    [key: string]: unknown;
  } | null;
}

interface CalculationResponse {
  suggestedFrequency: number;
  suggestedPeriod: number;
  cpm: number;
  totalImpressions: number;
  inventory: number;
  projectedLeads: number;
  projectedSales: number;
}

export class UmmixApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'UmmixApiError';
  }
}

export class UmmixClient {
  private cityCache: { expiresAt: number; cities: CityResponse[] } | null = null;
  private stateCache: { expiresAt: number; states: StateOption[] } | null = null;
  private audienceCatalogCache = new Map<string, {
    expiresAt: number;
    options: AudienceCatalogOption[];
  }>();

  constructor(private readonly baseUrl: string) {}

  getCurrentUser(token: string): Promise<UmmixUser> {
    return this.request<UmmixUser>('/users/me', token);
  }

  async getAvailableClients(
    token: string,
    user: UmmixUser,
  ): Promise<ClientSnapshot[]> {
    if (user.userType === 'regular_client') {
      const client = await this.request<UmmixClientResponse>('/clients/me', token);
      return client?.isActive ? [toSnapshot(client)] : [];
    }
    const clients = await this.request<UmmixClientResponse[]>('/clients/mine', token);
    return clients.filter((client) => client.isActive).map(toSnapshot);
  }

  async getAuthorizedClient(
    token: string,
    user: UmmixUser,
    requestedClientId?: string,
  ): Promise<ClientSnapshot> {
    if (user.userType === 'regular_client') {
      const ownClient = await this.request<UmmixClientResponse>('/clients/me', token);
      if (!ownClient?.isActive) throw new UmmixApiError('Cadastro de cliente inativo', 422);
      if (requestedClientId && requestedClientId !== ownClient.id) {
        throw new UmmixApiError('Cliente fora do escopo do usuário', 403);
      }
      return toSnapshot(ownClient);
    }

    if (!requestedClientId) {
      throw new UmmixApiError('Selecione um cliente ativo', 422);
    }
    const client = await this.request<UmmixClientResponse>(
      `/clients/${encodeURIComponent(requestedClientId)}`,
      token,
    );
    if (!client.isActive) throw new UmmixApiError('Cliente inativo', 422);
    return toSnapshot(client);
  }

  async getMinimumInvestment(token: string): Promise<number> {
    const response = await this.request<{ minInvestment: number }>('/campaigns/config', token);
    if (!Number.isFinite(response.minInvestment) || response.minInvestment < 0) {
      throw new UmmixApiError('Investimento mínimo inválido no serviço Ummix', 502);
    }
    return response.minInvestment;
  }

  async resolveLocation(
    token: string,
    cityName: string,
    stateUf: string | null,
  ): Promise<CampaignLocation | null> {
    const cities = await this.getAvailableLocations(token);
    const wantedCity = normalize(cityName);
    const wantedUf = stateUf?.trim().toUpperCase() ?? null;
    const matches = cities.filter(
      (city) =>
        normalize(city.cityName) === wantedCity &&
        (!wantedUf || city.stateUf === wantedUf),
    );
    if (matches.length !== 1) return null;
    const match = matches[0];
    if (!match) return null;
    return {
      cityId: match.cityId,
      cityName: match.cityName,
      stateUf: match.stateUf ?? wantedUf,
    };
  }

  async getAvailableLocations(token: string): Promise<CampaignLocation[]> {
    const [cities, states] = await Promise.all([
      this.getCities(token),
      this.request<StateResponse[]>('/states?activeOnly=true&withResponses=false', token),
    ]);
    const activeStateUfs = new Set(
      states
        .filter((state) => state.is_active !== false)
        .map((state) => state.uf.trim().toUpperCase()),
    );
    return cities
      .filter(
        (city) =>
          city.is_active !== false &&
          Boolean(city.state?.uf) &&
          activeStateUfs.has(city.state?.uf?.trim().toUpperCase() ?? ''),
      )
      .map((city) => ({
        cityId: city.id,
        cityName: city.name,
        stateUf: city.state?.uf?.toUpperCase() ?? null,
      }));
  }

  async getAvailableStates(token: string): Promise<StateOption[]> {
    if (this.stateCache && this.stateCache.expiresAt > Date.now()) {
      return this.stateCache.states;
    }

    const [states, cities] = await Promise.all([
      this.request<StateResponse[]>('/states?activeOnly=true&withResponses=false', token),
      this.getCities(token),
    ]);
    const cityUfs = new Set(
      cities
        .map((city) => city.state?.uf?.trim().toUpperCase())
        .filter((uf): uf is string => Boolean(uf)),
    );
    const availableStates = states
      .filter((state) => state.is_active !== false && cityUfs.has(state.uf.toUpperCase()))
      .map((state) => ({
        stateId: state.id,
        stateName: state.name,
        stateUf: state.uf.toUpperCase(),
      }));
    this.stateCache = {
      states: availableStates,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    return availableStates;
  }

  async getAudienceCatalog(token: string): Promise<AudienceCatalogOption[]> {
    const cacheKey = createHash('sha256').update(token).digest('hex');
    const cached = this.audienceCatalogCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.options;
    }

    const questions = await this.request<QuestionResponse[]>('/questions/user/active', token);
    const options = questions.filter(isAudienceQuestion).flatMap((question) =>
      (question.options ?? [])
        .filter((option) => option.is_active !== false)
        .map((option) => ({
          questionId: question.id,
          question: question.title ?? question.label ?? '',
          ...(question.config?.originalExcelColumn
            ? { questionOriginal: question.config.originalExcelColumn }
            : {}),
          category: question.category ?? null,
          optionId: option.id,
          option: option.text,
        })),
    );
    this.audienceCatalogCache.set(cacheKey, {
      options,
      expiresAt: Date.now() + 60 * 1000,
    });
    if (this.audienceCatalogCache.size > 20) {
      const oldestKey = this.audienceCatalogCache.keys().next().value;
      if (oldestKey) this.audienceCatalogCache.delete(oldestKey);
    }
    return options;
  }

  async compareChannels(
    token: string,
    state: CampaignState,
  ): Promise<ChannelComparison> {
    if (
      !state.objective ||
      !state.category ||
      campaignLocations(state).length === 0 ||
      state.maximumBudget === null
    ) {
      throw new UmmixApiError('Dados insuficientes para comparação', 422);
    }

    const [radio, tv] = await Promise.all([
      this.calculateChannel(token, state, 'radio'),
      this.calculateChannel(token, state, 'tv'),
    ]);
    const comparison: ChannelComparison = {
      radio,
      tv,
      recommendedChannel: chooseRecommendedChannel(radio, tv),
      rationale: '',
    };
    comparison.rationale = buildRationale(comparison);
    return comparison;
  }

  createDraft(
    token: string,
    payload: { campaignName: string; clientId: string },
  ): Promise<{ id: string; wizardStep: number; updatedAt: string }> {
    return this.request('/campaigns/draft', token, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  updateCampaign(
    token: string,
    campaignId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(`/campaigns/${encodeURIComponent(campaignId)}`, token, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  }

  private async calculateChannel(
    token: string,
    state: CampaignState,
    channel: MediaChannel,
  ): Promise<MediaPlan> {
    try {
      const [calculation, impacts] = await Promise.all([
        this.request<CalculationResponse>('/campaigns/calculate', token, {
          method: 'POST',
          body: JSON.stringify({
            mediaChannel: channel,
            objective: state.objective,
            category: state.category,
            brandStrength: state.brandStrength,
            format: channel === 'radio' ? 'spot' : 'vt',
            duration: String(state.durationSeconds),
            numFilters: Math.max(
              1,
              new Set((state.audienceFilters ?? []).map((filter) => filter.questionId)).size,
            ),
            investment: state.maximumBudget,
          }),
        }),
        this.calculateAudienceImpacts(token, state, channel),
      ]);

      return {
        channel,
        available: true,
        cpm: calculation.cpm,
        frequency: calculation.suggestedFrequency,
        periodWeeks: calculation.suggestedPeriod,
        totalImpressions: calculation.totalImpressions,
        inventory: calculation.inventory,
        audienceImpacts: impacts.totalImpacts,
        projectedLeads: calculation.projectedLeads,
        projectedSales: calculation.projectedSales,
        reasonUnavailable: null,
      };
    } catch (error) {
      return {
        channel,
        available: false,
        cpm: null,
        frequency: null,
        periodWeeks: null,
        totalImpressions: null,
        inventory: null,
        audienceImpacts: null,
        projectedLeads: null,
        projectedSales: null,
        reasonUnavailable: error instanceof Error ? error.message : 'Dados indisponíveis',
      };
    }
  }

  private async getCities(token: string): Promise<CityResponse[]> {
    if (
      this.cityCache &&
      this.cityCache.cities.length > 0 &&
      this.cityCache.expiresAt > Date.now()
    ) {
      return this.cityCache.cities;
    }
    const supportedCities = await this.request<CityResponse[]>(
      '/cities?activeOnly=true&withResponses=false',
      token,
    );
    this.cityCache = {
      cities: supportedCities,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    return supportedCities;
  }

  private async calculateAudienceImpacts(
    token: string,
    state: CampaignState,
    channel: MediaChannel,
  ): Promise<{ totalImpacts: number }> {
    const response = await this.request<{ totalImpactos?: number; totalImpacts?: number }>(
      '/survey/impacts/advanced',
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          demograficos: buildAudienceDemographics(state),
          respostas: groupAudienceFilters(state.audienceFilters ?? []),
          mediaChannel: channel,
        }),
      },
    );
    return {
      totalImpacts: Number(response.totalImpactos ?? response.totalImpacts ?? 0),
    };
  }

  private async request<T>(
    path: string,
    token: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      let message = `Ummix API respondeu HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { message?: string | string[] };
        if (body.message) {
          message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
        }
      } catch {
        // Mantém a mensagem sanitizada; nunca registra token ou corpo bruto.
      }
      throw new UmmixApiError(message, response.status);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

function isAudienceQuestion(question: QuestionResponse): boolean {
  const normalizedTitle = normalize(question.title ?? question.label ?? '');
  const choiceQuestion = !question.type ||
    ['single_choice', 'multiple_choice', 'radio_with_details'].includes(question.type);
  // As perguntas de Perfil & Hábitos também usam `campaign_creation` no
  // Services. O stage, sozinho, não distingue perguntas operacionais das
  // perguntas que devem ser entregues ao LLM para classificar a audiência.
  const flowQuestion = /estado|cidade|pra[cç]a|canal|r[aá]dio|tv|formato|dura[cç][aã]o|investimento|or[cç]amento|objetivo/i.test(
    normalizedTitle,
  );
  return choiceQuestion && !flowQuestion;
}

function toSnapshot(client: UmmixClientResponse): ClientSnapshot {
  return {
    id: client.id,
    fullName: client.fullName,
    companyName: client.companyName ?? null,
    companyBrand: client.companyBrand ?? null,
    businessActivity: client.businessActivity ?? null,
    isActive: client.isActive,
  };
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLocaleLowerCase('pt-BR');
}

export function groupAudienceFilters(filters: AudienceFilterSelection[]) {
  const grouped = new Map<
    string,
    { question: string; questionOriginal?: string; options: Set<string> }
  >();
  for (const filter of filters) {
    const current = grouped.get(filter.questionId) ?? {
      question: filter.question,
      options: new Set<string>(),
    };
    if (filter.questionOriginal && !current.questionOriginal) {
      current.questionOriginal = filter.questionOriginal;
    }
    current.options.add(filter.option);
    grouped.set(filter.questionId, current);
  }
  return [...grouped.values()].map((filter) => ({
    pergunta: filter.question,
    ...(filter.questionOriginal
      ? { perguntaOriginal: filter.questionOriginal }
      : { perguntaOriginal: filter.question }),
    opcoes: [...filter.options],
    operador: 'OR' as const,
  }));
}

export function buildAudienceDemographics(state: CampaignState) {
  const targetAudience = mapAudienceFiltersToTargetAudience(state.audienceFilters ?? []);
  const genderValues = Array.isArray(targetAudience.gender)
    ? targetAudience.gender.map(String)
    : typeof targetAudience.gender === 'string'
      ? [targetAudience.gender]
      : [];
  const ageRanges = Array.isArray(targetAudience.idadeFaixas)
    ? targetAudience.idadeFaixas
        .map((value) => parseAudienceAgeRange(String(value)))
        .filter((range): range is { min: number; max: number } => Boolean(range))
    : [];

  return {
    cidade: campaignLocations(state).map((location) => location.cityId),
    ...(genderValues.length > 0 ? { sexo: [...new Set(genderValues)] } : {}),
    ...(ageRanges.length > 0 ? { faixasEtarias: ageRanges } : {}),
  };
}

function parseAudienceAgeRange(value: string): { min: number; max: number } | null {
  const numbers = value.match(/\d+/g)?.map(Number) ?? [];
  if (numbers.length >= 2 && numbers[0] !== undefined && numbers[1] !== undefined) {
    return { min: numbers[0], max: numbers[1] };
  }
  if (numbers.length === 1 && numbers[0] !== undefined && /\+/.test(value)) {
    return { min: numbers[0], max: 99 };
  }
  return null;
}
