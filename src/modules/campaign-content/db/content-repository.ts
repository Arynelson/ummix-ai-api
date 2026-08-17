import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  CampaignContentCampaignSnapshot,
  CampaignContentLengthPolicy,
  CampaignContentOption,
} from '@ummix/ai-contracts';
import type {
  CampaignContentEmailStatus,
  CampaignContentStatus,
} from '../domain/types.js';

interface ContentRow {
  id: string;
  campaign_id: string;
  session_id: string;
  generation_key: string;
  status: CampaignContentStatus;
  options: CampaignContentOption[];
  selected_option_id: string | null;
  selected_text_original: string | null;
  final_text: string | null;
  is_edited: boolean;
  media_channel: string;
  content_format: string | null;
  duration_seconds: number;
  min_words: number;
  max_words: number;
  word_count: number | null;
  length_policy_version: string;
  model_name: string | null;
  prompt_version: string | null;
  email_status: CampaignContentEmailStatus;
  email_sent_at: Date | null;
  email_last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface EmailDeliveryRow extends ContentRow {
  campaign_snapshot: CampaignContentCampaignSnapshot;
}

export interface CampaignContentRecord {
  id: string;
  campaignId: string;
  sessionId: string;
  generationKey: string;
  status: CampaignContentStatus;
  options: CampaignContentOption[];
  selectedOptionId: string | null;
  selectedTextOriginal: string | null;
  finalText: string | null;
  isEdited: boolean;
  mediaChannel: string;
  contentFormat: string | null;
  lengthPolicy: CampaignContentLengthPolicy;
  wordCount: number | null;
  modelName: string | null;
  promptVersion: string | null;
  emailStatus: CampaignContentEmailStatus;
  emailSentAt: string | null;
  emailLastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentWithSessionVersion {
  content: CampaignContentRecord;
  sessionVersion: number;
}

export interface CampaignContentEmailDelivery {
  content: CampaignContentRecord;
  campaignSnapshot: CampaignContentCampaignSnapshot;
}

export type ReserveGenerationResult =
  | { kind: 'reserved'; value: ContentWithSessionVersion }
  | { kind: 'existing'; value: ContentWithSessionVersion }
  | { kind: 'not_found'; value: null }
  | { kind: 'conflict'; value: ContentWithSessionVersion | null }
  | { kind: 'limit'; value: ContentWithSessionVersion | null };

export type SaveSelectionResult =
  | { kind: 'saved' | 'duplicate'; value: ContentWithSessionVersion }
  | { kind: 'not_found'; value: null }
  | { kind: 'conflict'; value: ContentWithSessionVersion | null }
  | { kind: 'invalid_option'; value: ContentWithSessionVersion };

export type ClaimEmailDeliveryResult =
  | { kind: 'claimed'; value: CampaignContentEmailDelivery }
  | { kind: 'sent'; value: CampaignContentEmailDelivery }
  | { kind: 'sending'; value: CampaignContentEmailDelivery }
  | { kind: 'unavailable'; value: CampaignContentEmailDelivery }
  | { kind: 'not_found'; value: null };

export class CampaignContentRepository {
  constructor(private readonly pool: Pool) {}

  async recoverStaleOperations(staleMinutes = 15): Promise<{
    generations: number;
    emails: number;
  }> {
    const generationResult = await this.pool.query(
      `WITH stale_generations AS (
         UPDATE campaign_content.contents
         SET status = 'failed', updated_at = NOW()
         WHERE status = 'generating'
           AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')
         RETURNING session_id
       ), affected_sessions AS (
         SELECT DISTINCT session_id FROM stale_generations
       )
       UPDATE campaign_content.sessions AS s
       SET status = CASE
           WHEN EXISTS (
             SELECT 1
             FROM campaign_content.contents AS c
             WHERE c.session_id = s.id
               AND c.status IN ('options_ready', 'saved')
           ) THEN 'options_ready'
           ELSE 'ready_to_generate'
         END,
         version = s.version + 1,
         updated_at = NOW()
       FROM affected_sessions AS a
       WHERE s.id = a.session_id
       RETURNING s.id`,
      [staleMinutes],
    );
    const emailResult = await this.pool.query(
      `UPDATE campaign_content.contents
       SET email_status = 'failed',
           email_last_error = 'Envio interrompido por reinicio do servico; tente novamente.',
           updated_at = NOW()
       WHERE email_status = 'sending'
         AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')
       RETURNING id`,
      [staleMinutes],
    );
    return {
      generations: generationResult.rowCount ?? 0,
      emails: emailResult.rowCount ?? 0,
    };
  }

