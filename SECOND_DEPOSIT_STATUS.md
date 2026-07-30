# Second Deposit Investigation Status

**Player**: `eb481faa-2325-4c06-9c8c-9fa105454b67`  
**Phone**: `+2347048047900`  
**Reference**: `dep_faae5cec-3625-4907-bba0-ca71399ffae6`  
**Amount**: ₦500  
**Created**: 2026-07-29T20:36:52 UTC  
**Status**: **PENDING** (requires action)

---

## Current State

### In Database
```
✓ deposit_pending row exists
✓ Amount: ₦500
✓ Created: 2026-07-29T20:36:52 UTC
✗ No matching webhook received in webhook_logs
```

### Player's Account
```
✓ First deposit (₦500) was manually credited — balance now ₦700
? Second deposit (₦500) — status unknown
  • If SquadCo charged it: Should be credited separately
  • If SquadCo didn't charge it: No action needed
  • If still pending at SquadCo: Player needs to retry
```

---

## What Needs to Be Checked

### Via SquadCo Dashboard or API

**Question 1**: Has this transaction been charged?
- **Where to check**: SquadCo dashboard → Transactions or Charges section
- **Search for**: Reference `dep_faae5cec-3625-4907-bba0-ca71399ffae6`
- **Look for**: Amount ₦500 (50000 kobo) from this player's account

**Question 2**: If charged, what is the status?
- **Possible statuses**: 
  - `Success` → Money reached SquadCo (needs manual credit to player)
  - `Pending` → Charge is still processing (wait or ask player to retry)
  - `Failed` → Charge was declined (no money taken, safe to ignore)
  - `Abandoned` → User didn't complete payment (no money taken)

**Question 3**: Why no webhook?
- **Possible reasons**:
  - SquadCo didn't send webhook for successful charge (rare)
  - Webhook was sent but didn't match any pending deposit (reference mismatch)
  - Webhook was sent but failed to process (no log entry in webhook_logs)

---

## Decision Tree

### Scenario A: SquadCo shows `Success`
**Action**: Credit player ₦500 using same process as first deposit
```bash
# Adapt manual_credit_player.js:
REFERENCE = 'dep_faae5cec-3625-4907-bba0-ca71399ffae6'  # New reference
AMOUNT = 500
PLAYER_ID = 'eb481faa-2325-4c06-9c8c-9fa105454b67'     # Same player
# Run script
```

**Result**: Player balance becomes ₦1,200 (₦700 + ₦500)  
**Audit trail**: Documented in transactions table

### Scenario B: SquadCo shows `Failed`, `Pending`, or `Abandoned`
**Action**: No player credit needed
- Money wasn't charged to SquadCo account
- Suggest player retry deposit via frontend
- Delete pending record or let it expire

### Scenario C: SquadCo shows `Success` but has a different reference
**Action**: Check if reference mismatch
- Search SquadCo for alternate reference patterns
- May need to manually map transaction

### Scenario D: SquadCo has no record of this transaction
**Action**: Investigate why
- Was the deposit request actually sent to SquadCo?
- Check logs for API call failures
- Safe to ignore (no money taken)

---

## How to Query SquadCo

### Option 1: SquadCo Dashboard (Easiest)
1. Log in to SquadCo dashboard
2. Navigate to Transactions or Charges
3. Search for reference `dep_faae5cec-3625-4907-bba0-ca71399ffae6`
4. Note the status and amount

### Option 2: SquadCo API (Programmatic)
```bash
curl -X GET https://api-d.squadco.com/transaction/verify/dep_faae5cec-3625-4907-bba0-ca71399ffae6 \
  -H "Authorization: Bearer YOUR_SQUADCO_SECRET_KEY"
```

Expected response structure:
```json
{
  "status": 200,
  "data": {
    "transaction_status": "Success" | "failed" | "Pending" | "Abandoned",
    "transaction_amount": 50000,
    "transaction_ref": "dep_faae5cec-3625-4907-bba0-ca71399ffae6"
  }
}
```

### Option 3: Check Backend Logs
```bash
# Query webhook_logs in database
SELECT * FROM webhook_logs 
WHERE payload->>'transaction_ref' = 'dep_faae5cec-3625-4907-bba0-ca71399ffae6'
ORDER BY created_at DESC;

# If no results: No webhook was sent by SquadCo for this reference
```

---

## Tools Available

### Diagnostic Script
```bash
cd server
node check_second_deposit.js  # Shows pending deposit details
```

### Manual Credit Script (when needed)
```bash
# Modify REFERENCE and run:
cd server
node manual_credit_player.js
```

---

## Timeline

**2026-07-29**
- 20:22 UTC: First deposit initiated (`dep_8c92be6a...`)
- 20:24:34 UTC: First deposit webhook received (SquadCo confirmed success)
- 20:36:52 UTC: Second deposit initiated (`dep_faae5cec...`)
- **No webhook received for second deposit**

**2026-07-30**
- 07:11:21 UTC: First deposit manually credited (₦500)
- **Second deposit status: UNKNOWN**

---

## Recommended Action Order

1. **[User] Check SquadCo Dashboard** ← Highest priority
   - Takes ~2 minutes
   - Determines next action
   - Required to proceed

2. **[If Success]** Credit player using manual script
   - Takes ~1 minute
   - Uses proven process
   - Full audit trail

3. **[If Not Success]** No action needed
   - Money wasn't charged
   - Safe to close

4. **[Monitor]** After webhook fix deployed
   - Watch new deposits process correctly
   - Verify all webhooks reach system

---

## Notes

- ✅ First deposit is fully handled (credited + audit trail)
- ❓ Second deposit is **independent** of first
- 🔧 Webhook fix will prevent this happening again
- 📊 All decisions can be made from SquadCo dashboard data

---

**This investigation requires user action to check SquadCo's records.** The backend fix is deployed and ready; this is about determining what actually happened with the second payment.

