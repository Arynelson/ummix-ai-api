import { describe, expect, it } from 'vitest';
import { mapAudienceFiltersToTargetAudience } from './audience-filter-mapper.js';

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
