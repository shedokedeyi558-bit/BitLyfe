# SquadCo Webhook Parsing Bug — INCIDENT CLOSED

**Date**: 2026-07-30  
**Status**: ✅ **FULLY RESOLVED**  
**Scope**: 3 successful SquadCo transactions, all credited  
**Root Cause**: Fixed in code (commit `b3f5c26`)  
**Players Affected**: 2 (with full compensation)

---

## Incident Summary

### The Bug
SquadCo webhook handler in `server/src/index.js` line 220 attempted to read transaction data from `event.data` (Paystack structure), but SquadCo webhooks contain data in `event.Body`. Result: **ALL successful SquadCo deposits after Paystack migration silently failed to credit players.**

### The Fix
```javascript
// BEFORE (broken):
const { transaction_ref, amount, transaction_status } = event.data;  // undefined

// AFTER (fixed):
const eventData = event.Body || event;
const { transaction_ref, amount, transaction_status } = eventData;  // ✓ Works
```

**Commit**: `b3f5c26`

---

## Affected Transactions — CONFIRMED & CREDITED

### Transaction 1: Player `eb481faa-2325-4c06-9c8c-9fa105454b67`

**Payment Reference**: `dep_8c92be6a-ff02-464e-80c6-2673268fae61`  
**Amount**: ₦500  
**Phone**: +2347048047900  
**Webhook Received**: 2026-07-29T20:24:34 UTC  
**SquadCo Status**: ✅ **Success** (confirmed)  
**Action**: ✅ Manually credited  
**Balance Impact**: ₦200 → ₦700  
**Audit Trail**: Transaction ID `aa91880a-2d72-4bbd-b2b8-6383e07622d2`

### Transaction 2: Player `15f1d00f-69ac-447e-8a69-612090c03308`

**Payment Reference**: `dep_cf12190a-053b-48a2-a307-ffd4b3fdbf86`  
**Amount**: ₦200  
**Phone**: +2347010707754  
**Webhook Received**: 2026-07-29T21:04:53 UTC  
**SquadCo Status**: ✅ **Success** (confirmed)  
**Action**: ✅ Manually credited  
**Balance Impact**: ₦0 → ₦200  
**Audit Trail**: Transaction ID `6bc0c6cd-169f-44d6-8bc6-1ff9e5104832`

### Transaction 3: Player `15f1d00f-69ac-447e-8a69-612090c03308` (Second Deposit)

**Payment Reference**: `dep_9dbbf70d-b6fb-44b5-aaa5-c0493c517bb4`  
**Amount**: ₦200 (second deposit)  
**Phone**: +2347010707754  
**Webhook Received**: 2026-07-30T07:15:53 UTC  
**SquadCo Status**: ✅ **Success** (confirmed)  
**Action**: ✅ Manually credited  
**Balance Impact**: ₦200 → ₦400  
**Audit Trail**: Transaction ID `c8f5e328-816b-41fd-a63f-fcae64489346`

---

## Final Verification

### All Webhooks Query Results

```
Query: webhook_logs WHERE event_type='charge_successful'
Result: 3 total webhooks found
Status: All 3 have transaction_status: "Success"
```

**Webhooks**:
1. ✅ `dep_8c92be6a-ff02-464e-80c6-2673268fae61` | ₦500 | Success
2. ✅ `dep_cf12190a-053b-48a2-a307-ffd4b3fdbf86` | ₦200 | Success
3. ✅ `dep_9dbbf70d-b6fb-44b5-aaa5-c0493c517bb4` | ₦200 | Success

### All Completed Deposits Query Results

```
Query: transactions WHERE type='deposit' AND created_at >= 2026-07-29
Result: 4 completed deposits (3 from incident, 1 pre-incident)
```

**Pre-Incident**:
- `dep_10d28972-f058-42ea-87f9-f0479d082d45` | ₦500 | Player eb481faa... (completed 2026-07-29T09:54)

**Post-Incident Credits**:
1. ✅ `dep_8c92be6a-ff02-464e-80c6-2673268fae61` | ₦500 | Player eb481faa... (credited 2026-07-30T07:11)
2. ✅ `dep_cf12190a-053b-48a2-a307-ffd4b3fdbf86` | ₦200 | Player 15f1d00f... (credited 2026-07-30T07:25)
3. ✅ `dep_9dbbf70d-b6fb-44b5-aaa5-c0493c517bb4` | ₦200 | Player 15f1d00f... (credited 2026-07-30T07:27)

### Player Final Balances

**Player eb481faa-2325-4c06-9c8c-9fa105454b67**:
- Phone: +2347048047900
- Initial balance: ₦200
- Credited: ₦500
- **Final balance: ₦700** ✓

**Player 15f1d00f-69ac-447e-8a69-612090c03308**:
- Phone: +2347010707754
- Initial balance: ₦0
- Credited: ₦200 + ₦200 = ₦400
- **Final balance: ₦400** ✓

---

## Other Pending Deposits (NOT Affected by This Bug)

These 5 pending deposits **did NOT receive successful webhooks** and are therefore NOT credited. They were either failed at SquadCo or no webhook was sent:

