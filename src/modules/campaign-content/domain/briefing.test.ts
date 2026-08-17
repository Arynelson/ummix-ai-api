import { describe, expect, it } from 'vitest';
import type { CampaignContentCampaignSnapshot } from '@ummix/ai-contracts';
import {
  applyDeterministicAnswer,
  createSessionExpiry,
  missingBriefingFields,
  questionForBriefingField,
} from './briefing.js';

const snapshot = (objective: string): CampaignContentCampaignSnapshot => ({
  campaignName: 'Campanha teste',
  brandName: 'Marca teste',
  objective,
  mediaChannel: 'radio',
  format: 'spot',
  durationSeconds: 30,
  paymentStatus: 'pending_payment',
  startDate: null,
  endDate: '2026-12-01',
  targetAudience: null,
  contextVersion: 'services-ai-content-v1',
});

describe('campaign content briefing rules', () => {
  it('asks for product details when the objective promotes an offer', () => {
    expect(missingBriefingFields(snapshot('promocao_oferta'), {})).toEqual([
      'product_or_service',
      'target_audience',
      'main_benefit',
      'offer_details',
      'validity',
      'call_to_action',
      'tone',
      'restrictions',
    ]);
  });

  it('does not repeat an answered field and stores the next response safely', () => {
    const answers = applyDeterministicAnswer(
      snapshot('lancamento_produto'),
      {},
      'product_or_service',
      'Produto com <informação> que será divulgado',
    );

    expect(answers.product_or_service).toBe('Produto com <informação> que será divulgado');
    expect(missingBriefingFields(snapshot('lancamento_produto'), answers)[0]).toBe('target_audience');
    expect(questionForBriefingField('target_audience')).toContain('Para quem');
  });

  it('retains the conversation until 90 days after the campaign end', () => {
    expect(createSessionExpiry('2026-12-01').toISOString()).toBe('2027-03-01T23:59:59.000Z');
  });
});
