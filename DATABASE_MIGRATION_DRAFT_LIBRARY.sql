-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Draft Question Library for Specials pack banks
--
-- PURPOSE:
--   Admin-owned staging area for questions that are NOT yet attached to any
--   pack. Admins write questions here first, then "copy to pack" to push
--   independent copies into a Specials pack bank. Library originals are
--   never modified or consumed — they stay reusable for future packs.
--
-- SCOPE:
--   Specials packs only. Standard Pills packs are unaffected.
--   The existing `pills` table remains the live pack bank.
--
-- IDEMPOTENT — safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS draft_question_library (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id       UUID REFERENCES admins(id) ON DELETE SET NULL,

  -- Question content (mirrors pills table fields used for Specials)
  question       TEXT NOT NULL,
  format         TEXT CHECK (format IN ('multiple_choice', 'type_answer')) NOT NULL,
  options        JSONB,                        -- null for type_answer questions
  correct_answer TEXT NOT NULL,
  case_sensitive BOOLEAN NOT NULL DEFAULT false,
  timer_seconds  INTEGER NOT NULL DEFAULT 30,
  color          VARCHAR(20) DEFAULT '#8B5CF6',

  -- Admin organisation fields
  label          TEXT,                         -- free-text tag/category for filtering
  note           TEXT,                         -- admin-only memo, never exposed to players

  -- Soft-delete
  deleted_at     TIMESTAMP WITH TIME ZONE,

  created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_draft_library_admin_id   ON draft_question_library (admin_id);
CREATE INDEX IF NOT EXISTS idx_draft_library_label      ON draft_question_library (label) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_draft_library_not_deleted ON draft_question_library (created_at DESC) WHERE deleted_at IS NULL;
