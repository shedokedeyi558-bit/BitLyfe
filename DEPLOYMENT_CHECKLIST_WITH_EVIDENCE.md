# Pill Race Condition Fix: Deployment Checklist With Evidence

**Status:** Ready for execution  
**Date:** July 29, 2026

---

## REQUIRED: Manual SQL Deployment to Supabase

### Why Manual?
Supabase doesn't allow executing arbitrary DDL (ALTER TABLE, CREATE FUNCTION) through the JavaScript client for security reasons. The migration must be manually pasted and executed in the Supabase SQL Editor.

### Step 1: Deploy Database Migration

**Location:** https://app.supabase.co → Your Project → SQL Editor

**Action:**
1. Click "New query"
2. Select all text below (entire SQL block)
3. Paste into SQL Editor
4. Click "RUN"
5. Verify no errors in output

**SQL TO EXECUTE:**
```sql
-- ════════════════════════════════════════════════════════════════════════════════
-- PILL RACE CONDITION FIX: Add "opening" state to prevent simultaneous opens
-- ════════════════════════════════════════════════════════════════════════════════

-- Update the CHECK constraint to include 'opening' state
ALTER TABLE pills DROP CONSTRAINT IF EXISTS pills_status_check;

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

  RETURN QUERY SELECT (v_row_count > 0), v_previous_status, p_pill_id;
END;
$$;

-- RPC function to revert a pill from 'opening' back to 'available'
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

-- View to monitor pills stuck in 'opening' state
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
```

**Expected Output:**
```
Query executed successfully (no rows)
```

---

## Step 2: Verify SQL Deployment

After running the SQL above, verify the functions exist:

```sql
-- Test claim_pill_for_opening
SELECT * FROM claim_pill_for_opening('00000000-0000-0000-0000-000000000000'::UUID);
-- Should return: (false, "available", 00000000-0000-0000-0000-000000000000)

-- Test revert_pill_from_opening
SELECT * FROM revert_pill_from_opening('00000000-0000-0000-0000-000000000000'::UUID);
-- Should return: (false)

-- Check constraint
INSERT INTO pills (question, format, entry_fee, prize, correct_answer, status, options)
VALUES ('test', 'multiple_choice', 100, 1000, 'A', 'opening', '["A","B"]');
-- Should succeed (status='opening' is now allowed)
```

---

## Step 3: Deploy Code Changes

**File:** `server/src/routes/pills.js`

**Status:** ✓ Already updated with:
- Atomic pill claim call before payment (line ~550)
- Revert claim on billing failure (line ~590)
- Revert claim on pill_plays insert failure (line ~610)
- New error codes: PILL_BEING_OPENED, PILL_NO_LONGER_AVAILABLE

**Action:** Restart server to load updated code

```bash
cd server
npm start
# or if using nodemon:
npm run dev
```

---

## Step 4: Run Full Deployment Script

Once SQL migration is deployed and code is running:

```bash
cd server
node deploy_pill_fix.js
```

This will:
1. ✓ Verify RPC functions exist
2. ✓ Run test_pill_race_fix.js
3. ✓ Refund Player A ₦200
4. ✓ Create audit log entry
5. ✓ Audit for remaining duplicates
6. ✓ Report all results with evidence

---

## Evidence Collection: What We'll Capture

### Test Output
The test script will show:
- [ ] RPC functions deployed successfully
- [ ] CHECK constraint allows 'opening' status
- [ ] No pills stuck in 'opening' state
- [ ] No duplicate pill_plays entries

### Refund Evidence
The refund script will show:
- [ ] Player A identified correctly
- [ ] Balance before refund: ₦0
- [ ] Audit log created with full details
- [ ] Transaction recorded
- [ ] Balance after refund: ₦200
- [ ] Verification successful

### Duplicate Audit
The audit will show:
- [ ] Query results for duplicates
- [ ] Count of pills with multiple plays
- [ ] Before/after comparison

---

## Rollback Plan (If Issues)

If the fix causes problems:

1. **Revert code:**
   ```bash
   git revert <commit-hash>
   npm start
   ```

2. **Keep database changes:**
   - RPC functions and view remain (backward compatible)
   - CHECK constraint remains (allows existing statuses)
   - No data loss

3. **System reverts to pre-fix behavior:**
   - Race condition returns but system is stable
   - Can investigate and deploy revised fix

---

## Success Criteria

All of the following must be true:

- [ ] SQL migration runs without errors
- [ ] claim_pill_for_opening() RPC works
- [ ] revert_pill_from_opening() RPC works
- [ ] test_pill_race_fix.js passes
- [ ] Player A balance: ₦0 → ₦200 ✓
- [ ] Audit log created with pill_race_condition_refund action
- [ ] Transaction recorded in transactions table
- [ ] No new duplicates exist
- [ ] Code deployed and running

---

## Timeline

| Step | Action | Status | Evidence |
|------|--------|--------|----------|
| 1 | SQL migration | Pending | SQL execution output |
| 2 | SQL verification | Pending | RPC function test results |
| 3 | Code deployment | Ready | pills.js with atomic claiming |
| 4 | Run deploy_pill_fix.js | Pending | Full test/refund/audit output |
| 5 | Verify refund | Pending | Player A balance confirmed |
| 6 | Confirm no new duplicates | Pending | Audit query results |

---

## Next Step

1. Execute SQL migration in Supabase SQL Editor (copy the block above)
2. Verify: Check constraint and RPC functions work
3. Restart server
4. Run: `node server/deploy_pill_fix.js`
5. Capture all output as evidence
6. Report results

