import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CampaignContentCampaignSnapshot,
  CampaignContentLengthPolicy,
} from '@ummix/ai-contracts';
import { CampaignContentGenerator, CampaignContentLlmError } from './content-generator.js';

const snapshot: CampaignContentCampaignSnapshot = {
  campaignName: 'Campanha de teste',
  brandName: 'Marca teste',
  objective: 'promocao_oferta',
  mediaChannel: 'radio',
  format: 'spot',
  durationSeconds: 2,
  paymentStatus: 'pending_payment',
  startDate: null,
  endDate: null,
  targetAudience: null,
  contextVersion: 'test-v1',
};

const policy: CampaignContentLengthPolicy = {
  version: 'pt-br-v1',
  durationSeconds: 2,
  minWords: 2,
  maxWords: 3,
};

const response = (options: Array<{ text: string; style: string }>): Response => new Response(
  JSON.stringify({ output_text: JSON.stringify({ options }) }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CampaignContentGenerator', () => {
  it('envia contexto delimitado e devolve exatamente tres opciones validas', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([
      { text: 'Oferta especial hoje', style: 'direto' },
      { text: 'Descubra novidades agora', style: 'emocional' },
      { text: 'Aproveite esta oportunidade', style: 'promocional' },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const generator = new CampaignContentGenerator('secret-test-key', 'test-model');

    const result = await generator.generate({
      userId: 'user-1',
      campaignSnapshot: snapshot,
      answers: { product_or_service: 'Produto teste' },
      lengthPolicy: policy,
      countWords: (text) => text.trim().split(/\s+/u).length,
      isWithinPolicy: (count, currentPolicy) => count >= currentPolicy.minWords && count <= currentPolicy.maxWords,
    });

    expect(result.options).toHaveLength(3);
    expect(new Set(result.options.map((option) => option.id)).size).toBe(3);
    expect(result.options.every((option) => option.wordCount >= 2 && option.wordCount <= 3)).toBe(true);
    const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(request).toMatchObject({ model: 'test-model', store: false });
    expect(request.instructions).toContain('dados nao confiaveis');
    expect((request.text as { format: { strict: boolean } }).format.strict).toBe(true);
  });

  it('faz uma unica tentativa de correcao sem aceitar opcoes duplicadas ou fora da faixa', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([
        { text: 'Oferta especial hoje', style: 'direto' },
        { text: 'Oferta especial hoje', style: 'emocional' },
        { text: 'Oferta especial hoje', style: 'promocional' },
      ]))
      .mockResolvedValueOnce(response([
        { text: 'Oferta especial hoje', style: 'direto' },
        { text: 'Descubra novidades agora', style: 'emocional' },
        { text: 'Aproveite esta oportunidade', style: 'promocional' },
      ]));
    vi.stubGlobal('fetch', fetchMock);
    const generator = new CampaignContentGenerator('secret-test-key', 'test-model');

    await expect(generator.generate({
      userId: 'user-1',
      campaignSnapshot: snapshot,
      answers: {},
      lengthPolicy: policy,
      countWords: (text) => text.trim().split(/\s+/u).length,
      isWithinPolicy: (count, currentPolicy) => count >= currentPolicy.minWords && count <= currentPolicy.maxWords,
    })).resolves.toMatchObject({ options: expect.any(Array) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falha de forma publica quando as duas tentativas continuam invalidas', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([
      { text: 'Oferta especial hoje', style: 'direto' },
      { text: 'Oferta especial hoje', style: 'emocional' },
      { text: 'Oferta especial hoje', style: 'promocional' },
    ])));
    const generator = new CampaignContentGenerator('secret-test-key', 'test-model');

    await expect(generator.generate({
      userId: 'user-1',
      campaignSnapshot: snapshot,
      answers: {},
      lengthPolicy: policy,
      countWords: (text) => text.trim().split(/\s+/u).length,
      isWithinPolicy: (count, currentPolicy) => count >= currentPolicy.minWords && count <= currentPolicy.maxWords,
    })).rejects.toBeInstanceOf(CampaignContentLlmError);
  });
});
