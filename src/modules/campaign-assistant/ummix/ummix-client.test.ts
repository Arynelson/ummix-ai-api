import { describe, expect, it } from 'vitest';
import { groupAudienceFilters } from './ummix-client.js';

describe('Ummix audience impact payload', () => {
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
