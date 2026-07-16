-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Per-question answer locking (atomic, irreversible)
-- Run this ONCE in the Supabase SQL editor before deploying the updated routes.
-- All statements are idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. pill_plays: add locked_at column
--    When a pill answer is submitted, locked_at is stamped once and never overwritten.
ALTER TABLE pill_plays
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE pill_plays
  ADD COLUMN IF NOT EXISTS submitted_answer TEXT;

-- Index: fast lookup for "is this play already locked?"
CREATE INDEX IF NOT EXISTS idx_pill_plays_locked_at
  ON pill_plays (pill_id, player_id)
  WHERE locked_at IS NOT NULL;

-- 2. special_attempts: add answer_locked_at JSONB array
--    Parallel to the answers[] column — each slot holds the ISO timestamp of
--    when that question index was locked, or null if not yet answered.
--    Default '[]' for new rows; existing rows get null → we handle that in code.
ALTER TABLE special_attempts
  ADD COLUMN IF NOT EXISTS answer_locked_at JSONB NOT NULL DEFAULT '[]';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Stored procedure: lock_special_answer
--
--    Atomically locks a single question slot in special_attempts using a
--    conditional UPDATE that only fires when:
--      a) the attempt is still in_progress
--      b) the slot at p_idx in answer_locked_at is currently JSON null
--
--    Returns the number of rows updated (1 = lock acquired, 0 = already locked).
--
--    Called from the answer route as:
--      supabase.rpc('lock_special_answer', {
--        p_attempt_id, p_player_id, p_idx, p_answer, p_now
--      })
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION lock_special_answer(
  p_attempt_id UUID,
  p_player_id  UUID,
  p_idx        INTEGER,
  p_answer     TEXT,
  p_now        TIMESTAMPTZ
)
RETURNS INTEGER           -- rows updated: 1 = success, 0 = already locked
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Pad the arrays to at least p_idx+1 slots if they're shorter than expected
  -- (handles the case where answer_locked_at was [] on an older row).
  -- Then set slot p_idx to p_answer / p_now only when that slot is currently null.
  UPDATE special_attempts
  SET
    answers = (
      -- Ensure the array is long enough, then set slot p_idx
      CASE
        WHEN jsonb_array_length(
               CASE WHEN jsonb_array_length(answers) > p_idx
                    THEN answers
                    ELSE answers || jsonb_build_array(NULL)  -- extend by 1 if needed
               END
             ) > p_idx
        THEN jsonb_set(answers, ARRAY[p_idx::TEXT], to_jsonb(p_answer))
        ELSE answers
      END
    ),
    answer_locked_at = (
      CASE
        WHEN jsonb_array_length(
               CASE WHEN jsonb_array_length(answer_locked_at) > p_idx
                    THEN answer_locked_at
                    ELSE answer_locked_at || jsonb_build_array(NULL)
               END
             ) > p_idx
        THEN jsonb_set(answer_locked_at, ARRAY[p_idx::TEXT], to_jsonb(p_now::TEXT))
        ELSE answer_locked_at
      END
    )
  WHERE id            = p_attempt_id
    AND player_id     = p_player_id
    AND status        = 'in_progress'
    -- The core lock condition: slot p_idx must currently be null (never answered)
    AND (
          jsonb_array_length(answer_locked_at) <= p_idx
          OR (answer_locked_at -> p_idx) IS NULL
          OR (answer_locked_at -> p_idx) = 'null'::jsonb
        );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Stored procedure: lock_pill_answer
--
--    Atomically locks a pill_plays row:
--      UPDATE ... SET locked_at = p_now, submitted_answer = p_answer
--      WHERE pill_id = p_pill_id AND player_id = p_player_id AND locked_at IS NULL
--
--    Returns rows updated (1 = success, 0 = already locked).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION lock_pill_answer(
  p_pill_id   UUID,
  p_player_id UUID,
  p_answer    TEXT,
  p_now       TIMESTAMPTZ
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE pill_plays
  SET
    locked_at        = p_now,
    submitted_answer = p_answer
  WHERE pill_id   = p_pill_id
    AND player_id = p_player_id
    AND locked_at IS NULL;   -- ← the lock gate

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
