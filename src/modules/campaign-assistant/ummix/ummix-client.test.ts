import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CampaignState } from '../domain/types.js';
import {
  buildAudienceDemographics,
  groupAudienceFilters,
  UmmixClient,
} from './ummix-client.js';

describe('Ummix audience impact payload', () => {
  it('materializes catalog gender and age filters in native demographic fields', () => {
    expect(
      buildAudienceDemographics({
        locations: [{ cityId: 'city-id', cityName: 'Goiânia', stateUf: 'GO' }],
        audienceFilters: [
          {
            questionId: 'gender-question',
            question: 'Gênero',
            optionId: 'female',
            option: 'Feminino',
          },
          {
            questionId: 'age-question',
            question: 'Faixa etária',
            optionId: 'age-30-34',
            option: '30-34',
          },
        ],
      } as CampaignState),
    ).toEqual({
      cidade: ['city-id'],
      sexo: ['Feminino'],
      faixasEtarias: [{ min: 30, max: 34 }],
    });
  });

  it('uses the original services question while retaining the friendly label', () => {
    expect(
      groupAudienceFilters([
        {
          questionId: 'question-id',
          question: 'Faixa etária',
          questionOriginal: 'P3. Qual sua idade?',
          optionId: 'option-id',
          option: '30 a 34 anos',
        },
      ]),
    ).toEqual([
      {
        pergunta: 'Faixa etária',
        perguntaOriginal: 'P3. Qual sua idade?',
        opcoes: ['30 a 34 anos'],
        operador: 'OR',
      },
    ]);
  });
});

describe('Ummix audience catalog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps audience questions in campaign_creation while excluding operational questions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'age-question',
            title: 'Faixa etária',
            category: 'perfil_habitos',
            stage: 'campaign_creation',
            type: 'single_choice',
            options: [{ id: 'age-option', text: '25 a 29' }],
          },
          {
            id: 'city-question',
            title: 'Selecione a Cidade',
            category: 'alcance_campanha',
            stage: 'campaign_creation',
            type: 'single_choice',
            options: [{ id: 'city-option', text: 'Goiânia' }],
          },
          {
            id: 'channel-question',
            title: 'Escolha Rádio ou TV',
            category: 'alcance_campanha',
            stage: 'campaign_creation',
            type: 'single_choice',
            options: [{ id: 'radio-option', text: 'Rádio' }],
          },
        ],
      }),
    );

    const catalog = await new UmmixClient('https://services.test').getAudienceCatalog('service-token');

    expect(catalog).toEqual([
      {
        questionId: 'age-question',
        question: 'Faixa etária',
        category: 'perfil_habitos',
        optionId: 'age-option',
        option: '25 a 29',
      },
    ]);
  });
});
