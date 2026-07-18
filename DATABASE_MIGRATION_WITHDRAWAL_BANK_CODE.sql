-- Migration: Add bank_code to withdrawal_requests
-- Run this in Supabase SQL editor before deploying the updated withdrawal endpoints.
--
-- bank_code  — Paystack numeric bank code (e.g. "058" for GTBank). Required for
--              createTransferRecipient(). Stored alongside bank_name which is kept
--              for display purposes only.
--
-- recipient_code — Paystack transfer recipient code returned after a successful
--                  createTransferRecipient() call. Stored so a failed transfer can
--                  be retried without creating a duplicate recipient.
--
-- transfer_reference — the UUID reference used for the Paystack transfer. Stored
--                      for idempotency: if approve is called twice, the second call
--                      checks for an existing reference and skips the Paystack call.

ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS bank_code TEXT;
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS recipient_code TEXT;
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS transfer_reference TEXT;

-- ─── Backfill: map common Nigerian bank names to Paystack bank codes ───────────
-- Covers the most common banks. Any row still NULL after this update will be
-- flagged at approval time with a clear error rather than silently failing.
-- Only updates rows that are still pending (approved/rejected rows are historical).

UPDATE withdrawal_requests
SET bank_code = CASE
  WHEN bank_name ILIKE '%access%'              THEN '044'
  WHEN bank_name ILIKE '%zenith%'              THEN '057'
  WHEN bank_name ILIKE '%gtbank%'
    OR bank_name ILIKE '%guaranty%'            THEN '058'
  WHEN bank_name ILIKE '%uba%'
    OR bank_name ILIKE '%united bank%'         THEN '033'
  WHEN bank_name ILIKE '%first bank%'          THEN '011'
  WHEN bank_name ILIKE '%fcmb%'
    OR bank_name ILIKE '%first city%'          THEN '214'
  WHEN bank_name ILIKE '%fidelity%'            THEN '070'
  WHEN bank_name ILIKE '%union bank%'          THEN '032'
  WHEN bank_name ILIKE '%ecobank%'             THEN '050'
  WHEN bank_name ILIKE '%stanbic%'             THEN '221'
  WHEN bank_name ILIKE '%sterling%'            THEN '232'
  WHEN bank_name ILIKE '%heritage%'            THEN '030'
  WHEN bank_name ILIKE '%keystone%'            THEN '082'
  WHEN bank_name ILIKE '%polaris%'             THEN '076'
  WHEN bank_name ILIKE '%wema%'
    OR bank_name ILIKE '%alat%'                THEN '035'
  WHEN bank_name ILIKE '%opay%'                THEN '100004'
  WHEN bank_name ILIKE '%palmpay%'             THEN '100033'
  WHEN bank_name ILIKE '%kuda%'                THEN '090267'
  WHEN bank_name ILIKE '%moniepoint%'          THEN '50515'
  WHEN bank_name ILIKE '%providus%'            THEN '101'
  WHEN bank_name ILIKE '%jaiz%'                THEN '301'
  WHEN bank_name ILIKE '%unity%'               THEN '215'
  WHEN bank_name ILIKE '%standard chartered%'  THEN '068'
  WHEN bank_name ILIKE '%citibank%'            THEN '023'
  ELSE NULL  -- will be caught at approval time
END
WHERE bank_code IS NULL
  AND status = 'pending';

-- Show any pending rows that still have no bank_code after backfill
-- (these will need manual resolution before approval)
SELECT id, phone, amount, bank_name, bank_code, status
FROM withdrawal_requests
WHERE status = 'pending'
  AND bank_code IS NULL;
