-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Add 'announcement' to notifications.type CHECK constraint
-- Run this ONCE in the Supabase SQL editor before deploying the broadcast endpoint.
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop the existing CHECK constraint and replace it with one that includes
-- 'announcement'. Constraint names in Supabase are deterministic — if yours
-- differs, find it with:
--   SELECT conname FROM pg_constraint WHERE conrelid = 'notifications'::regclass;
-- then substitute the real name below.

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
    'announcement'
  ));
