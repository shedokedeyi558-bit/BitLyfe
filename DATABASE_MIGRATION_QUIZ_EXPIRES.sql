-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Add quiz_expires_at to pill_packs
--
-- PURPOSE:
--   Provides a time-bounded expiry for Pills/Specials packs — once
--   quiz_expires_at passes, no new entries or payments are accepted.
--   In-progress attempts that started before expiry are unaffected.
--
-- ISOLATION:
--   This field is COMPLETELY INDEPENDENT of entry_window_end.
--   - entry_window_end  → used by Time Machine / prediction entry cutoffs only
--   - quiz_expires_at   → used by Pills / Specials packs only
--   Neither field is ever read or written by the other feature.
--
-- IDEMPOTENT — safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pill_packs
  ADD COLUMN IF NOT EXISTS quiz_expires_at TIMESTAMP WITH TIME ZONE;

-- Partial index: only rows where quiz_expires_at is set.
-- Makes the "is this pack expired?" check fast.
CREATE INDEX IF NOT EXISTS idx_pill_packs_quiz_expires_at
  ON pill_packs (quiz_expires_at)
  WHERE quiz_expires_at IS NOT NULL;
