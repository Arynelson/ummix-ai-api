import type {
  CampaignContentChannel,
  CampaignContentLengthPolicy,
} from '@ummix/ai-contracts';

export interface CampaignContentLengthPolicyConfig {
  version: string;
  minWordsPerSecond: number;
  maxWordsPerSecond: number;
}

export class CampaignContentLengthPolicyService {
  constructor(private readonly config: CampaignContentLengthPolicyConfig) {}

  getPolicy(
    mediaChannel: CampaignContentChannel | null,
    radioDuration: string | number | null,
    tvDuration: string | number | null,
  ): CampaignContentLengthPolicy {
    const radio = Number(radioDuration || 0);
    const tv = Number(tvDuration || 0);
    const durationSeconds = mediaChannel === 'tv'
      ? tv
      : mediaChannel === 'both'
        ? Math.max(radio, tv)
        : radio || tv;

    if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
      throw new Error('Campanha sem duracao de veiculacao valida.');
    }

    const { minWordsPerSecond, maxWordsPerSecond } = this.config;
    if (!Number.isFinite(minWordsPerSecond) || minWordsPerSecond <= 0) {
      throw new Error('Politica de duracao invalida: limite minimo deve ser positivo.');
    }
    if (!Number.isFinite(maxWordsPerSecond) || maxWordsPerSecond <= 0) {
      throw new Error('Politica de duracao invalida: limite maximo deve ser positivo.');
    }
    if (maxWordsPerSecond < minWordsPerSecond) {
      throw new Error('Politica de duracao invalida: limite maximo menor que o minimo.');
    }

    const minWords = Math.ceil(durationSeconds * minWordsPerSecond);
    const maxWords = Math.max(minWords, Math.floor(durationSeconds * maxWordsPerSecond));

    return {
      version: this.config.version,
      durationSeconds,
      minWords,
      maxWords,
    };
  }

  getPolicyForDuration(
    mediaChannel: CampaignContentChannel,
    durationSeconds: number,
  ): CampaignContentLengthPolicy {
    return this.getPolicy(
      mediaChannel,
      mediaChannel === 'tv' ? null : durationSeconds,
      mediaChannel === 'radio' ? null : durationSeconds,
    );
  }

  countWords(text: string): number {
    const normalized = text.trim();
    return normalized ? normalized.split(/\s+/u).length : 0;
  }

  isWithinPolicy(wordCount: number, policy: CampaignContentLengthPolicy): boolean {
    return wordCount >= policy.minWords && wordCount <= policy.maxWords;
  }
}
