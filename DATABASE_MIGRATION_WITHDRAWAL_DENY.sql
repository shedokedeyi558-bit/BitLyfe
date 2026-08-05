-- Add 'denied' status and denial_reason column to withdrawal_requests
-- Denied withdrawals are for fraud/cheating — no refund issued

-- ─── Add denial_reason column ─────────────────────────────────────────────────

ALTER TABLE withdrawal_requests
ADD COLUMN IF NOT EXISTS denial_reason TEXT;

COMMENT ON COLUMN withdrawal_requests.denial_reason IS 'Admin-only audit reason for denied withdrawals (fraud/cheating cases where no refund is issued)';

-- ─── Verify ───────────────────────────────────────────────────────────────────

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'withdrawal_requests'
  AND column_name = 'denial_reason';
