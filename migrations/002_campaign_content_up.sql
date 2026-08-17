BEGIN;

CREATE TABLE IF NOT EXISTS campaign_content.sessions (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL,
  user_id UUID NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting', 'ready_to_generate', 'generating', 'options_ready', 'saved', 'failed', 'abandoned')),
  campaign_snapshot JSONB NOT NULL,
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_question_key VARCHAR(80),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
);

CREATE INDEX IF NOT EXISTS idx_campaign_content_sessions_campaign_created
  ON campaign_content.sessions (campaign_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_campaign_content_sessions_user_updated
  ON campaign_content.sessions (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_campaign_content_sessions_active
  ON campaign_content.sessions (campaign_id, user_id, updated_at DESC)
  WHERE status IN ('collecting', 'ready_to_generate', 'generating', 'options_ready');

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_content_sessions_active
  ON campaign_content.sessions (campaign_id, user_id)
  WHERE status IN ('collecting', 'ready_to_generate', 'generating', 'options_ready');

CREATE TABLE IF NOT EXISTS campaign_content.messages (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES campaign_content.sessions(id) ON DELETE CASCADE,
  client_message_id UUID,
  role VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant')),
  message_type VARCHAR(16) NOT NULL CHECK (message_type IN ('question', 'answer', 'status', 'error')),
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_content_messages_session_created
  ON campaign_content.messages (session_id, created_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_content_messages_session_client_id
  ON campaign_content.messages (session_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS campaign_content.contents (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL,
  session_id UUID NOT NULL REFERENCES campaign_content.sessions(id) ON DELETE CASCADE,
  generation_key UUID NOT NULL,
  status VARCHAR(32) NOT NULL
    CHECK (status IN ('generating', 'options_ready', 'saved', 'archived', 'failed')),
  options JSONB NOT NULL,
  selected_option_id VARCHAR(32),
  selected_text_original TEXT,
  final_text TEXT,
  is_edited BOOLEAN NOT NULL DEFAULT FALSE,
  media_channel VARCHAR(32) NOT NULL,
  content_format VARCHAR(32),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
  min_words INTEGER NOT NULL CHECK (min_words >= 0),
  max_words INTEGER NOT NULL CHECK (max_words >= min_words),
  word_count INTEGER CHECK (word_count IS NULL OR word_count >= 0),
  length_policy_version VARCHAR(32) NOT NULL,
  model_name VARCHAR(128),
  prompt_version VARCHAR(64),
  email_status VARCHAR(16) NOT NULL DEFAULT 'not_sent'
    CHECK (email_status IN ('not_sent', 'pending', 'sending', 'sent', 'failed')),
  email_sent_at TIMESTAMPTZ,
  email_last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, generation_key)
);

CREATE INDEX IF NOT EXISTS idx_campaign_content_contents_campaign_created
  ON campaign_content.contents (campaign_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_campaign_content_contents_session
  ON campaign_content.contents (session_id);

CREATE INDEX IF NOT EXISTS idx_campaign_content_contents_email_status
  ON campaign_content.contents (email_status);

COMMIT;
