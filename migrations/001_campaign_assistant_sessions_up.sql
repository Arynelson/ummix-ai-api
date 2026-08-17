BEGIN;

CREATE SCHEMA IF NOT EXISTS ai_platform;
CREATE SCHEMA IF NOT EXISTS campaign_assistant;
CREATE SCHEMA IF NOT EXISTS campaign_content;

CREATE TABLE IF NOT EXISTS campaign_assistant.sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  user_type VARCHAR(40) NOT NULL,
  client_id UUID NOT NULL,
  client_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting', 'ready', 'finalizing', 'completed', 'expired')),
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  finalized_campaign_id UUID,
  finalized_at TIMESTAMPTZ,
  review_reached_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS idx_campaign_assistant_sessions_user_updated
  ON campaign_assistant.sessions (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_campaign_assistant_sessions_client
  ON campaign_assistant.sessions (client_id);

CREATE INDEX IF NOT EXISTS idx_campaign_assistant_sessions_expiry
  ON campaign_assistant.sessions (expires_at)
  WHERE status IN ('collecting', 'ready', 'finalizing');

CREATE TABLE IF NOT EXISTS campaign_assistant.metrics (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL,
  event_name VARCHAR(40) NOT NULL
    CHECK (event_name IN (
      'session_started',
      'message_sent',
      'proposal_ready',
      'draft_created',
      'review_reached',
      'manual_fallback',
      'error'
    )),
  user_type VARCHAR(40) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_assistant_metrics_session
  ON campaign_assistant.metrics (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_campaign_assistant_metrics_retention
  ON campaign_assistant.metrics (created_at);

CREATE TABLE IF NOT EXISTS ai_platform.schema_migrations (
  filename VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_platform.auth_handoffs (
  token_hash CHAR(64) PRIMARY KEY,
  payload_ciphertext TEXT NOT NULL,
  payload_iv VARCHAR(32) NOT NULL,
  payload_auth_tag VARCHAR(32) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_platform_auth_handoffs_expiry
  ON ai_platform.auth_handoffs (expires_at);

COMMIT;
