import type { Pool } from 'pg';
import type { EncryptedHandoffPayload } from './handoff-crypto.js';

export interface StoredHandoff extends EncryptedHandoffPayload {
  tokenHash: string;
  expiresAt: Date;
}

export interface HandoffStore {
  save(handoff: StoredHandoff): Promise<void>;
  consume(tokenHash: string): Promise<EncryptedHandoffPayload | null>;
  purgeExpired(): Promise<number>;
}

interface HandoffRow {
  payload_ciphertext: string;
  payload_iv: string;
  payload_auth_tag: string;
}

export class PostgresHandoffRepository implements HandoffStore {
  constructor(private readonly pool: Pool) {}

  async save(handoff: StoredHandoff): Promise<void> {
    await this.pool.query(
      `INSERT INTO ai_platform.auth_handoffs (
        token_hash, payload_ciphertext, payload_iv, payload_auth_tag, expires_at
      ) VALUES ($1, $2, $3, $4, $5)`,
      [
        handoff.tokenHash,
        handoff.ciphertext,
        handoff.iv,
        handoff.authTag,
        handoff.expiresAt,
      ],
    );
  }

  async consume(tokenHash: string): Promise<EncryptedHandoffPayload | null> {
    const result = await this.pool.query<HandoffRow>(
      `DELETE FROM ai_platform.auth_handoffs
       WHERE token_hash = $1 AND expires_at > NOW()
       RETURNING payload_ciphertext, payload_iv, payload_auth_tag`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row
      ? {
          ciphertext: row.payload_ciphertext,
          iv: row.payload_iv,
          authTag: row.payload_auth_tag,
        }
      : null;
  }

  async purgeExpired(): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM ai_platform.auth_handoffs WHERE expires_at <= NOW()',
    );
    return result.rowCount ?? 0;
  }
}
