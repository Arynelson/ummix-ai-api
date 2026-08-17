import type { AppConfig } from '../../../config.js';
import {
  renderCampaignContentEmail,
  type CampaignContentEmailInput,
} from './campaign-content-email.js';

export class CampaignContentEmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CampaignContentEmailConfigError';
  }
}

export class CampaignContentEmailProvider {
  constructor(private readonly config: AppConfig) {}

  isEnabled(): boolean {
    return this.config.CAMPAIGN_CONTENT_EMAIL_ENABLED;
  }

  async send(input: CampaignContentEmailInput): Promise<void> {
    if (!this.isEnabled()) return;

    const apiKey = this.config.CAMPAIGN_CONTENT_EMAIL_API_KEY?.trim();
    const from = this.config.CAMPAIGN_CONTENT_EMAIL_FROM?.trim();
    const recipients = this.config.CAMPAIGN_CONTENT_ADMIN_EMAILS;
    if (!apiKey || !from || recipients.length === 0) {
      throw new CampaignContentEmailConfigError(
        'Notificação administrativa sem configuração de remetente, destinatários ou provedor.',
      );
    }

    const rendered = renderCampaignContentEmail(input);
    let response: Response;
    try {
      response = await fetch(this.config.CAMPAIGN_CONTENT_EMAIL_API_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'api-key': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sender: {
            email: from,
            name: this.config.CAMPAIGN_CONTENT_EMAIL_FROM_NAME,
          },
          to: recipients.map((email) => ({ email })),
          subject: rendered.subject,
          htmlContent: rendered.htmlContent,
          textContent: rendered.textContent,
        }),
        signal: AbortSignal.timeout(this.config.CAMPAIGN_CONTENT_EMAIL_TIMEOUT_MS),
      });
    } catch {
      throw new Error('Provedor de e-mail administrativo indisponível.');
    }

    if (!response.ok) {
      throw new Error(`Provedor de e-mail administrativo respondeu HTTP ${response.status}.`);
    }
  }
}
