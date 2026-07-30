-- ─────────────────────────────────────────────────────────────────────────────
-- CRITICAL: Audit the failed deposit (₦2000 at 20:45 today)
-- Run this in Supabase SQL Editor to get the ground truth
-- ─────────────────────────────────────────────────────────────────────────────

-- STEP 1: Find the deposit transaction from today at 20:45
SELECT 
  'TRANSACTION RECORD' as category,
  id,
  player_id,
  type,
  amount,
  description,
  reference,
  created_at
FROM transactions
WHERE 
  type IN ('deposit', 'deposit_pending', 'deposit_settled')
  AND DATE(created_at) = CURRENT_DATE
  AND EXTRACT(HOUR FROM created_at) = 20
ORDER BY created_at DESC
LIMIT 10;

-- STEP 2: Get the player ID from that transaction, then check their balance
WITH deposit_txn AS (
  SELECT player_id, reference FROM transactions
  WHERE type IN ('deposit', 'deposit_pending', 'deposit_settled')
    AND DATE(created_at) = CURRENT_DATE
    AND EXTRACT(HOUR FROM created_at) = 20
  ORDER BY created_at DESC LIMIT 1
)
SELECT 
  'PLAYER BALANCE' as category,
  p.id,
  p.email,
  p.phone,
  p.balance,
  p.bonus_balance,
  (p.balance + COALESCE(p.bonus_balance, 0)) as total,
  p.created_at
FROM players p
WHERE p.id = (SELECT player_id FROM deposit_txn)
LIMIT 1;

-- STEP 3: Get ALL transactions for that player (to see the history)
WITH deposit_txn AS (
  SELECT player_id FROM transactions
  WHERE type IN ('deposit', 'deposit_pending', 'deposit_settled')
    AND DATE(created_at) = CURRENT_DATE
    AND EXTRACT(HOUR FROM created_at) = 20
  ORDER BY created_at DESC LIMIT 1
)
SELECT 
  'ALL TRANSACTIONS FOR PLAYER' as category,
  id,
  type,
  amount,
  description,
  reference,
  created_at
FROM transactions
WHERE player_id = (SELECT player_id FROM deposit_txn)
ORDER BY created_at DESC
LIMIT 20;

-- ─────────────────────────────────────────────────────────────────────────────
-- ANALYSIS QUESTIONS TO ANSWER:
-- 
-- Q1: What is the reference for the ₦2000 deposit?
--     Copy the reference from STEP 1 result → reference column
-- 
-- Q2: Is the transaction type "deposit" or "deposit_pending"?
--     If "deposit_pending" → verify() never called, balance shouldn't be credited
--     If "deposit" → verify() was called, balance should be credited
-- 
-- Q3: What does the player table show for balance?
--     If balance = 0 but transaction type = "deposit" → CRITICAL BUG (balance not updated)
--     If balance = 2000 and transaction type = "deposit" → working correctly
--     If balance = 0 and transaction type = "deposit_pending" → webhook never fired
-- 
-- Q4: Are there ANY deposit transactions (types: deposit, deposit_settled)?
--     If none → the transaction history UI is showing fake data or old test data
--     If one "deposit" with ₦2000 → a verify() call was made, but why no balance update?
-- ─────────────────────────────────────────────────────────────────────────────
