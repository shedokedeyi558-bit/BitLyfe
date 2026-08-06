-- Add manual payment tracking columns to withdrawal_requests
-- Used by PUT /api/admin/withdrawals/:id/mark-paid-manual

ALTER TABLE withdrawal_requests
ADD COLUMN IF NOT EXISTS manual_reference TEXT,
ADD COLUMN IF NOT EXISTS manual_note      TEXT;

COMMENT ON COLUMN withdrawal_requests.manual_reference IS 'Optional payment reference recorded by admin when marking a withdrawal as manually paid (e.g. OPay transaction ID)';
COMMENT ON COLUMN withdrawal_requests.manual_note      IS 'Optional free-text note recorded by admin when marking a withdrawal as manually paid';

-- Verify
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'withdrawal_requests'
  AND column_name IN ('manual_reference', 'manual_note')
ORDER BY column_name;
