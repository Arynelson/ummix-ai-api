import { afterEach, describe, expect, it, vi } from 'vitest';
import { CampaignContentContextClient } from './context-client.js';

afterEach(() => vi.unstubAllGlobals());

const context = {
  contractVersion: '1',
  campaignId: '147dad44-1eea-411b-9b5d-1f6467d91712',
  userId: '856918db-6f3d-4375-a95c-715177012cca',
  clientId: '93203443-1fe8-45d0-a90d-8ec96ba8042f',
  campaignName: 'Campanha de inverno',
  brandName: 'Marca teste',
  objective: 'promocao_oferta',
  mediaChannel: 'radio',
  format: 'spot',
  durationSeconds: 30,
  paymentStatus: 'pending_payment',
  canGenerate: true,
  contextVersion: 'services-ai-content-v1',
  startDate: '2026-10-01',
  endDate: '2026-10-30',
  targetAudience: { description: 'Publico local' },
};

describe('CampaignContentContextClient', () => {
  it('requests only the versioned campaign context with both auth headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(context), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new CampaignContentContextClient('http://services.test/api', 'service-secret');

    await expect(client.getCampaignContext(context.campaignId, 'user-token')).resolves.toEqual(context);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://services.test/api/integrations/campaigns/147dad44-1eea-411b-9b5d-1f6467d91712/ai-content/context',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer user-token',
          'Content-Type': 'application/json',
          'x-service-token': 'service-secret',
        },
      }),
    );
  });

  it('does not expose upstream response details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'password=secret' }), { status: 500 }),
    ));
    const client = new CampaignContentContextClient('http://services.test/api');

    await expect(client.getCampaignContext(context.campaignId, 'user-token'))
      .rejects.toMatchObject({ status: 502 });
  });

  it('does not attach a service token when it was not configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(context), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new CampaignContentContextClient('http://services.test/api');

    await client.getCampaignContext(context.campaignId, 'user-token');

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Authorization: 'Bearer user-token',
        'Content-Type': 'application/json',
      },
    });
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)['x-service-token'])
      .toBeUndefined();
  });

  it('converts forbidden context responses into a stable public error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'internal owner details' }), { status: 403 }),
    ));
    const client = new CampaignContentContextClient('http://services.test/api');

    await expect(client.getCampaignContext(context.campaignId, 'user-token'))
      .rejects.toMatchObject({ status: 403 });
  });

  it('rejects a response that does not satisfy the versioned contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...context, durationSeconds: 0 }), { status: 200 }),
    ));
    const client = new CampaignContentContextClient('http://services.test/api');

    await expect(client.getCampaignContext(context.campaignId, 'user-token'))
      .rejects.toMatchObject({ status: 502 });
  });
});
