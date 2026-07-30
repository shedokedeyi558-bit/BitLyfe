-- ════════════════════════════════════════════════════════════════════════════════
-- PILL RACE CONDITION FIX: SQL MIGRATION FOR SUPABASE
-- 
-- INSTRUCTIONS:
-- 1. Go to: https://app.supabase.co → Your Project → SQL Editor
-- 2. Click "New query"
-- 3. Copy entire contents of THIS FILE
-- 4. Paste into SQL Editor
-- 5. Click "RUN" (or Ctrl+Enter)
-- 6. Wait for completion (~5 seconds)
-- 7. Verify: No errors in output
-- 8. Proceed to next step
--
-- WHAT THIS DEPLOYS:
-- - ALTER TABLE: Add 'opening' status to pills.status CHECK constraint
-- - CREATE FUNCTION: claim_pill_for_opening() RPC
-- - CREATE FUNCTION: revert_pill_from_opening() RPC
-- - CREATE VIEW: opening_pills_stale (for monitoring)
-- ════════════════════════════════════════════════════════════════════════════════

-- ─── Update CHECK Constraint ─────────────────────────────────────────────────
-- Add 'opening' state to represent pills currently being opened by a player

ALTER TABLE pills DROP CONSTRAINT IF EXISTS pills_status_check;

ALTER TABLE pills
ADD CONSTRAINT pills_status_check 
CHECK (status IN ('available', 'opening', 'played', 'expired'));

-- ─── Atomic Pill Claiming Function ──────────────────────────────────────────
-- Atomically transition pill from 'available' to 'opening'
-- Returns: (success, previous_status, pill_id)
-- 
-- Usage: SELECT * FROM claim_pill_for_opening('pill-id'::UUID)
-- Returns: (true, 'available', 'pill-id') if claimed
--          (false, 'status', 'pill-id') if already taken

CREATE OR REPLACE FUNCTION claim_pill_for_opening(p_pill_id UUID)
RETURNS TABLE (
  success BOOLEAN,
  previous_status TEXT,
  pill_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_previous_status TEXT;
  v_row_count INT;
BEGIN
  -- Atomically transition 'available' → 'opening'
  -- Only succeeds if pill.status = 'available'
  WITH updated AS (
    UPDATE pills
    SET status = 'opening', updated_at = NOW()
    WHERE id = p_pill_id 
      AND status = 'available'
    RETURNING status
  )
  SELECT COUNT(*), (SELECT status FROM pills WHERE id = p_pill_id LIMIT 1)
  INTO v_row_count, v_previous_status;

  -- Return success flag + current status
  RETURN QUERY SELECT (v_row_count > 0), v_previous_status, p_pill_id;
END;
$$;

-- ─── Pill Claim Reversion Function ──────────────────────────────────────────
-- Revert a pill from 'opening' back to 'available'
-- Used when billing fails or pill_plays insert fails
-- 
-- Usage: SELECT * FROM revert_pill_from_opening('pill-id'::UUID)
-- Returns: (true) if reverted
--          (false) if pill was not in 'opening' state

CREATE OR REPLACE FUNCTION revert_pill_from_opening(p_pill_id UUID)
RETURNS TABLE (success BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE pills
  SET status = 'available', updated_at = NOW()
  WHERE id = p_pill_id AND status = 'opening';

  RETURN QUERY SELECT ROW_COUNT() > 0;
END;
$$;

-- ─── Monitoring View ────────────────────────────────────────────────────────
-- Identifies pills stuck in 'opening' state (possible abandoned opens)
-- A pill should only be in 'opening' for ~timer_seconds + 5 seconds

CREATE OR REPLACE VIEW opening_pills_stale AS
SELECT 
  p.id,
  p.question,
  p.timer_seconds,
  p.updated_at,
  NOW() - p.updated_at as time_stuck,
  CASE 
    WHEN NOW() - p.updated_at > INTERVAL '1' MINUTE THEN 'STALE (>1min)'
    WHEN NOW() - p.updated_at > INTERVAL '30 SECOND' * (p.timer_seconds + 5) 
      THEN 'STALE (>timer+5s)'
    ELSE 'OK'
  END as state
FROM pills p
WHERE p.status = 'opening';

-- ════════════════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (Run these to confirm deployment was successful)
-- ════════════════════════════════════════════════════════════════════════════════

-- Test 1: Verify CHECK constraint
-- Expected: Query succeeds (no constraint violation)
-- INSERT INTO pills (question, format, entry_fee, prize, correct_answer, status, options)
-- VALUES ('test', 'multiple_choice', 100, 1000, 'A', 'opening', '["A","B"]');

-- Test 2: Verify claim_pill_for_opening function
-- Expected: Returns (false, 'available', 00000000-0000-0000-0000-000000000000)
-- SELECT * FROM claim_pill_for_opening('00000000-0000-0000-0000-000000000000'::UUID);

-- Test 3: Verify revert_pill_from_opening function
-- Expected: Returns (false)
-- SELECT * FROM revert_pill_from_opening('00000000-0000-0000-0000-000000000000'::UUID);

-- Test 4: Verify opening_pills_stale view
-- Expected: Returns 0 rows (no pills stuck in opening)
-- SELECT * FROM opening_pills_stale WHERE state LIKE 'STALE%';

-- ════════════════════════════════════════════════════════════════════════════════
-- END OF SQL MIGRATION
-- ════════════════════════════════════════════════════════════════════════════════
