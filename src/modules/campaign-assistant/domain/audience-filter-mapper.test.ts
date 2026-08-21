import { describe, expect, it } from 'vitest';
import {
  inferNaturalAudienceFilters,
  mapAudienceFiltersToTargetAudience,
} from './audience-filter-mapper.js';

describe('audience filter mapper', () => {
  it('maps catalog answers to the canonical Perfil & Hábitos fields', () => {
    const result = mapAudienceFiltersToTargetAudience([
      {
        questionId: 'age-question',
        question: 'Faixa etária',
        questionOriginal: 'P3. Qual sua idade?',
        optionId: 'age-option',
        option: '30 a 34 anos',
      },
      {
        questionId: 'income-question',
        question: 'Renda familiar',
        questionOriginal: 'P4. Renda familiar mensal',
        optionId: 'income-option',
        option: 'R$ 2.001 a R$ 5.000',
      },
      {
        questionId: 'children-question',
        question: 'Possui filhos?',
        questionOriginal: 'P5. Possui filhos?',
        optionId: 'children-option',
        option: 'Sim',
      },
      {
        questionId: 'occupation-question',
        question: 'Ocupação',
        optionId: 'occupation-option',
        option: 'Estudante',
      },
    ]);

    expect(result).toMatchObject({
      idadeFaixas: ['30-34'],
      renda: ['R$ 2.001 - R$ 5.000'],
      filhos: 'sim',
      ocupacao: ['Estudante'],
    });
    expect(result.selections).toEqual([
      {
        question: 'Faixa etária',
        answers: ['30 a 34 anos'],
      },
      {
        question: 'Renda familiar',
        answers: ['R$ 2.001 a R$ 5.000'],
      },
      {
        question: 'Possui filhos?',
        answers: ['Sim'],
      },
      {
        question: 'Ocupação',
        answers: ['Estudante'],
      },
    ]);
  });

  it('infers gender and all catalog age ranges below a natural-language limit', () => {
    const result = inferNaturalAudienceFilters('Mulheres com menos de 40 anos', [
      {
        questionId: 'gender-question',
        question: 'Gênero',
        category: 'perfil_habitos',
        optionId: 'female-option',
        option: 'Feminino',
      },
      ...['15-20', '21-24', '25-29', '30-34', '35-39', '40-44'].map((option) => ({
        questionId: 'age-question',
        question: 'Faixa etária',
        category: 'perfil_habitos',
        optionId: `age-${option}`,
        option,
      })),
    ]);

    expect(result.map((filter) => filter.option)).toEqual([
      'Feminino',
      '15-20',
      '21-24',
      '25-29',
      '30-34',
      '35-39',
    ]);
  });

  it('does not invent filters when the catalog has no matching options', () => {
    expect(
      inferNaturalAudienceFilters('Mulheres com menos de 40 anos', [
        {
          questionId: 'age-question',
          question: 'Faixa etária',
          category: 'perfil_habitos',
          optionId: 'age-40',
          option: '40-44',
        },
      ]),
    ).toEqual([]);
  });

  it('keeps a catalog option in selections even when no UI field mapping exists', () => {
    const result = mapAudienceFiltersToTargetAudience([
      {
        questionId: 'unknown-question',
        question: 'Qual marca de celular você utiliza?',
        questionOriginal: 'P99. Marca de celular',
        optionId: 'unknown-option',
        option: 'Outra',
      },
    ]);

    expect(result).toEqual({
      selections: [
        {
          question: 'Qual marca de celular você utiliza?',
          answers: ['Outra'],
        },
      ],
    });
  });
});
