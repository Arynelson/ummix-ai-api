import { describe, expect, it } from 'vitest';
import {
  currentDateInBrazil,
  normalizeContextualPatch,
} from './contextual-input.js';
import type { ExtractedCampaignPatch } from './types.js';

const emptyPatch: ExtractedCampaignPatch = {
  productService: null,
  objective: null,
  audienceDescription: null,
  audienceFilters: [],
  cityName: null,
  stateUf: null,
  maximumBudget: null,
  desiredStartDate: null,
  selectedChannel: null,
};

describe('campaign assistant contextual input', () => {
  it.each([
    ['5000', 5000],
    ['5.000', 5000],
    ['5.000,50', 5000.5],
  ])('interprets a bare number as BRL during the budget question', (message, expected) => {
    const result = normalizeContextualPatch(emptyPatch, {
      message,
      currentField: 'maximumBudget',
      referenceDate: '2026-08-21',
    });

    expect(result.maximumBudget).toBe(expected);
  });

  it.each([
    'o mais rápido possível',
    'o mais breve possível',
    'quero começar o mais rápido possível',
  ])(
    'schedules urgent requests four business days after the response: %s',
    (message) => {
      const result = normalizeContextualPatch(emptyPatch, {
        message,
        currentField: 'desiredStartDate',
        referenceDate: '2026-08-21',
      });

      expect(result.desiredStartDate).toBe('2026-08-27');
    },
  );

  it('does not reinterpret a number outside the budget question', () => {
    const result = normalizeContextualPatch(emptyPatch, {
      message: '5000',
      currentField: 'audienceDescription',
      referenceDate: '2026-08-21',
    });

    expect(result.maximumBudget).toBeNull();
  });

  it('uses the Brazilian response date around the UTC day boundary', () => {
    expect(currentDateInBrazil(new Date('2026-08-20T01:30:00Z'))).toBe('2026-08-19');
  });
});
