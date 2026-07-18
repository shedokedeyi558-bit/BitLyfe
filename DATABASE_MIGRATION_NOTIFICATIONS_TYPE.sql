-- Migration: Add 'announcement' to notifications type CHECK constraint
-- Run in Supabase SQL editor.
--
-- The admin broadcast feature inserts type='announcement' but the CHECK
-- constraint didn't include it, causing every broadcast to fail silently
-- (Supabase returns a constraint violation error that the server swallows).
--
-- Also adds 'prediction_result' which is used by the prediction reveal
-- notification added in this session (was already in the constraint — no-op).

-- Drop the old constraint and replace with the expanded set.
-- IF NOT EXISTS is not supported for constraints — use DO block.
DO $$
BEGIN
  ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS notifications_type_check;

  ALTER TABLE notifications
    ADD CONSTRAINT notifications_type_check
    CHECK (type IN (
      'win',
      'loss',
      'new_event',
      'withdrawal_approved',
      'withdrawal_rejected',
      'blitz_starting',
      'prediction_result',
      'announcement'    -- required for admin broadcast feature
    ));
END $$;

-- Verify
SELECT constraint_name, check_clause
FROM information_schema.check_constraints
WHERE constraint_name = 'notifications_type_check';
