-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Add per-question answer statistics to pills table
--
-- PURPOSE:
--   Track how often each question is answered and how often it is answered
--   correctly. Admins can use correct_rate to spot questions that are too easy
--   (differentiating power is low) or too hard/broken (very low correct_rate
--   may indicate an unclear question or a mis-keyed correct answer).
--
-- COLUMNS:
--   times_answered  — incremented every time a lock is acquired for this pill
--                     (i.e. the first genuine answer submission, never retries)
--   times_correct   — incremented only when the submitted answer is correct
--
-- IDEMPOTENT — safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE pills
  ADD COLUMN IF NOT EXISTS times_answered INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS times_correct  INTEGER NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- Stored procedure: increment_pill_stats
--
-- Called from each answer-submission route (pills, pillsVip, pillsSpecial)
-- AFTER the lock is acquired — guarantees no double-counting of retries.
--
-- p_pill_id   : UUID of the pill being answered
-- p_is_correct: whether the submitted answer was correct
--
-- Atomically does:
--   times_answered = times_answered + 1
--   times_correct  = times_correct  + (1 if correct, else 0)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION increment_pill_stats(
  p_pill_id    UUID,
  p_is_correct BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE pills
  SET
    times_answered = times_answered + 1,
    times_correct  = times_correct  + CASE WHEN p_is_correct THEN 1 ELSE 0 END
  WHERE id = p_pill_id;
END;
$$;
