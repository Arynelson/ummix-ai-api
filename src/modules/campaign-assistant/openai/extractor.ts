import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CHANNELS, OBJECTIVES, type CampaignState, type ExtractedCampaignPatch } from '../domain/types.js';

const extractionSchema = z.object({
  productService: z.string().max(240).nullable(),
  objective: z.enum(OBJECTIVES).nullable(),
  audienceDescription: z.string().max(500).nullable(),
  cityName: z.string().max(120).nullable(),
  stateUf: z.string().max(2).nullable(),
  maximumBudget: z.number().nonnegative().nullable(),
  desiredStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  selectedChannel: z.enum(CHANNELS).nullable(),
});

const jsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    productService: { type: ['string', 'null'], maxLength: 240 },
    objective: { type: ['string', 'null'], enum: [...OBJECTIVES, null] },
    audienceDescription: { type: ['string', 'null'], maxLength: 500 },
    cityName: { type: ['string', 'null'], maxLength: 120 },
    stateUf: { type: ['string', 'null'], maxLength: 2 },
    maximumBudget: { type: ['number', 'null'], minimum: 0 },
    desiredStartDate: {
      type: ['string', 'null'],
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    },
    selectedChannel: { type: ['string', 'null'], enum: [...CHANNELS, null] },
  },
  required: [
    'productService',
    'objective',
    'audienceDescription',
    'cityName',
    'stateUf',
    'maximumBudget',
    'desiredStartDate',
    'selectedChannel',
  ],
} as const;

export class OpenAIUnavailableError extends Error {
  constructor(message = 'OpenAI indisponível') {
    super(message);
    this.name = 'OpenAIUnavailableError';
  }
}

export class CampaignBriefExtractor {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
  ) {}

  async extract(input: {
    message: string;
    currentState: CampaignState;
    userId: string;
  }): Promise<ExtractedCampaignPatch> {
    if (!this.apiKey?.trim()) {
      throw new OpenAIUnavailableError('OPENAI_API_KEY não configurada');
    }

    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          store: false,
          safety_identifier: createHash('sha256').update(input.userId).digest('hex'),
          reasoning: { effort: 'low' },
          text: {
            verbosity: 'low',
            format: {
              type: 'json_schema',
              name: 'campaign_brief_patch',
              strict: true,
              schema: jsonSchema,
            },
          },
          instructions: [
            'Você extrai dados de mensagens em pt-BR para um assistente de campanhas de Rádio e TV.',
            'Retorne somente fatos que o usuário afirmou nesta mensagem.',
            'Use null quando o campo não foi informado; não repita valores apenas porque aparecem no estado atual.',
            'Mapeie objetivos somente para reconhecimento_marca, lancamento_produto ou promocao_oferta.',
            'Mapeie canal somente quando o usuário escolher explicitamente Rádio ou TV.',
            'Converta valores monetários brasileiros para número e datas relativas para YYYY-MM-DD usando a data de referência.',
            'Nunca invente cidade, categoria, preço, audiência, frequência, período ou alcance.',
          ].join(' '),
          input: JSON.stringify({
            referenceDate: new Date().toISOString().slice(0, 10),
            currentState: input.currentState,
            userMessage: input.message,
          }),
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new OpenAIUnavailableError('Falha ao conectar com a OpenAI');
    }

    if (!response.ok) {
      throw new OpenAIUnavailableError(`OpenAI respondeu HTTP ${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const outputText = readOutputText(payload);
    if (!outputText) throw new OpenAIUnavailableError('OpenAI não retornou saída estruturada');

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(outputText);
    } catch {
      throw new OpenAIUnavailableError('OpenAI retornou JSON inválido');
    }
    const parsed = extractionSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new OpenAIUnavailableError('Saída estruturada inválida');
    }
    return parsed.data;
  }
}

function readOutputText(payload: Record<string, unknown>): string | null {
  if (typeof payload.output_text === 'string') return payload.output_text;
  if (!Array.isArray(payload.output)) return null;

  for (const item of payload.output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part &&
        typeof part === 'object' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        return (part as { text: string }).text;
      }
    }
  }
  return null;
}