  async reserveGeneration(input: {
    campaignId: string;
    sessionId: string;
    userId: string;
    generationKey: string;
    lengthPolicy: CampaignContentLengthPolicy;
    mediaChannel: string;
    contentFormat: string | null;
    modelName: string;
    promptVersion: string;
  }): Promise<ReserveGenerationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session = await this.lockSession(client, input.campaignId, input.sessionId, input.userId);
      if (!session) {
        await client.query('ROLLBACK');
        return { kind: 'not_found', value: null };
      }

      const existing = await this.findContentWithClient(client, input.sessionId, input.generationKey);
      if (existing) {
        await client.query('COMMIT');
        return { kind: 'existing', value: { content: existing, sessionVersion: session.version } };
      }
      if (session.expiresAt <= new Date() || !['ready_to_generate', 'generating', 'options_ready'].includes(session.status)) {
        const current = await this.findLatestForSessionWithClient(client, input.sessionId, session.version);
        await client.query('COMMIT');
        return { kind: 'conflict', value: current };
      }

      const count = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM campaign_content.contents
         WHERE session_id = $1`,
        [input.sessionId],
      );
      if (Number(count.rows[0]?.count ?? 0) >= 3) {
        const current = await this.findLatestForSessionWithClient(client, input.sessionId, session.version);
        await client.query('COMMIT');
        return { kind: 'limit', value: current };
      }

      const contentId = randomUUID();
      const inserted = await client.query<ContentRow>(
        `INSERT INTO campaign_content.contents (
           id, campaign_id, session_id, generation_key, status, options,
           media_channel, content_format, duration_seconds, min_words, max_words,
           length_policy_version, model_name, prompt_version
         ) VALUES ($1, $2, $3, $4, 'generating', '[]'::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${CONTENT_COLUMNS}`,
        [
          contentId,
          input.campaignId,
          input.sessionId,
          input.generationKey,
          input.mediaChannel,
          input.contentFormat,
          input.lengthPolicy.durationSeconds,
          input.lengthPolicy.minWords,
          input.lengthPolicy.maxWords,
          input.lengthPolicy.version,
          input.modelName,
          input.promptVersion,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('Falha ao reservar geracao de conteudo.');

      const updatedSession = await this.updateSessionStatus(client, input.sessionId, 'generating');
      const value = {
        content: mapContent(row),
        sessionVersion: updatedSession.version,
      };
      await client.query('COMMIT');
      return { kind: 'reserved', value };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeGeneration(input: {
    campaignId: string;
    sessionId: string;
    userId: string;
    generationId: string;
    options: CampaignContentOption[];
  }): Promise<ContentWithSessionVersion | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session = await this.lockSession(client, input.campaignId, input.sessionId, input.userId);
      if (!session) {
        await client.query('ROLLBACK');
        return null;
      }
      const current = await this.findContentByIdWithClient(client, input.sessionId, input.generationId);
      if (!current) {
        await client.query('ROLLBACK');
        return null;
      }
      if (current.status !== 'generating') {
        await client.query('COMMIT');
        return { content: current, sessionVersion: session.version };
      }

      const updated = await client.query<ContentRow>(
        `UPDATE campaign_content.contents
         SET status = 'options_ready', options = $2::jsonb, updated_at = NOW()
         WHERE id = $1 AND session_id = $3
         RETURNING ${CONTENT_COLUMNS}`,
        [input.generationId, JSON.stringify(input.options), input.sessionId],
      );
      const row = updated.rows[0];
      if (!row) throw new Error('Falha ao concluir geracao de conteudo.');
      const updatedSession = await this.updateSessionStatus(client, input.sessionId, 'options_ready');
      const value = { content: mapContent(row), sessionVersion: updatedSession.version };
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async failGeneration(input: {
    campaignId: string;
    sessionId: string;
    userId: string;
    generationId: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session = await this.lockSession(client, input.campaignId, input.sessionId, input.userId);
      if (!session) {
        await client.query('ROLLBACK');
        return;
      }
      const current = await this.findContentByIdWithClient(client, input.sessionId, input.generationId);
      if (!current || current.status !== 'generating') {
        await client.query('COMMIT');
        return;
      }
      await client.query(
        `UPDATE campaign_content.contents
         SET status = 'failed', updated_at = NOW()
         WHERE id = $1 AND session_id = $2`,
        [input.generationId, input.sessionId],
      );
      const existing = await client.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM campaign_content.contents
           WHERE session_id = $1 AND status IN ('options_ready', 'saved')
         ) AS exists`,
        [input.sessionId],
      );
      await this.updateSessionStatus(
        client,
        input.sessionId,
        existing.rows[0]?.exists ? 'options_ready' : 'ready_to_generate',
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async saveSelection(input: {
    campaignId: string;
    sessionId: string;
    userId: string;
    generationId: string;
    optionId: string;
    finalText: string;
    expectedSessionVersion: number;
    wordCount: number;
  }): Promise<SaveSelectionResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('campaign-content-save:' || $1))",
        [input.campaignId],
      );
      const session = await this.lockSession(client, input.campaignId, input.sessionId, input.userId);
      if (!session) {
        await client.query('ROLLBACK');
        return { kind: 'not_found', value: null };
      }
      const current = await this.findContentByIdWithClient(client, input.sessionId, input.generationId);
      if (!current) {
        await client.query('ROLLBACK');
        return { kind: 'not_found', value: null };
      }

