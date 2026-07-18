-- Migration: Add transfer_failed_reason column to withdrawal_requests
-- Run this in Supabase SQL editor before deploying the transfer_failed status changes.
--
-- transfer_failed_reason — stores the Paystack error message when a transfer fails,
--   so the admin can see why it failed without checking server logs.
--
-- The 'transfer_failed' status value itself requires no migration since
-- withdrawal_requests.status has no CHECK constraint.

ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS transfer_failed_reason TEXT;

-- Index for efficient filtering of transfer_failed withdrawals in admin panel
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status);

-- Verify the column was added
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'withdrawal_requests'
  AND column_name = 'transfer_failed_reason';
