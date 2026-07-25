-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Make draft_question_library.timer_seconds optional (nullable)
--
-- PURPOSE:
--   Frontend removed timer field from Draft Library UI (library questions only
--   feed into Specials packs which have pack-level time limits, not per-question).
--   Backend now accepts timer_seconds as optional when creating/updating questions.
--   Database column must allow NULL to support this.
--
-- CHANGE:
--   Alter draft_question_library.timer_seconds from NOT NULL DEFAULT 30
--   to NULLABLE (no default).
--
-- BACKWARDS COMPATIBLE:
--   Existing rows with timer_seconds = 30 are unaffected (just hidden from UI).
--   Future rows can be created without timer (will be null).
--   GET responses still return timer (just not displayed by frontend).
--
-- IDEMPOTENT — safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE draft_question_library
ALTER COLUMN timer_seconds DROP NOT NULL,
ALTER COLUMN timer_seconds DROP DEFAULT;
