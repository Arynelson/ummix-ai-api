import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { AuthHandoffExchangeResponse } from '@ummix/ai-contracts';

export interface EncryptedHandoffPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export class HandoffCipher {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) {
      throw new Error('AI_HANDOFF_ENCRYPTION_KEY deve conter 32 bytes');
    }
  }

  encrypt(payload: AuthHandoffExchangeResponse, associatedTokenHash: string): EncryptedHandoffPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(associatedTokenHash, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);

    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
  }

  decrypt(payload: EncryptedHandoffPayload, associatedTokenHash: string): AuthHandoffExchangeResponse {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(payload.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from(associatedTokenHash, 'utf8'));
    decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(plaintext) as Partial<AuthHandoffExchangeResponse>;

    if (typeof parsed.access_token !== 'string' || !parsed.user || typeof parsed.user !== 'object') {
      throw new Error('Payload de handoff inválido');
    }
    return {
      access_token: parsed.access_token,
      user: parsed.user as Record<string, unknown>,
    };
  }
}
