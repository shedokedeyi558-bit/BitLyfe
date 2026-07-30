-- ════════════════════════════════════════════════════════════════════════════════
-- PILL RACE CONDITION FIX: Add "opening" state to prevent simultaneous opens
-- ════════════════════════════════════════════════════════════════════════════════
--
-- Problem: Two players could both open the same pill before either answered,
-- creating duplicate pill_plays entries for the same pill.
--
-- Solution: Atomically claim a pill with status='opening' when opened.
-- If another player already claimed it, the UPDATE returns 0 rows → refund & reject.
--
-- The state transitions are now:
--   'available' → 'opening' (when any player opens it)
--   'opening'   → 'played'   (when someone answers it)
--
-- ════════════════════════════════════════════════════════════════════════════════

-- Verify the pills table has a status column (should already exist)
-- and that it uses CHECK constraint for allowed values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pills' AND column_name = 'status'
  ) THEN
    RAISE EXCEPTION 'pills.status column not found';
  END IF;
END $$;

-- Update the CHECK constraint to include 'opening' state
-- First, drop the old constraint if it exists
ALTER TABLE pills DROP CONSTRAINT IF EXISTS pills_status_check;

-- Add new CHECK constraint that includes 'opening'
ALTER TABLE pills
ADD CONSTRAINT pills_status_check 
CHECK (status IN ('available', 'opening', 'played', 'expired'));

-- Create RPC function to atomically claim a pill for opening
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
  WITH updated AS (
    UPDATE pills
    SET status = 'opening', updated_at = NOW()
    WHERE id = p_pill_id 
      AND status = 'available'
    RETURNING status
  )
  SELECT COUNT(*), (SELECT status FROM pills WHERE id = p_pill_id LIMIT 1)
  INTO v_row_count, v_previous_status;

  -- Return success if we got the lock (row_count > 0)
  RETURN QUERY SELECT (v_row_count > 0), v_previous_status, p_pill_id;
END;
$$;

-- Verify the function works and revert the pill if it fails
-- This is in the app code (pills.js open() endpoint)

-- ════════════════════════════════════════════════════════════════════════════════
-- RPC function to revert a pill from 'opening' back to 'available'
-- (used if billing fails or player abandons)
-- ════════════════════════════════════════════════════════════════════════════════

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

-- ════════════════════════════════════════════════════════════════════════════════
-- AUDIT: Find pills that are stuck in 'opening' state
-- (should transition to 'played' within timer_seconds + 5 seconds)
-- ════════════════════════════════════════════════════════════════════════════════

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
-- DATA CLEANUP: Fix existing duplicate
-- ════════════════════════════════════════════════════════════════════════════════

-- Find the pill with 2 plays (the one from the incident)
-- and determine which should be refunded
SELECT 
  p.id,
  COUNT(*) as play_count,
  ARRAY_AGG(pp.player_id) as players,
  ARRAY_AGG(pp.locked_at) as locked_times,
  ARRAY_AGG(pp.won) as won_values
FROM pills p
LEFT JOIN pill_plays pp ON pp.pill_id = p.id
GROUP BY p.id
HAVING COUNT(*) > 1;

-- Note: The cleanup decision should be:
-- - Keep the play where locked_at IS NOT NULL (the winner)
-- - Refund the player whose play has locked_at = NULL (abandoned/never answered)
-- 
-- This is a one-time manual fix — the RPC above prevents it from happening again.

-- ════════════════════════════════════════════════════════════════════════════════
-- VERIFICATION: After deploying the fix, run this to confirm no more duplicates
-- ════════════════════════════════════════════════════════════════════════════════

-- Should return 0 rows (no duplicates)
SELECT 
  pill_id,
  COUNT(*) as play_count
FROM pill_plays
GROUP BY pill_id
HAVING COUNT(*) > 1;

-- Should return 0 or very few rows (pills stuck in 'opening' state)
SELECT * FROM opening_pills_stale WHERE state LIKE 'STALE%';
