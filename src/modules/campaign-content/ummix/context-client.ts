import type { CampaignContentContext } from '@ummix/ai-contracts';
import { z } from 'zod';

const contextSchema = z.object({
  contractVersion: z.literal('1'),
  campaignId: z.string().uuid(),
  userId: z.string().uuid(),
  clientId: z.string().uuid(),
  campaignName: z.string().nullable(),
  brandName: z.string().nullable(),
  objective: z.string().nullable(),
  mediaChannel: z.enum(['radio', 'tv', 'both']),
  format: z.string().nullable(),
  durationSeconds: z.number().int().positive(),
  paymentStatus: z.string().min(1),
  canGenerate: z.boolean(),
  contextVersion: z.string().min(1),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  targetAudience: z.record(z.string(), z.unknown()).nullable(),
});

export class CampaignContentContextError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CampaignContentContextError';
  }
}

export class CampaignContentContextClient {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken?: string,
  ) {}

  async getCampaignContext(
    campaignId: string,
    accessToken: string,
  ): Promise<CampaignContentContext> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    if (this.serviceToken) headers['x-service-token'] = this.serviceToken;

    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/integrations/campaigns/${encodeURIComponent(campaignId)}/ai-content/context`,
        { headers, signal: AbortSignal.timeout(10_000) },
      );
    } catch {
      throw new CampaignContentContextError('Serviço de campanhas indisponível.', 502);
    }

    if (!response.ok) {
      const status = response.status === 401 || response.status === 403
        ? response.status
        : response.status === 404
          ? 404
          : 502;
      throw new CampaignContentContextError(
        status === 404
          ? 'Campanha não encontrada.'
          : status === 403
            ? 'Você não pode acessar esta campanha.'
            : status === 401
              ? 'Sessão Ummix inválida ou expirada.'
              : 'Serviço de campanhas indisponível.',
        status,
      );
    }

    try {
      return contextSchema.parse(await response.json());
    } catch {
      throw new CampaignContentContextError('Contexto da campanha inválido.', 502);
    }
  }
}
