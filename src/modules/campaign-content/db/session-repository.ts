import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  CampaignContentCampaignSnapshot,
  CampaignContentMessage,
} from '@ummix/ai-contracts';
import type {
  CampaignContentAnswers,
  CampaignContentMessageRecord,
  CampaignContentSession,
  CampaignContentSessionStatus,
} from '../domain/types.js';

interface SessionRow {
  id: string;
  campaign_id: string;
  user_id: string;
  status: CampaignContentSessionStatus;
  campaign_snapshot: CampaignContentCampaignSnapshot;
  answers: CampaignContentAnswers;
  current_question_key: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  version: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  client_message_id: string | null;
  role: CampaignContentMessage['role'];
  message_type: CampaignContentMessage['type'];
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export interface CampaignContentSessionWithMessages {
  session: CampaignContentSession;
  messages: CampaignContentMessageRecord[];
}

export interface CreateCampaignContentSessionInput {
  campaignId: string;
  userId: string;
  campaignSnapshot: CampaignContentCampaignSnapshot;
  answers: CampaignContentAnswers;
  currentQuestionKey: string | null;
  status: CampaignContentSessionStatus;
  expiresAt: Date;
  initialMessage: {
    text: string;
    type: CampaignContentMessage['type'];
    metadata?: Record<string, unknown>;
  } | null;
}

export interface AppendAnswerInput {
  campaignId: string;
  sessionId: string;
  userId: string;
  clientMessageId: string;
  expectedVersion: number;
  answers: CampaignContentAnswers;
  currentQuestionKey: string | null;
  status: CampaignContentSessionStatus;
  answerText: string;
  assistantMessage: {
    text: string;
    type: CampaignContentMessage['type'];
    metadata?: Record<string, unknown>;
  };
}

export type AppendAnswerResult =
  | { kind: 'saved' | 'duplicate'; value: CampaignContentSessionWithMessages }
  | { kind: 'not_found' | 'conflict'; value: CampaignContentSessionWithMessages | null };

export class CampaignContentSessionRepository {
  constructor(private readonly pool: Pool) {}

