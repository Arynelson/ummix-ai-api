import { createHash, randomBytes } from 'node:crypto';
import type {
  AuthHandoffCreateResponse,
  AuthHandoffExchangeResponse,
} from '@ummix/ai-contracts';
import { HandoffCipher } from './handoff-crypto.js';
import type { HandoffStore } from './handoff-repository.js';

export class HandoffError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HandoffError';
  }
}

export class HandoffService {
  constructor(
    private readonly store: HandoffStore,
    private readonly cipher: HandoffCipher,
    private readonly ttlSeconds: number,
  ) {}

  async create(
    accessToken: string,
    user: Record<string, unknown>,
  ): Promise<AuthHandoffCreateResponse> {
    const handoffToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(handoffToken);
    const encrypted = this.cipher.encrypt({ access_token: accessToken, user }, tokenHash);

    await this.store.save({
      tokenHash,
      ...encrypted,
      expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
    });
    return { handoffToken, expiresIn: this.ttlSeconds };
  }

  async consume(handoffToken: string): Promise<AuthHandoffExchangeResponse> {
    const tokenHash = hashToken(handoffToken);
    const encrypted = await this.store.consume(tokenHash);
    if (!encrypted) {
      throw new HandoffError('Token de handoff inválido ou expirado', 401);
    }

    try {
      return this.cipher.decrypt(encrypted, tokenHash);
    } catch {
      throw new HandoffError('Token de handoff inválido ou expirado', 401);
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
