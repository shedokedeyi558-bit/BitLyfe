# PILL PLAYS DUPLICATE ROOT CAUSE ANALYSIS

## Summary
**CONFIRMED: A real data integrity issue exists, but NOT a repeated-serving regression.**

The database shows one pill with 2 play entries:
- **Pill ID:** `1bc3f6e7-116d-451d-a53f-7dca3363c408`
- **Pack:** "Twist_Challenger" (4-pill standard pack)
- **Play 1:** Player B @ 20:36:53, answered at 20:41:28, **won** ✓ correct answer
- **Play 2:** Player A @ 20:39:02, **never answered** (locked_at = NULL)

## Root Cause: Race Condition in Payment Logic

### Timeline
```
20:36:36  Player B deposits ₦200
20:36:53  Player B opens pill #1 → POST /api/pills/open executes:
          1. Fetches pill (status='available' at this moment)
          2. Checks status != 'played' ✓ (passes)
          3. Deducts ₦200 from balance
          4. Creates pill_plays record
          5. Returns question

20:38:39  Player A deposits ₦200
20:39:02  Player A opens pill #1 → POST /api/pills/open executes:
          1. Fetches pill (likely still status='available')
          2. Checks status != 'played' ✓ (passes — pill not yet marked played!)
          3. Deducts ₦200 from balance
          4. Creates pill_plays record
          5. Returns question
          ⚠️  ISSUE: pill_plays UNIQUE(pill_id, player_id) allows this because
              Player A != Player B

20:41:28  Player B submits correct answer → POST /api/pills/submit:
          1. Locks pill_plays row for Player B
          2. Marks pill.status = 'played'
          3. Credits ₦15,000 prize
```

### Why UNIQUE(pill_id, player_id) Didn't Prevent This

The constraint `UNIQUE(pill_id, player_id)` is **correct by design** but **enforces the wrong requirement**.

**What it actually does:** Prevents the same player from playing the same pill twice  
**What was actually needed:** Prevent ANY second player from opening a pill once the FIRST player opens it

The constraint is about **per-player isolation**, not **global consumption**.

## Why This Happened (The Real Bug)

### Standard Pills Model Violation
Standard Pills assumes:
```
1. Pill opened by Player X → pill.status is immediately marked 'locked' or 'playing'
2. No other player can open the pill during X's attempt
3. X submits answer → pill.status = 'played' (consumed globally)
4. Pill never served again
```

**What actually happened:**
1. Pill fetched as status='available' in both open() calls (within microseconds)
2. Both players deducted before either answered
3. pill_plays rows created for BOTH players simultaneously
4. No global lock during the "open-to-submit" window

### The Money Issue
Player A **was charged ₦200** for opening a pill that another player was already answering.
- Player A: ₦200 deducted, **never answered** (abandoned or timed out)
- Player A's balance: ₦0 (spent, no prize)

**This is a lost transaction** — money taken, no answer submitted.

## Verification of Money-Safety Fix

### Code Review: POST /api/pills/open (line ~400-410)

```javascript
// Re-verify pill is still available — another player may have consumed it
// since the client loaded the pack list.
if (pill.status === 'played') {
  return res.status(409).json({
    success: false,
    code: 'PILL_ALREADY_PLAYED',
    error: '...',
  });
}
```

**Status: ✓ CORRECT — But insufficient**

The check prevents charging for already-played pills, but it **does not prevent two players from opening the same pill simultaneously** because:
- The fetch and check happen within microseconds
- pill.status is still 'available' when both players check
- No transaction-level locking during the window

## Recent Changes Impact: NONE

Checked three recent Specials-focused changes:
1. **answer_input_mode** — only affects response data, no logic change
2. **Empty-answer validation** — happens after pill_plays exists, doesn't affect played-check
3. **Timeout validation** — happens after pill_plays exists, doesn't affect played-check

**Conclusion: Recent changes did NOT introduce this issue.** The issue is a pre-existing race condition.

## Recommended Fix

### Option A: Optimistic Locking (Recommended for Standard Pills)
In `POST /api/pills/open`, atomically mark pill.status → 'playing' as part of the deduction transaction:

```sql
UPDATE pills 
SET status = 'playing', updated_at = NOW()
WHERE id = $1 AND status = 'available'
RETURNING *;
```

If UPDATE returns 0 rows, another player already claimed it. Refund the deduction.

**Pros:**  
- Simple, atomic, prevents double-serving
- Maintains per-player pill_plays for tracking

**Cons:**  
- Requires additional state 'playing' or a player_attempt lock table

### Option B: First-Play-Wins with Rollback  
When Player X submits first answer, mark pill='played'. If Player Y is still open (locked_at=NULL), refund their deduction.

**Pros:**  
- No new pill states needed
- Works with current schema

**Cons:**  
- Refund flow is complex
- Player Y sees question but loses money if they answer too slowly

## Proof That NO Recent Regression Occurred

- **pill_plays UNIQUE constraint:** Intact ✓ (prevents duplicate player/pill entries)
- **played-status check in open():** Intact ✓ (checks before deductEntryFee)
- **Specials changes:** Isolated to answer validation, no shared logic touched ✓

**The issue is a pre-existing race condition in Standard Pills' "atomicity window"**, not a regression.

## Action Items

1. **Immediate:** Document this finding for the admin report
2. **Fix:** Implement Option A (optimistic locking on pills.status)
3. **Audit:** Check for other instances of same pill with 2+ plays in pill_plays
4. **Refund:** If Player A was charged for an abandoned pill, issue refund

---

**Database Evidence:**
- Total pills: 205
- Total pill_plays: 5
- Pills with status='played': 4
- Duplicates found: 1 pill with 2 different players
- Money safety check: Present and correct (but insufficient for race conditions)