      const selected = current.options.find((option) => option.id === input.optionId);
      if (!selected) {
        await client.query('COMMIT');
        return { kind: 'invalid_option', value: { content: current, sessionVersion: session.version } };
      }
      const alreadySaved = current.status === 'saved'
        && current.selectedOptionId === input.optionId
        && current.finalText === input.finalText;
      if (alreadySaved) {
        await client.query('COMMIT');
        return { kind: 'duplicate', value: { content: current, sessionVersion: session.version } };
      }
      if (current.status !== 'options_ready' || session.version !== input.expectedSessionVersion) {
        await client.query('COMMIT');
        return { kind: 'conflict', value: { content: current, sessionVersion: session.version } };
      }

      await client.query(
        `UPDATE campaign_content.contents
         SET status = 'archived', updated_at = NOW()
         WHERE campaign_id = $1 AND status = 'saved' AND id <> $2`,
        [input.campaignId, input.generationId],
      );
      const updated = await client.query<ContentRow>(
        `UPDATE campaign_content.contents
         SET status = 'saved', selected_option_id = $2,
             selected_text_original = $3, final_text = $4,
             is_edited = $5, word_count = $6,
             email_status = CASE WHEN email_status = 'sent' THEN 'sent' ELSE 'pending' END,
             email_sent_at = CASE WHEN email_status = 'sent' THEN email_sent_at ELSE NULL END,
             email_last_error = NULL,
             updated_at = NOW()
         WHERE id = $1 AND campaign_id = $7 AND session_id = $8
         RETURNING ${CONTENT_COLUMNS}`,
        [
          input.generationId,
          input.optionId,
          selected.text,
          input.finalText,
          selected.text !== input.finalText,
          input.wordCount,
          input.campaignId,
          input.sessionId,
        ],
      );
      const row = updated.rows[0];
      if (!row) throw new Error('Falha ao salvar conteudo de campanha.');
      const updatedSession = await this.updateSessionStatus(client, input.sessionId, 'saved');
      const value = { content: mapContent(row), sessionVersion: updatedSession.version };
      await client.query('COMMIT');
      return { kind: 'saved', value };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findLatestSaved(campaignId: string, userId: string): Promise<ContentWithSessionVersion | null> {
    const result = await this.pool.query<ContentRow & { session_version: number }>(
      `SELECT ${CONTENT_COLUMNS_WITH_SESSION_VERSION}
       FROM campaign_content.contents c
       JOIN campaign_content.sessions s ON s.id = c.session_id
       WHERE c.campaign_id = $1 AND s.user_id = $2 AND c.status = 'saved'
       ORDER BY c.updated_at DESC
       LIMIT 1`,
      [campaignId, userId],
    );
    const row = result.rows[0];
    return row ? { content: mapContent(row), sessionVersion: row.session_version } : null;
  }

