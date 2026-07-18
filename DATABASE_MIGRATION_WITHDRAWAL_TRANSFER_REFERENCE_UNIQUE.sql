-- Migration: Unique constraint on transfer_reference + processing status support
-- Run in Supabase SQL editor before deploying the idempotency changes.
--
-- 1. Unique constraint on transfer_reference — DB-level guarantee that no two
--    withdrawal rows can ever share the same Paystack reference, even if
--    application logic has a bug.
--
-- 2. The 'processing' status is used as an atomic mutex: the approve endpoint
--    flips status from 'pending' → 'processing' in a single UPDATE WHERE status='pending'.
--    If two concurrent requests both read 'pending' and both attempt the UPDATE,
--    only one UPDATE matches (the other sees 0 rows affected) and returns 409.
--    No separate lock, no SELECT-then-UPDATE race.
--
--    Full status lifecycle:
--      pending → processing → approved       (success path)
--      pending → processing → transfer_failed (Paystack failed)
--      pending → rejected                    (admin rejected before approve)
--      transfer_failed → approved            (retry succeeded)
--      transfer_failed → rejected            (admin gave up, refunded player)

-- Unique constraint — safe to add even if some rows currently have NULL
-- (NULL values don't violate UNIQUE in Postgres)
ALTER TABLE withdrawal_requests
  ADD CONSTRAINT uq_withdrawal_transfer_reference UNIQUE (transfer_reference);

-- Verify
SELECT constraint_name, constraint_type
FROM information_schema.table_constraints
WHERE table_name = 'withdrawal_requests'
  AND constraint_name = 'uq_withdrawal_transfer_reference';
