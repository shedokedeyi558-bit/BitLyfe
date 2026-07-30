-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Blitz gameplay improvements
--
-- Changes:
--   1. Add per_question_time_seconds to blitz_tournaments
--      (strict per-question timer, enforced client-side, validated server-side)
--   2. Add image_url to blitz_questions (optional image for visual questions)
--   3. Add options_order JSONB to blitz_attempts
--      (stores per-player shuffled option order for answer-sharing prevention)
--
-- Safe to re-run: all ADD COLUMN IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Per-question time limit (seconds). NULL = no per-question limit (legacy).
--    Recommended: 8 seconds.
ALTER TABLE blitz_tournaments
  ADD COLUMN IF NOT EXISTS per_question_time_seconds INTEGER DEFAULT NULL;

-- 2. Optional image URL on questions (Supabase Storage public URL or external URL)
ALTER TABLE blitz_questions
  ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT NULL;

-- 3. Shuffled options map per attempt
--    Stores { [question_id]: ['optA','optC','optB','optD'] } for each player
--    so answer-sharing in group chats is useless (C means different things per player)
ALTER TABLE blitz_attempts
  ADD COLUMN IF NOT EXISTS options_order JSONB DEFAULT NULL;
