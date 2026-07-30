# MANUAL DEPLOYMENT REQUIRED: Pill Race Condition Fix

## Database Migration (MUST BE DONE FIRST)

This step requires manual execution in Supabase because RPC deployments cannot be automated via the JavaScript client.

### Instructions:
1. Go to: https://app.supabase.co → Your Project → SQL Editor
2. Create a NEW query
3. Copy the ENTIRE contents of this file: `DATABASE_MIGRATION_PILL_RACE_FIX.sql`
4. Paste into SQL Editor
5. Click "Run" (or Ctrl+Enter)
6. Wait for completion (should take ~5 seconds)
7. Verify: No errors in output
8. Return here and run: `node deploy_pill_fix.js`

### What gets deployed:
- ✓ ALTER TABLE pills CHECK constraint (add 'opening' status)
- ✓ CREATE FUNCTION claim_pill_for_opening() RPC
- ✓ CREATE FUNCTION revert_pill_from_opening() RPC
- ✓ CREATE VIEW opening_pills_stale (for monitoring)

---

## Automated Steps (After SQL migration)

Once the SQL migration is deployed to Supabase, the following run automatically:

```bash
cd server
node deploy_pill_fix.js
```

This executes:
1. ✓ Verify RPC functions deployed
2. ✓ Run test_pill_race_fix.js (verify atomic claiming works)
3. ✓ Refund Player A ₦200 → audit log + transaction
4. ✓ Check for remaining duplicates
5. ✓ Report all results with evidence

---

## Current Status

**Database Migration:** PENDING (awaiting manual Supabase SQL execution)
**Code Deployment:** READY (pills.js already updated)
**Testing:** READY (test_pill_race_fix.js created)
**Refund:** READY (deploy_pill_fix.js handles it)

---

## Next Step

1. Deploy SQL migration in Supabase (copy DATABASE_MIGRATION_PILL_RACE_FIX.sql)
2. Run: `node server/deploy_pill_fix.js`
3. Capture output as evidence
