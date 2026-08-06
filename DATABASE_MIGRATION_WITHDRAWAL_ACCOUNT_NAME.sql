-- Add account_name column to withdrawal_requests
-- Stores the resolved account holder name (from Paystack resolve-account)
-- Required at withdrawal creation time — used by admin for manual payout verification

ALTER TABLE withdrawal_requests
ADD COLUMN IF NOT EXISTS account_name TEXT;

COMMENT ON COLUMN withdrawal_requests.account_name IS 'Account holder name as resolved by Paystack at withdrawal creation time. Required for admin manual payout verification.';

-- Verify
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'withdrawal_requests'
  AND column_name = 'account_name';
