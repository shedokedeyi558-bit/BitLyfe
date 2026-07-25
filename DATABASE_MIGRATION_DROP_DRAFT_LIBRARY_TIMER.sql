-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Drop timer_seconds column from draft_question_library
--
-- PURPOSE:
--   Timer per question is not needed. Draft library is just for storing questions.
--   When questions are copied to a Specials pack, the pack-level time limit applies.
--   Removing this column simplifies the schema and eliminates unused data.
--
-- CHANGE:
--   DROP COLUMN draft_question_library.timer_seconds
--
-- BACKWARDS COMPATIBLE:
--   Library questions still work fine without per-question timers.
--   Specials packs continue using pack-level time limits (quiz_expires_at).
--   GET /library responses will not include timer field.
--
-- IDEMPOTENT — safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE draft_question_library
DROP COLUMN IF EXISTS timer_seconds;