1. `dep_b575864c-ffa6-4d6b-8b36-56d68653436f` | ₦200 | Player 15f1d00f... | NO SUCCESS WEBHOOK
2. `dep_3abea6fb-b3ac-4cff-a2dc-f8aa8dd73ac2` | ₦200 | Player 15f1d00f... | NO SUCCESS WEBHOOK
3. `dep_866f2160-5473-467b-a738-939bff869cb0` | ₦200 | Player 15f1d00f... | NO SUCCESS WEBHOOK
4. `dep_faae5cec-3625-4907-bba0-ca71399ffae6` | ₦500 | Player eb481faa... | NO SUCCESS WEBHOOK (known from earlier)
5. `dep_0c57fff4-49f0-428f-8a02-7a4962fb6d63` | ₦1000 | Player 8a76c05f... | NO SUCCESS WEBHOOK

**Status**: These are NOT part of the webhook bug fix. They require separate investigation (may have failed at SquadCo, or webhooks not sent yet).

---

## Incident Timeline

| Time | Event |
|------|-------|
| 2026-07-29 09:54 | Player eb481faa deposits ₦500 (pre-incident, completed normally) |
| 2026-07-29 20:22 | Player eb481faa initiates 2nd deposit ₦500 (webhook #1) |
| 2026-07-29 20:24:34 | SquadCo webhook received: `dep_8c92be6a...` Success ✓ |
| 2026-07-29 21:03:50 | Player 15f1d00f initiates deposit ₦200 (webhook #2) |
| 2026-07-29 21:04:53 | SquadCo webhook received: `dep_cf12190a...` Success ✓ |
| 2026-07-29 21:36:52 | Player eb481faa initiates 3rd deposit ₦500 (pending, no webhook success) |
| 2026-07-30 07:12:22 | Player 15f1d00f initiates 2nd deposit ₦200 (webhook #3) |
| 2026-07-30 07:15:53 | SquadCo webhook received: `dep_9dbbf70d...` Success ✓ |
| 2026-07-30 07:11 | Manually credited player eb481faa ₦500 |
| 2026-07-30 07:25 | Manually credited player 15f1d00f ₦200 (1st deposit) |
| 2026-07-30 07:27 | Manually credited player 15f1d00f ₦200 (2nd deposit) |

---

## Root Cause Analysis

### Why Only 3 Transactions?
Not all transactions that come through the app result in successful SquadCo charges. Many fail at SquadCo's payment gateway or the user abandons them. **Only the 3 that have `transaction_status: "Success"` in the webhook were actually confirmed paid by SquadCo.**

### Why Were These 3 Not Credited?
The webhook handler tried to read from `event.data`, which doesn't exist in SquadCo's payload structure. The `event.Body` field (which contains the actual transaction data) was never accessed. Result: transaction parsing failed silently, no deposit transaction was created, balance was never updated.

### Why Didn't We Notice Sooner?
The webhook handler doesn't explicitly fail or raise errors—it silently skips deposits when `event.data` is undefined. The webhook_logs table shows status='received' but never updates to 'processed'. Without monitoring that, the silent failure would go unnoticed.

---

## Evidence & Verification

### Webhook Logs (Real Data)
```
Event: charge_successful
Payload.Body.transaction_ref: dep_8c92be6a-ff02-464e-80c6-2673268fae61
Payload.Body.transaction_status: Success
Payload.Body.amount: 50000 (kobo)

→ Confirmed SquadCo received and approved this payment
→ Webhook was sent to backend
→ Backend failed to parse (looking for event.data instead of event.Body)
→ Balance never credited (₦500 missing)
```

### Database Records
- ✅ All 3 transactions exist as deposit_pending in DB
- ✅ All 3 now exist as completed deposit transactions
- ✅ Player balances updated correctly
- ✅ Audit trail established for each credit

---

## Code Changes Summary

### Deployed Fix
**File**: `server/src/index.js`  
**Lines**: 218–224  
**Change**: 1 line to add fallback for event structure

```javascript
- const { transaction_ref, amount, transaction_status } = event.data;
+ const eventData = event.Body || event;
+ const { transaction_ref, amount, transaction_status } = eventData;
```

**Commit**: `b3f5c26` — "Fix: SquadCo webhook payload parsing bug — use event.Body instead of event.data"

---

## Post-Incident Actions

### Completed ✅
1. Identified root cause (event.data vs event.Body)
2. Fixed webhook handler in index.js
3. Manually credited all 3 affected players
4. Created comprehensive audit trail
5. Verified no other affected transactions
6. Confirmed only these 3 successful SquadCo charges in affected window

### Recommended (Future)
1. Monitor webhook_logs for status='received' entries (indicates processing failures)
2. Add monitoring/alerting for deposits that don't complete within 5 minutes
3. Test SquadCo webhook structure in staging (verify event.Body access)
4. Consider adding unit test for webhook payload parsing

---

## Incident Closure Sign-Off

**Affected Players**: 2  
**Total Amount Credited**: ₦900  
**All Successful Transactions**: Credited ✓  
**Root Cause**: Fixed ✓  
**Fix Deployed**: Yes (commit `b3f5c26`)  
**Manual Credits**: Audited ✓  

**Status**: 🟢 **INCIDENT FULLY RESOLVED**

---

**This incident has been thoroughly investigated, all affected players have been compensated with full audit trail, and the root cause has been fixed in production.**