  async findLatestSavedForCampaign(campaignId: string): Promise<ContentWithSessionVersion | null> {
    const result = await this.pool.query<ContentRow & { session_version: number }>(
      `SELECT ${CONTENT_COLUMNS_WITH_SESSION_VERSION}
       FROM campaign_content.contents c
       JOIN campaign_content.sessions s ON s.id = c.session_id
       WHERE c.campaign_id = $1 AND c.status = 'saved'
       ORDER BY c.updated_at DESC
       LIMIT 1`,
      [campaignId],
    );
    const row = result.rows[0];
    return row ? { content: mapContent(row), sessionVersion: row.session_version } : null;
  }

  async findLatestDraft(sessionId: string, userId: string): Promise<ContentWithSessionVersion | null> {
    const result = await this.pool.query<ContentRow & { session_version: number }>(
      `SELECT ${CONTENT_COLUMNS_WITH_SESSION_VERSION}
       FROM campaign_content.contents c
       JOIN campaign_content.sessions s ON s.id = c.session_id
       WHERE c.session_id = $1 AND s.user_id = $2 AND c.status IN ('generating', 'options_ready')
       ORDER BY c.created_at DESC
       LIMIT 1`,
      [sessionId, userId],
    );
    const row = result.rows[0];
    return row ? { content: mapContent(row), sessionVersion: row.session_version } : null;
  }

  async claimEmailDelivery(
    campaignId: string,
    contentId: string,
  ): Promise<ClaimEmailDeliveryResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<EmailDeliveryRow>(
        `SELECT ${CONTENT_COLUMNS_WITH_CONTENT_ALIAS}, s.campaign_snapshot
         FROM campaign_content.contents c
         JOIN campaign_content.sessions s ON s.id = c.session_id
         WHERE c.id = $1 AND c.campaign_id = $2
         FOR UPDATE OF c, s`,
        [contentId, campaignId],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return { kind: 'not_found', value: null };
      }

      const value = toEmailDelivery(row);
      if (row.email_status === 'sent') {
        await client.query('COMMIT');
        return { kind: 'sent', value };
      }
      if (row.email_status === 'sending') {
        await client.query('COMMIT');
        return { kind: 'sending', value };
      }
      if (row.status !== 'saved' || !['not_sent', 'pending', 'failed'].includes(row.email_status)) {
        await client.query('COMMIT');
        return { kind: 'unavailable', value };
      }

