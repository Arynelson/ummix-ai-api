import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../config.js';
import { renderCampaignContentEmail } from './campaign-content-email.js';
import { CampaignContentEmailProvider } from './campaign-content-email-provider.js';

const input = {
  campaignId: '147dad44-1eea-411b-9b5d-1f6467d91712',
  contentId: 'b80b6c68-57cf-45b0-9605-70d53c4dfc1b',
  campaignSnapshot: {
    campaignName: '<Campanha>',
    brandName: 'Marca teste',
    objective: 'promocao_oferta',
    mediaChannel: 'radio' as const,
    format: 'spot',
    durationSeconds: 30,
    paymentStatus: 'pending_payment',
    startDate: null,
    endDate: null,
    targetAudience: null,
    contextVersion: 'services-ai-content-v1',
  },
  selectedTextOriginal: 'Texto original escolhido',
  finalText: '<script>alert(1)</script>',
  isEdited: true,
  wordCount: 70,
  lengthPolicy: {
    version: 'pt-br-v1',
    durationSeconds: 30,
    minWords: 66,
    maxWords: 78,
  },
};

const config = (overrides: Record<string, unknown> = {}): AppConfig => ({
  CAMPAIGN_CONTENT_EMAIL_ENABLED: true,
  CAMPAIGN_CONTENT_ADMIN_EMAILS: ['falecoma@ummix.com.br', 'tecnologia@ummix.com.br'],
  CAMPAIGN_CONTENT_EMAIL_API_KEY: 'brevo-test-key',
  CAMPAIGN_CONTENT_EMAIL_API_URL: 'https://email.test/v3/smtp/email',
  CAMPAIGN_CONTENT_EMAIL_FROM: 'noreply@ummix.com.br',
  CAMPAIGN_CONTENT_EMAIL_FROM_NAME: 'Ummix Ads',
  CAMPAIGN_CONTENT_EMAIL_TIMEOUT_MS: 10_000,
  ...overrides,
} as AppConfig);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('campaign content administrative email', () => {
  it('escapes user content in HTML and keeps a plain-text alternative', () => {
    const rendered = renderCampaignContentEmail(input);

    expect(rendered.htmlContent).not.toContain('<script>alert(1)</script>');
    expect(rendered.htmlContent).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(rendered.textContent).toContain('<script>alert(1)</script>');
    expect(rendered.subject).not.toMatch(/[\r\n]/u);
  });

  it('sends one notification to the configured administrative recipients', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new CampaignContentEmailProvider(config());

    await provider.send(input);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://email.test/v3/smtp/email',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'api-key': 'brevo-test-key' }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<string, any>;
    expect(body.to).toEqual([
      { email: 'falecoma@ummix.com.br' },
      { email: 'tecnologia@ummix.com.br' },
    ]);
    expect(body.textContent).toContain('TEXTO FINAL');
  });

  it('does not call the provider while the feature is disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new CampaignContentEmailProvider(config({
      CAMPAIGN_CONTENT_EMAIL_ENABLED: false,
    }));

    await provider.send(input);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails without sender or API key without exposing configuration values', async () => {
    const provider = new CampaignContentEmailProvider(config({
      CAMPAIGN_CONTENT_EMAIL_API_KEY: undefined,
      CAMPAIGN_CONTENT_EMAIL_FROM: undefined,
    }));

    await expect(provider.send(input)).rejects.toThrow(
      'Notificação administrativa sem configuração de remetente, destinatários ou provedor.',
    );
  });
});
