-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Add deleted_at soft-delete column to pills table
--
-- PURPOSE:
--   Allows admins to remove a question from the bank without destroying
--   historical attempt records. A deleted pill still exists in the DB so
--   completed special_attempts that referenced it remain fully auditable
--   and their scoring is unaffected.
--
-- BEHAVIOUR:
--   - deleted_at IS NULL     → pill is live (normal)
--   - deleted_at IS NOT NULL → pill is soft-deleted; excluded from all
--                              player-facing queries and future attempt draws
--
-- IDEMPOTENT — safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pills
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

-- Partial index: fast "is not deleted" filter used on every bank query
CREATE INDEX IF NOT EXISTS idx_pills_not_deleted
  ON pills (pack_id, status)
  WHERE deleted_at IS NULL;
