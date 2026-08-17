import {
  buildRationale,
  campaignLocations,
  chooseRecommendedChannel,
} from '../domain/state-machine.js';
import type {
  CampaignLocation,
  CampaignState,
  ChannelComparison,
  ClientSnapshot,
  MediaChannel,
  MediaPlan,
} from '../domain/types.js';

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
  state?: { uf?: string | null };
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
    const cities = await this.getCities(token);
    const wantedCity = normalize(cityName);
    const wantedUf = stateUf?.trim().toUpperCase() ?? null;
    const matches = cities.filter(
      (city) =>
        normalize(city.name) === wantedCity &&
        (!wantedUf || city.state?.uf?.toUpperCase() === wantedUf),
    );
    if (matches.length !== 1) return null;
    const match = matches[0];
    if (!match) return null;
    return {
      cityId: match.id,
      cityName: match.name,
      stateUf: match.state?.uf?.toUpperCase() ?? wantedUf,
    };
  }

  async getAvailableLocations(token: string): Promise<CampaignLocation[]> {
    const cities = await this.getCities(token);
    return cities.map((city) => ({
      cityId: city.id,
      cityName: city.name,
      stateUf: city.state?.uf?.toUpperCase() ?? null,
    }));
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
      const locations = campaignLocations(state);
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
            numFilters: 1,
            investment: state.maximumBudget,
          }),
        }),
        Promise.all(
          locations.map((location) =>
            this.request<{ totalImpacts: number }>(
              `/survey/impacts?city=${encodeURIComponent(location.cityName)}&mediaChannel=${channel}`,
              token,
            ).catch(() => ({ totalImpacts: 0 })),
          ),
        ).then((results) => ({
          totalImpacts: results.reduce((total, result) => total + result.totalImpacts, 0),
        })),
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
    const [cities, radioLocations, tvLocations] = await Promise.all([
      this.request<CityResponse[]>('/cities?activeOnly=true&withResponses=false', token),
      this.request<string[]>('/cpm/locations/RADIO', token).catch(() => []),
      this.request<string[]>('/cpm/locations/TV', token).catch(() => []),
    ]);
    const inventoryLocations = new Set(
      [...radioLocations, ...tvLocations].map((location) => normalize(location)),
    );
    const supportedCities =
      inventoryLocations.size > 0
        ? cities.filter((city) => inventoryLocations.has(normalize(city.name)))
        : cities;
    this.cityCache = {
      cities: supportedCities,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    return supportedCities;
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
