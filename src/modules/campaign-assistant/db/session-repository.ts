import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  AssistantSession,
  CampaignState,
  ChatMessage,
  ClientSnapshot,
  SessionStatus,
} from '../domain/types.js';

interface SessionRow {
  id: string;
  user_id: string;
  user_type: string;
  client_id: string;
  client_snapshot: ClientSnapshot;
  status: SessionStatus;
  state: CampaignState;
  messages: ChatMessage[];
  finalized_campaign_id: string | null;
  finalized_at: Date | null;
  review_reached_at: Date | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  version: number;
}

export class SessionRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    userId: string;
    userType: string;
    client: ClientSnapshot;
    state: CampaignState;
    initialMessage: ChatMessage;
    ttlMinutes: number;
  }): Promise<AssistantSession> {
    const id = randomUUID();
    const result = await this.pool.query<SessionRow>(
      `INSERT INTO campaign_assistant.sessions (
        id, user_id, user_type, client_id, client_snapshot, state, messages, expires_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, NOW() + ($8 * INTERVAL '1 minute'))
      RETURNING *`,
      [
        id,
        input.userId,
        input.userType,
        input.client.id,
        JSON.stringify(input.client),
        JSON.stringify(input.state),
        JSON.stringify([input.initialMessage]),
        input.ttlMinutes,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Falha ao criar sessão');
    return mapRow(row);
  }

  async findOwned(id: string, userId: string): Promise<AssistantSession | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT * FROM campaign_assistant.sessions WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async saveTurn(input: {
    id: string;
    userId: string;
    expectedVersion: number;
    state: CampaignState;
    messages: ChatMessage[];
    status: 'collecting' | 'ready';
    ttlMinutes: number;
  }): Promise<AssistantSession | null> {
    const result = await this.pool.query<SessionRow>(
      `UPDATE campaign_assistant.sessions
       SET state = $4::jsonb,
           messages = $5::jsonb,
           status = $6,
           expires_at = NOW() + ($7 * INTERVAL '1 minute'),
           updated_at = NOW(),
           version = version + 1
       WHERE id = $1
         AND user_id = $2
         AND version = $3
         AND status IN ('collecting', 'ready')
       RETURNING *`,
      [
        input.id,
        input.userId,
        input.expectedVersion,
        JSON.stringify(input.state),
        JSON.stringify(input.messages),
        input.status,
        input.ttlMinutes,
      ],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async claimFinalization(
    id: string,
    userId: string,
  ): Promise<{ session: AssistantSession | null; claimed: boolean }> {
    const result = await this.pool.query<SessionRow>(
      `UPDATE campaign_assistant.sessions
       SET status = 'finalizing', updated_at = NOW(), version = version + 1
       WHERE id = $1 AND user_id = $2 AND status IN ('collecting', 'ready')
       RETURNING *`,
      [id, userId],
    );
    if (result.rows[0]) return { session: mapRow(result.rows[0]), claimed: true };
    return { session: await this.findOwned(id, userId), claimed: false };
  }

  async releaseFinalization(id: string, userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE campaign_assistant.sessions
       SET status = 'ready', updated_at = NOW(), version = version + 1
       WHERE id = $1
         AND user_id = $2
         AND status = 'finalizing'
         AND finalized_campaign_id IS NULL`,
      [id, userId],
    );
  }

  async rememberDraft(id: string, userId: string, campaignId: string): Promise<void> {
    await this.pool.query(
      `UPDATE campaign_assistant.sessions
       SET finalized_campaign_id = COALESCE(finalized_campaign_id, $3),
           updated_at = NOW(),
           version = version + 1
       WHERE id = $1 AND user_id = $2`,
      [id, userId, campaignId],
    );
  }

  async complete(id: string, userId: string, campaignId: string): Promise<AssistantSession> {
    const result = await this.pool.query<SessionRow>(
      `UPDATE campaign_assistant.sessions
       SET status = 'completed',
           finalized_campaign_id = $3,
           finalized_at = NOW(),
           state = '{}'::jsonb,
           messages = '[]'::jsonb,
           updated_at = NOW(),
           version = version + 1
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId, campaignId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Sessão não encontrada ao concluir');
    return mapRow(row);
  }

  async markReviewReached(id: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE campaign_assistant.sessions
       SET review_reached_at = COALESCE(review_reached_at, NOW()), updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'completed'`,
      [id, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteOwned(id: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM campaign_assistant.sessions WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async trackMetric(input: {
    sessionId: string;
    userType: string;
    eventName:
      | 'session_started'
      | 'message_sent'
      | 'proposal_ready'
      | 'draft_created'
      | 'review_reached'
      | 'manual_fallback'
      | 'error';
    metadata?: Record<string, string | number | boolean | null>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO campaign_assistant.metrics (session_id, event_name, user_type, metadata)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        input.sessionId,
        input.eventName,
        input.userType,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  async countRecentMessages(sessionId: string, windowMinutes: number): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM campaign_assistant.metrics
       WHERE session_id = $1
         AND event_name = 'message_sent'
         AND created_at >= NOW() - ($2 * INTERVAL '1 minute')`,
      [sessionId, windowMinutes],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async expireAndPurge(): Promise<{ expiredSessions: number; purgedMetrics: number }> {
    const expired = await this.pool.query(
      `UPDATE campaign_assistant.sessions
       SET status = 'expired',
           state = '{}'::jsonb,
           messages = '[]'::jsonb,
           client_snapshot = '{}'::jsonb,
           updated_at = NOW()
       WHERE expires_at <= NOW()
         AND status IN ('collecting', 'ready', 'finalizing')`,
    );
    const purged = await this.pool.query(
      `DELETE FROM campaign_assistant.metrics WHERE created_at < NOW() - INTERVAL '30 days'`,
    );
    return {
      expiredSessions: expired.rowCount ?? 0,
      purgedMetrics: purged.rowCount ?? 0,
    };
  }
}

function mapRow(row: SessionRow): AssistantSession {
  return {
    id: row.id,
    userId: row.user_id,
    userType: row.user_type,
    clientId: row.client_id,
    clientSnapshot: row.client_snapshot,
    status: row.status,
    state: row.state,
    messages: row.messages,
    finalizedCampaignId: row.finalized_campaign_id,
    finalizedAt: row.finalized_at?.toISOString() ?? null,
    reviewReachedAt: row.review_reached_at?.toISOString() ?? null,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}
