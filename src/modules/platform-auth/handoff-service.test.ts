import { describe, expect, it } from 'vitest';
import { HandoffCipher } from './handoff-crypto.js';
import type {
  HandoffStore,
  StoredHandoff,
} from './handoff-repository.js';
import { HandoffService } from './handoff-service.js';

class MemoryHandoffStore implements HandoffStore {
  readonly records = new Map<string, StoredHandoff>();

  async save(handoff: StoredHandoff): Promise<void> {
    this.records.set(handoff.tokenHash, handoff);
  }

  async consume(tokenHash: string) {
    const record = this.records.get(tokenHash);
    this.records.delete(tokenHash);
    if (!record || record.expiresAt <= new Date()) return null;
    return {
      ciphertext: record.ciphertext,
      iv: record.iv,
      authTag: record.authTag,
    };
  }

  async purgeExpired(): Promise<number> {
    let removed = 0;
    for (const [tokenHash, record] of this.records) {
      if (record.expiresAt <= new Date()) {
        this.records.delete(tokenHash);
        removed += 1;
      }
    }
    return removed;
  }
}

describe('HandoffService', () => {
  it('stores an encrypted token and consumes it exactly once', async () => {
    const store = new MemoryHandoffStore();
    const service = new HandoffService(
      store,
      new HandoffCipher(Buffer.alloc(32, 7).toString('base64')),
      60,
    );

    const created = await service.create('access-token-secret', { id: 'user-1' });
    const stored = [...store.records.values()][0];

    expect(created.handoffToken).toMatch(/^[a-f0-9]{64}$/);
    expect(created.expiresIn).toBe(60);
    expect(stored?.tokenHash).not.toBe(created.handoffToken);
    expect(stored?.ciphertext).not.toContain('access-token-secret');
    await expect(service.consume(created.handoffToken)).resolves.toEqual({
      access_token: 'access-token-secret',
      user: { id: 'user-1' },
    });
    await expect(service.consume(created.handoffToken)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects a tampered encrypted payload without exposing crypto details', async () => {
    const store = new MemoryHandoffStore();
    const service = new HandoffService(
      store,
      new HandoffCipher(Buffer.alloc(32, 9).toString('base64')),
      60,
    );
    const created = await service.create('access-token-secret', { id: 'user-1' });
    const stored = [...store.records.values()][0];
    if (!stored) throw new Error('Registro de teste ausente');
    stored.ciphertext = `${stored.ciphertext.slice(0, -2)}AA`;

    await expect(service.consume(created.handoffToken)).rejects.toMatchObject({
      message: 'Token de handoff inválido ou expirado',
      status: 401,
    });
  });
});
