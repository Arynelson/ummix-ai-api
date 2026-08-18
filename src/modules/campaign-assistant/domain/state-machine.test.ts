import { describe, expect, it } from 'vitest';
import {
  applyExtractedPatch,
  initialState,
  isReadyToFinalize,
  missingFields,
  nextAssistantTurn,
} from './state-machine.js';
import type { CampaignState } from './types.js';

describe('campaign assistant state machine', () => {
  it('keeps the budget as an exact hard cap and blocks values below the minimum', () => {
    const state = applyExtractedPatch(initialState(500, 'varejo'), {
      productService: 'Liquidação de inverno',
      objective: 'promocao_oferta',
      audienceDescription: null,
      cityName: null,
      stateUf: null,
      maximumBudget: 499.999,
      desiredStartDate: null,
      selectedChannel: null,
    });

    expect(state.maximumBudget).toBe(500);
    expect(missingFields(state)).not.toContain('maximumBudget');
  });

  it('does not accept values outside the supported enums', () => {
    const state = applyExtractedPatch(initialState(100, 'categoria_livre'), {
      productService: null,
      objective: 'invalido' as never,
      audienceDescription: null,
      cityName: null,
      stateUf: null,
      maximumBudget: null,
      desiredStartDate: null,
      selectedChannel: 'digital' as never,
    });

    expect(state.objective).toBeNull();
    expect(state.selectedChannel).toBeNull();
    expect(state.category).toBeNull();
  });

  it('only becomes ready with comparison and explicit channel selection', () => {
    const state = initialState(100, 'varejo');
    expect(isReadyToFinalize(state)).toBe(false);
  });

  it('starts with the objective question', () => {
    const turn = nextAssistantTurn(initialState(100, 'varejo'));

    expect(turn.message).toBe(
      'Qual é o principal objetivo da campanha: fortalecer a marca, lançar um produto ou promover uma oferta?',
    );
    expect(turn.quickReplies).toEqual([
      'Fortalecer a marca',
      'Lançar um produto',
      'Promover uma oferta',
    ]);
  });

  it('asks for the city after the objective and before the product', () => {
    const option = { cityId: 'city', cityName: 'Goiânia', stateUf: 'GO' };
    const state = {
      ...initialState(100, 'varejo', [option]),
      objective: 'reconhecimento_marca' as const,
    };

    const turn = nextAssistantTurn(state);

    expect(turn.message).toContain('Seu negócio ou comércio fica ou atende clientes');
    expect(turn.quickReplies).toEqual([]);

    const afterCity = {
      ...state,
      location: option,
      locations: [option],
    };
    const productTurn = nextAssistantTurn(afterCity, { clientName: 'Empresa' });
    expect(productTurn.message).toBe(
      'Vamos montar uma campanha para Empresa. Qual produto ou serviço você quer divulgar nesta campanha?',
    );
    expect(productTurn.quickReplies).toEqual([]);
  });

  it('does not calculate the channel comparison before audience and start date', () => {
    const state = {
      ...initialState(100, 'varejo'),
      productService: 'Consultoria financeira',
      objective: 'reconhecimento_marca' as const,
      location: { cityId: 'city', cityName: 'Goiânia', stateUf: 'GO' },
      locations: [{ cityId: 'city', cityName: 'Goiânia', stateUf: 'GO' }],
      maximumBudget: 1000,
    };

    expect(nextAssistantTurn(state).message).toContain('descreveria o público');
  });

  it('offers structured location selection and then asks only for the audience', () => {
    const option = {
      cityId: 'f8c964d8-3f74-49ff-83fe-6e23421ee884',
      cityName: 'Goiânia',
      stateUf: 'GO',
    };
    const waitingForLocation = {
      ...initialState(100, 'varejo', [option]),
      productService: 'Consultoria financeira',
      objective: 'reconhecimento_marca' as const,
    };

    expect(nextAssistantTurn(waitingForLocation).message).toContain(
      'Selecione as praças disponíveis',
    );

    const waitingForAudience = {
      ...waitingForLocation,
      location: option,
      locations: [option],
    };
    const turn = nextAssistantTurn(waitingForAudience);

    expect(turn.message).toContain('descreveria o público');
    expect(turn.message).not.toContain('qual cidade');
  });

  it('accepts multiple validated locations as a completed location field', () => {
    const state = {
      ...initialState(100, 'varejo'),
      locations: [
        {
          cityId: 'f8c964d8-3f74-49ff-83fe-6e23421ee884',
          cityName: 'Goiânia',
          stateUf: 'GO',
        },
        {
          cityId: '3d7201b0-78f9-4b40-b15c-9f9704527964',
          cityName: 'Anápolis',
          stateUf: 'GO',
        },
      ],
    };

    expect(missingFields(state)).not.toContain('location');
  });

  it('does not finalize when the selected channel has no calculated inventory', () => {
    const basePlan = {
      channel: 'radio' as const,
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
    };
    const state = {
      ...initialState(100, 'varejo'),
      productService: 'Oferta',
      objective: 'promocao_oferta' as const,
      audienceDescription: 'Adultos',
      location: { cityId: 'city', cityName: 'Goiânia', stateUf: 'GO' },
      maximumBudget: 1000,
      desiredStartDate: '2026-08-15',
      selectedChannel: 'radio' as const,
      comparison: {
        radio: basePlan,
        tv: { ...basePlan, channel: 'tv' as const },
        recommendedChannel: null,
        rationale: 'Sem dados',
      },
    };

    expect(isReadyToFinalize(state)).toBe(false);
    expect(nextAssistantTurn(state).quickReplies).toEqual([]);
  });

  it('preserves a channel explicitly selected in the same message that changes inputs', () => {
    const current: CampaignState = {
      ...initialState(100, 'varejo'),
      productService: 'Oferta',
      objective: 'promocao_oferta' as const,
      audienceDescription: 'Adultos',
      location: { cityId: 'city', cityName: 'Goiânia', stateUf: 'GO' },
      locations: [{ cityId: 'city', cityName: 'Goiânia', stateUf: 'GO' }],
      maximumBudget: 1000,
      desiredStartDate: '2026-08-15',
      selectedChannel: 'radio' as const,
      comparison: {
        radio: { channel: 'radio' as const, available: true },
        tv: { channel: 'tv' as const, available: true },
        recommendedChannel: 'radio' as const,
        rationale: 'Rádio',
      },
    } as CampaignState;

    const next = applyExtractedPatch(current, {
      productService: null,
      objective: null,
      audienceDescription: 'Adultos interessados em tecnologia',
      audienceFilters: [],
      cityName: null,
      stateUf: null,
      maximumBudget: 1200,
      desiredStartDate: null,
      selectedChannel: 'radio',
    });

    expect(next.selectedChannel).toBe('radio');
    expect(next.comparison).toBeNull();
  });
});
