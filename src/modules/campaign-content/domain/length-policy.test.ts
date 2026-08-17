import { describe, expect, it } from 'vitest';
import { CampaignContentLengthPolicyService } from './length-policy.js';

const makeService = (
  overrides: Partial<ConstructorParameters<typeof CampaignContentLengthPolicyService>[0]> = {},
) => new CampaignContentLengthPolicyService({
  version: 'pt-br-v1',
  minWordsPerSecond: 2.2,
  maxWordsPerSecond: 2.6,
  ...overrides,
});

describe('CampaignContentLengthPolicyService', () => {
  it('calcula 66 a 78 palavras para um spot de radio de 30 segundos', () => {
    expect(makeService().getPolicy('radio', '30', null)).toEqual({
      version: 'pt-br-v1',
      durationSeconds: 30,
      minWords: 66,
      maxWords: 78,
    });
  });

  it('preserva a regra legada de maior duracao quando a campanha usa ambos os canais', () => {
    expect(makeService().getPolicy('both', '30', '60').durationSeconds).toBe(60);
  });

  it('calcula a politica a partir do snapshot normalizado da campanha', () => {
    expect(makeService().getPolicyForDuration('tv', 30)).toMatchObject({
      durationSeconds: 30,
      minWords: 66,
      maxWords: 78,
    });
  });

  it('permite calibrar a politica sem alterar o frontend', () => {
    expect(makeService({
      version: 'pt-br-v2',
      minWordsPerSecond: 2,
      maxWordsPerSecond: 2.5,
    }).getPolicy('tv', null, 30)).toMatchObject({
      version: 'pt-br-v2',
      minWords: 60,
      maxWords: 75,
    });
  });

  it('rejeita configuracao invalida e duracao ausente', () => {
    expect(() => makeService({ minWordsPerSecond: 3 }).getPolicy('radio', 30, null))
      .toThrow('limite maximo menor que o minimo');
    expect(() => makeService().getPolicy('tv', null, null))
      .toThrow('Campanha sem duracao');
  });

  it('conta palavras e valida os limites inclusivos', () => {
    const service = makeService();
    const policy = service.getPolicy('radio', 1, null);

    expect(service.countWords('  uma   frase curta  ')).toBe(3);
    expect(service.isWithinPolicy(3, policy)).toBe(true);
    expect(service.isWithinPolicy(2, policy)).toBe(false);
  });
});