  async createOrFindActive(
    input: CreateCampaignContentSessionInput,
  ): Promise<CampaignContentSessionWithMessages> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('campaign-content:' || $1 || ':' || $2))",
        [input.campaignId, input.userId],
      );
      await client.query(
        `UPDATE campaign_content.sessions
         SET status = 'abandoned', updated_at = NOW()
         WHERE campaign_id = $1 AND user_id = $2
           AND status IN ('collecting', 'ready_to_generate', 'generating', 'options_ready')
           AND expires_at <= NOW()`,
        [input.campaignId, input.userId],
      );
      const existing = await this.findActiveWithClient(client, input.campaignId, input.userId);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }

      const sessionId = randomUUID();
      const sessionResult = await client.query<SessionRow>(
        `INSERT INTO campaign_content.sessions (
           id, campaign_id, user_id, status, campaign_snapshot, answers,
           current_question_key, expires_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
         RETURNING id, campaign_id, user_id, status, campaign_snapshot, answers,
                   current_question_key, expires_at, created_at, updated_at, version`,
        [
          sessionId,
          input.campaignId,
          input.userId,
          input.status,
          JSON.stringify(input.campaignSnapshot),
          JSON.stringify(input.answers),
          input.currentQuestionKey,
          input.expiresAt,
        ],
      );
      const row = sessionResult.rows[0];
      if (!row) throw new Error('Falha ao criar sessão de conteúdo.');

      if (input.initialMessage) {
        await this.insertAssistantMessage(client, sessionId, input.initialMessage);
      }
      const value = {
        session: mapSession(row),
        messages: await this.findMessagesWithClient(client, sessionId),
      };
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findOwned(
    campaignId: string,
    sessionId: string,
    userId: string,
  ): Promise<CampaignContentSessionWithMessages | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT id, campaign_id, user_id, status, campaign_snapshot, answers,
              current_question_key, expires_at, created_at, updated_at, version
       FROM campaign_content.sessions
       WHERE id = $1 AND campaign_id = $2 AND user_id = $3`,
      [sessionId, campaignId, userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      session: mapSession(row),
      messages: await this.findMessages(sessionId),
    };
  }

  async findLatestActive(
    campaignId: string,
    userId: string,
  ): Promise<CampaignContentSessionWithMessages | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT id, campaign_id, user_id, status, campaign_snapshot, answers,
              current_question_key, expires_at, created_at, updated_at, version
       FROM campaign_content.sessions
       WHERE campaign_id = $1
         AND user_id = $2
         AND status IN ('collecting', 'ready_to_generate', 'generating', 'options_ready')
         AND expires_at > NOW()
       ORDER BY updated_at DESC
       LIMIT 1`,
      [campaignId, userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      session: mapSession(row),
      messages: await this.findMessages(row.id),
    };
  }

  async appendAnswer(input: AppendAnswerInput): Promise<AppendAnswerResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<SessionRow>(
        `SELECT id, campaign_id, user_id, status, campaign_snapshot, answers,
                current_question_key, expires_at, created_at, updated_at, version
         FROM campaign_content.sessions
         WHERE id = $1 AND campaign_id = $2 AND user_id = $3
         FOR UPDATE`,
        [input.sessionId, input.campaignId, input.userId],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { kind: 'not_found', value: null };
      }

      const duplicate = await client.query<{ id: string }>(
        `SELECT id FROM campaign_content.messages
         WHERE session_id = $1 AND client_message_id = $2`,
        [input.sessionId, input.clientMessageId],
      );
      const current = {
        session: mapSession(row),
        messages: await this.findMessagesWithClient(client, input.sessionId),
      };
      if ((duplicate.rowCount ?? 0) > 0) {
        await client.query('COMMIT');
        return { kind: 'duplicate', value: current };
      }
      if (row.version !== input.expectedVersion) {
        await client.query('COMMIT');
        return { kind: 'conflict', value: current };
      }
      if (!['collecting', 'ready_to_generate'].includes(row.status)) {
        await client.query('COMMIT');
        return { kind: 'conflict', value: current };
      }
      if (row.expires_at <= new Date()) {
        await client.query('COMMIT');
        return { kind: 'conflict', value: current };
      }

      await client.query(
        `INSERT INTO campaign_content.messages
          (id, session_id, client_message_id, role, message_type, content, metadata)
         VALUES ($1, $2, $3, 'user', 'answer', $4, NULL)`,
        [randomUUID(), input.sessionId, input.clientMessageId, input.answerText],
      );
      await this.insertAssistantMessage(client, input.sessionId, input.assistantMessage);

      const updated = await client.query<SessionRow>(
        `UPDATE campaign_content.sessions
         SET answers = $4::jsonb,
             current_question_key = $5,
             status = $6,
             updated_at = NOW(),
             version = version + 1
         WHERE id = $1 AND campaign_id = $2 AND user_id = $3
         RETURNING id, campaign_id, user_id, status, campaign_snapshot, answers,
                   current_question_key, expires_at, created_at, updated_at, version`,
        [
          input.sessionId,
          input.campaignId,
          input.userId,
          JSON.stringify(input.answers),
          input.currentQuestionKey,
          input.status,
        ],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new Error('Falha ao atualizar sessão de conteúdo.');
      const value = {
        session: mapSession(updatedRow),
        messages: await this.findMessagesWithClient(client, input.sessionId),
      };
      await client.query('COMMIT');
      return { kind: 'saved', value };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async findActiveWithClient(
    client: PoolClient,
    campaignId: string,
    userId: string,
  ): Promise<CampaignContentSessionWithMessages | null> {
    const result = await client.query<SessionRow>(
      `SELECT id, campaign_id, user_id, status, campaign_snapshot, answers,
              current_question_key, expires_at, created_at, updated_at, version
       FROM campaign_content.sessions
       WHERE campaign_id = $1
         AND user_id = $2
         AND status IN ('collecting', 'ready_to_generate', 'generating', 'options_ready')
         AND expires_at > NOW()
       ORDER BY updated_at DESC
       LIMIT 1`,
      [campaignId, userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      session: mapSession(row),
      messages: await this.findMessagesWithClient(client, row.id),
    };
  }

  private async findMessages(sessionId: string): Promise<CampaignContentMessageRecord[]> {
    const client = await this.pool.connect();
    try {
      return await this.findMessagesWithClient(client, sessionId);
    } finally {
      client.release();
    }
  }

  private async findMessagesWithClient(
    client: PoolClient,
    sessionId: string,
  ): Promise<CampaignContentMessageRecord[]> {
    const result = await client.query<MessageRow>(
      `SELECT id, session_id, client_message_id, role, message_type, content, metadata, created_at
       FROM campaign_content.messages
       WHERE session_id = $1
       ORDER BY created_at ASC, id ASC`,
      [sessionId],
    );
    return result.rows.map(mapMessage);
  }

  private async insertAssistantMessage(
    client: PoolClient,
    sessionId: string,
    message: CreateCampaignContentSessionInput['initialMessage'] | AppendAnswerInput['assistantMessage'],
  ): Promise<void> {
    if (!message) return;
    await client.query(
      `INSERT INTO campaign_content.messages
        (id, session_id, client_message_id, role, message_type, content, metadata)
       VALUES ($1, $2, NULL, 'assistant', $3, $4, $5::jsonb)`,
      [randomUUID(), sessionId, message.type, message.text, JSON.stringify(message.metadata ?? null)],
    );
  }
}

function mapSession(row: SessionRow): CampaignContentSession {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    userId: row.user_id,
    status: row.status,
    campaignSnapshot: row.campaign_snapshot,
    answers: row.answers,
    currentQuestionKey: row.current_question_key,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}

function mapMessage(row: MessageRow): CampaignContentMessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    clientMessageId: row.client_message_id,
    role: row.role,
    type: row.message_type,
    text: row.content,
    createdAt: row.created_at.toISOString(),
    metadata: row.metadata,
  };
}