      const updated = await client.query<ContentRow>(
        `UPDATE campaign_content.contents
         SET email_status = 'sending', email_last_error = NULL, updated_at = NOW()
         WHERE id = $1
         RETURNING ${CONTENT_COLUMNS}`,
        [contentId],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new Error('Falha ao reservar envio administrativo.');

      await client.query('COMMIT');
      return {
        kind: 'claimed',
        value: {
          content: mapContent(updatedRow),
          campaignSnapshot: row.campaign_snapshot,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markEmailSent(contentId: string): Promise<void> {
    await this.pool.query(
      `UPDATE campaign_content.contents
       SET email_status = 'sent', email_sent_at = NOW(), email_last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND email_status = 'sending'`,
      [contentId],
    );
  }

  async markEmailFailed(contentId: string, errorMessage: string): Promise<void> {
    await this.pool.query(
      `UPDATE campaign_content.contents
       SET email_status = 'failed', email_last_error = LEFT($2, 500), updated_at = NOW()
       WHERE id = $1 AND email_status = 'sending'`,
      [contentId, errorMessage],
    );
  }

  private async lockSession(
    client: PoolClient,
    campaignId: string,
    sessionId: string,
    userId: string,
  ): Promise<{ version: number; status: string; expiresAt: Date } | null> {
    const result = await client.query<{ version: number; status: string; expires_at: Date }>(
      `SELECT version, status, expires_at
       FROM campaign_content.sessions
       WHERE id = $1 AND campaign_id = $2 AND user_id = $3
       FOR UPDATE`,
      [sessionId, campaignId, userId],
    );
    const row = result.rows[0];
    return row
      ? { version: row.version, status: row.status, expiresAt: row.expires_at }
      : null;
  }

  private async findContentByIdWithClient(
    client: PoolClient,
    sessionId: string,
    contentId: string,
  ): Promise<CampaignContentRecord | null> {
    const result = await client.query<ContentRow>(
      `SELECT ${CONTENT_COLUMNS}
       FROM campaign_content.contents
       WHERE id = $1 AND session_id = $2
       FOR UPDATE`,
      [contentId, sessionId],
    );
    const row = result.rows[0];
    return row ? mapContent(row) : null;
  }

  private async findContentWithClient(
    client: PoolClient,
    sessionId: string,
    generationKey: string,
  ): Promise<CampaignContentRecord | null> {
    const result = await client.query<ContentRow>(
      `SELECT ${CONTENT_COLUMNS}
       FROM campaign_content.contents
       WHERE session_id = $1 AND generation_key = $2
       FOR UPDATE`,
      [sessionId, generationKey],
    );
    const row = result.rows[0];
    return row ? mapContent(row) : null;
  }

  private async findLatestForSessionWithClient(
    client: PoolClient,
    sessionId: string,
    sessionVersion: number,
  ): Promise<ContentWithSessionVersion | null> {
    const result = await client.query<ContentRow>(
      `SELECT ${CONTENT_COLUMNS}
       FROM campaign_content.contents
       WHERE session_id = $1 AND status IN ('generating', 'options_ready', 'saved')
       ORDER BY created_at DESC
       LIMIT 1`,
      [sessionId],
    );
    const row = result.rows[0];
    return row ? { content: mapContent(row), sessionVersion } : null;
  }

  private async updateSessionStatus(
    client: PoolClient,
    sessionId: string,
    status: string,
  ): Promise<{ version: number }> {
    const result = await client.query<{ version: number }>(
      `UPDATE campaign_content.sessions
       SET status = $2, version = version + 1, updated_at = NOW()
       WHERE id = $1
       RETURNING version`,
      [sessionId, status],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Falha ao atualizar estado da sessao.');
    return row;
  }
}

const CONTENT_COLUMNS = `
  id, campaign_id, session_id, generation_key, status, options,
  selected_option_id, selected_text_original, final_text, is_edited,
  media_channel, content_format, duration_seconds, min_words, max_words,
  word_count, length_policy_version, model_name, prompt_version,
  email_status, email_sent_at, email_last_error, created_at, updated_at`;

const CONTENT_COLUMNS_WITH_CONTENT_ALIAS = `
  c.id, c.campaign_id, c.session_id, c.generation_key, c.status, c.options,
  c.selected_option_id, c.selected_text_original, c.final_text, c.is_edited,
  c.media_channel, c.content_format, c.duration_seconds, c.min_words, c.max_words,
  c.word_count, c.length_policy_version, c.model_name, c.prompt_version,
  c.email_status, c.email_sent_at, c.email_last_error, c.created_at, c.updated_at`;

const CONTENT_COLUMNS_WITH_SESSION_VERSION = `
  c.id, c.campaign_id, c.session_id, c.generation_key, c.status, c.options,
  c.selected_option_id, c.selected_text_original, c.final_text, c.is_edited,
  c.media_channel, c.content_format, c.duration_seconds, c.min_words, c.max_words,
  c.word_count, c.length_policy_version, c.model_name, c.prompt_version,
  c.email_status, c.email_sent_at, c.email_last_error, c.created_at, c.updated_at,
  s.version AS session_version`;

function mapContent(row: ContentRow): CampaignContentRecord {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    sessionId: row.session_id,
    generationKey: row.generation_key,
    status: row.status,
    options: row.options,
    selectedOptionId: row.selected_option_id,
    selectedTextOriginal: row.selected_text_original,
    finalText: row.final_text,
    isEdited: row.is_edited,
    mediaChannel: row.media_channel,
    contentFormat: row.content_format,
    lengthPolicy: {
      version: row.length_policy_version,
      durationSeconds: row.duration_seconds,
      minWords: row.min_words,
      maxWords: row.max_words,
    },
    wordCount: row.word_count,
    modelName: row.model_name,
    promptVersion: row.prompt_version,
    emailStatus: row.email_status,
    emailSentAt: row.email_sent_at?.toISOString() ?? null,
    emailLastError: row.email_last_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toEmailDelivery(row: EmailDeliveryRow): CampaignContentEmailDelivery {
  return {
    content: mapContent(row),
    campaignSnapshot: row.campaign_snapshot,
  };
}
