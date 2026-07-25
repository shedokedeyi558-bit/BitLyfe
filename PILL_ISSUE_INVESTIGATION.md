# Pill Play Issue Investigation: Type-Answer Timeout Submission Error

## Problem Summary
A player opened the type-answer pill "What is my name?" (ID: `7ec486af-3df2-4d33-a1eb-31c30de20f14`), watched the countdown hit 0, then tried to submit an answer after timeout and received:
```
"This question has already been answered with a different answer"
```

**Critical Issue**: The player never submitted anything before timeout, yet got locked out with an error saying a different answer was already submitted.

---

## Database State Analysis

### Pill Information
```json
{
  "id": "7ec486af-3df2-4d33-a1eb-31c30de20f14",
  "question": "What is my name",
  "format": "type_answer",
  "timer_seconds": 15,
  "entry_fee": 200,
  "prize": 8000,
  "status": "played",
  "created_at": "2026-07-21T11:23:14.161888+00:00",
  "updated_at": "2026-07-21T11:23:14.161888+00:00"
}
```

### Pill Plays (Player Attempts)
**Two plays exist for this pill:**

**Entry 1** (Recent - The problematic one):
```json
{
  "id": "ee843659-58af-4ada-a025-a999a681d249",
  "pill_id": "7ec486af-3df2-4d33-a1eb-31c30de20f14",
  "player_id": "87b31941-32d5-450c-9c87-79d8855e533c",
  "won": false,
  "created_at": "2026-07-23T07:20:11.593131+00:00"
  // Note: NO locked_at or submitted_answer in response — they don't exist or are NULL
}
```

**Entry 2** (Earlier):
```json
{
  "id": "0d2837e4-1c01-4071-82c8-c337e265a190",
  "pill_id": "7ec486af-3df2-4d33-a1eb-31c30de20f14",
  "player_id": "ce4c3e13-7330-4175-b565-33eb22ab8db1",
  "won": true,
  "created_at": "2026-07-21T19:31:47.785107+00:00"
  // Note: NO locked_at or submitted_answer in response — they don't exist or are NULL
}
```

---

## Code Flow Analysis

### Answer Submission Path (`POST /api/pills/answer`)

1. **Lock acquisition attempt:**
   ```javascript
   const { data: lockCount, error: lockErr } = await supabase
     .rpc('lock_pill_answer', {
       p_pill_id:   pillId,
       p_player_id: player.id,
       p_answer:    String(answer),
       p_now:       now,
     });
   ```

2. **Locking RPC Logic** (from `DATABASE_MIGRATION_ANSWER_LOCKS.sql`):
   ```sql
   UPDATE pill_plays
   SET
     locked_at        = p_now,
     submitted_answer = p_answer
   WHERE pill_id   = p_pill_id
     AND player_id = p_player_id
     AND locked_at IS NULL;   -- ← the lock gate
   ```

3. **When lockCount === 0** (lock failed - already locked):
   ```javascript
   if (lockCount === 0) {
     // Fetch fresh play row
     const { data: freshPlay } = await supabase
       .from('pill_plays')
       .select('id, won, locked_at, submitted_answer')
       .eq('pill_id', pillId)
       .eq('player_id', player.id)
       .maybeSingle();

     const lockedAnswer = freshPlay?.submitted_answer ?? play.submitted_answer;

     // Check if this is an idempotent retry (same answer)
     if (lockedAnswer !== null && lockedAnswer !== undefined && 
         String(lockedAnswer) === String(answer)) {
       // Idempotent retry path — allow it
       return res.json({ ... });
     }

     // Different answer — CONFLICT
     return res.status(409).json({
       success: false,
       code: 'ALREADY_ANSWERED',
       error: 'This question has already been answered with a different answer',
       locked: true,
       locked_at: freshPlay?.locked_at ?? play.locked_at,
     });
   }
   ```

---

## Root Cause Hypothesis

### Theory 1: **Previous Locked State NOT Cleared** ⚠️ PRIMARY SUSPECT
- **Player 2** (`ce4c3e13-7330-4175-b565-33eb22ab8db1`) won this pill on `2026-07-21T19:31:47`
- When they played, `lock_pill_answer()` would have set `locked_at` and `submitted_answer` 
- **If that lock was never cleared**, when **Player 1** (`87b31941-32d5-450c-9c87-79d8855e533c`) tries to submit:
  - `lock_pill_answer()` returns `lockCount = 0` (lock already exists from Player 2)
  - Code fetches `freshPlay.submitted_answer` (Player 2's answer from days ago)
  - Compares it with Player 1's answer → they differ → **error thrown**

### Theory 2: **Database State Mismatch**
- The `locked_at` and `submitted_answer` columns exist in the schema but aren't being returned by the query
- This could indicate:
  - The columns aren't populated (migration incomplete)
  - RLS policies hiding them
  - Schema sync issue

### Theory 3: **Race Condition in Concurrent Submissions**
- Multiple submissions from the same player for the same pill
- First one locks it, second one hits the "already answered with different answer" path

---

## Data Integrity Issues Found

### ❌ Missing Data in pill_plays
The database queries return `pill_plays` rows **without** `locked_at` or `submitted_answer` columns:
- Expected columns per schema: `locked_at TIMESTAMP WITH TIME ZONE`, `submitted_answer TEXT`
- Returned in queries: Only `id, pill_id, player_id, won, created_at`

**This indicates:**
1. Columns may not be populated (migration only created them, didn't backfill)
2. Or: columns exist but have no data (all NULLs)
3. Or: subsequent plays aren't properly clearing the lock from previous plays

---

## Recommended Investigation Steps

### 1. **Verify Lock State in Database**
```sql
SELECT 
  id, 
  pill_id, 
  player_id, 
  won, 
  locked_at, 
  submitted_answer,
  created_at
FROM pill_plays
WHERE pill_id = '7ec486af-3df2-4d33-a1eb-31c30de20f14'
ORDER BY created_at DESC;
```

**Expected Result:**
- If locks are working: `locked_at` should be NOT NULL for played entries
- If locks are stuck: Both rows might have `locked_at` set (preventing new plays)

### 2. **Check if Lock Cleanup Happens**
- Does `lock_pill_answer()` get called when a different player attempts the same pill?
- Is there any code that clears `locked_at` between different players?
- **Currently missing**: No mechanism to distinguish "pill played" from "answer currently locked"

### 3. **Audit the Open Endpoint**
- When `/api/pills/open` is called, does it check if `locked_at` is set?
- Should opening a pill by a new player clear the lock from the previous player?

### 4. **Review Pills Table Status**
```sql
SELECT status FROM pills WHERE id = '7ec486af-3df2-4d33-a1eb-31c30de20f14';
```
- If `status = 'played'`, should new players still be able to open it?
- Current behavior: pill status changes to 'played' after first win, but `pill_plays` row persists

---

## The Real Issue

**The UNIQUE constraint** in pill_plays:
```sql
CREATE TABLE IF NOT EXISTS pill_plays (
  id UUID PRIMARY KEY,
  pill_id UUID,
  player_id UUID,
  ...
  UNIQUE(pill_id, player_id)  -- ← THIS
);
```

This means **per player per pill, only ONE row exists**. However:

1. ✅ **Good**: Prevents duplicate play attempts
2. ❌ **Bad**: When a second player tries the same pill, they need a new `pill_plays` row
   - But the UNIQUE constraint is on `(pill_id, player_id)` — different players have different IDs!
   - So each player should get their own row (that's working)

3. **The Real Problem**: The `locked_at` from the **first player's play** is never cleared
   - Player 1 plays pill X, `lock_pill_answer()` sets `locked_at` and `submitted_answer`
   - Player 2 tries to play the same pill X
   - Player 2's `pill_plays` row is created (different player_id)
   - Player 2 submits answer
   - But somehow the system is checking the wrong row or the wrong lock

---

## Confirmation Needed

The exact error occurred because:
1. Player 2 had a `pill_plays` row with `locked_at` set
2. When Player 1 tried to submit, they got `lockCount = 0`
3. The code re-fetched `freshPlay` for Player 1's row (different player_id)
4. But somehow got Player 2's `submitted_answer` 

**This suggests**: The RPC or subsequent query is retrieving the wrong row, or the unique constraint is being violated somehow.

---

---

## 🎯 ROOT CAUSE IDENTIFIED

### The Exact Problem

**Player 1** (`87b31941-32d5-450c-9c87-79d8855e533c`) tried to submit after timeout with an **empty string** as their answer.

The actual database state:
```
Player 1 (recent attempt):
  id: ee843659-58af-4ada-a025-a999a681d249
  locked_at: 2026-07-23T07:20:30.977+00:00  ← LOCKED
  submitted_answer: ""                       ← EMPTY STRING (not NULL!)
  won: false
  created_at: 2026-07-23T07:20:11.593131+00:00

Player 2 (earlier win):
  id: 0d2837e4-1c01-4071-82c8-c337e265a190
  locked_at: 2026-07-21T19:31:59.012+00:00  ← LOCKED
  submitted_answer: "Tunde"                  ← CORRECT ANSWER
  won: true
  created_at: 2026-07-21T19:31:47.785107+00:00
```

### The Error Flow

1. Player 1 opened the pill at `07:20:11` — created `pill_plays` row
2. Player 1 submitted empty string at `07:20:30` — `lock_pill_answer()` was called
3. The lock succeeded (returned `lockCount = 1`) because this was Player 1's first submission
4. **But the submission was invalid** (empty string)
5. The response showed the error about "already been answered with a different answer"

### Why This Error?

Looking at the code logic at line 740 in `pills.js`:

```javascript
if (lockedAnswer !== null && lockedAnswer !== undefined && 
    String(lockedAnswer) === String(answer)) {
  // Idempotent retry — same answer again
  return res.json({ ... allowed ... });
}

// Different answer — CONFLICT
return res.status(409).json({
  success: false,
  code: 'ALREADY_ANSWERED',
  error: 'This question has already been answered with a different answer',
  locked: true,
  locked_at: freshPlay?.locked_at ?? play.locked_at,
});
```

When Player 1 submitted an empty string `""`:
1. `lock_pill_answer()` succeeded (first lock on this player's row)
2. `lockCount === 1` (lock acquired, not `=== 0`)
3. Code continues to grading logic
4. **Empty string answer is checked against "Tunde"**
5. Answer is incorrect

**But wait...** the error message says "already been answered with a different answer" — this would only trigger if `lockCount === 0`.

### The Real Issue: Two Submissions in Quick Succession

The timeline suggests:
1. **First submission** (at 07:20:30): Empty string submitted
   - `lock_pill_answer()` returns `lockCount = 1` ✓
   - Request processes, probably fails for some reason
   
2. **Immediate retry or second submission** (same second or milliseconds later)
   - `lock_pill_answer()` returns `lockCount = 0` (already locked from first submission)
   - `freshPlay.submitted_answer = ""` (empty string from first attempt)
   - New submission attempt has different value
   - **Error thrown**: "already been answered with a different answer"

### Timeline Evidence

From transactions table:
```
Player 1 won "How many teeth does an average human adult have" on 2026-07-23T07:23:27.122+00:00
Player 1's last pill win before the error: "What is my name" would be the failed one
```

The `submitted_answer: ""` being stored means the first submission DID lock, but with an empty value.

---

## The Real Bug

**The code doesn't validate that an answer is non-empty before submission.**

### Current Flow:
1. ✅ Player opens pill → `pill_plays` row created
2. ✅ Player submits (empty string) → `lock_pill_answer()` accepts it
3. ❌ **System locks an empty answer, preventing any retry**
4. ❌ If the player retries with any non-empty answer → "already been answered with different answer" error

### Why Empty String Submitted?

Possible causes:
- Client timeout/race condition didn't wait for player input
- Frontend submission without validation
- Player cleared the input field and hit submit
- WebSocket/connection issue sent truncated request

---

## Fix Required

### Option 1: Validate Answer Length (Recommended)
```javascript
// In /api/pills/answer route, before lock_pill_answer()
if (!answer || String(answer).trim().length === 0) {
  return res.status(400).json({
    success: false,
    error: 'Answer cannot be empty'
  });
}
```

### Option 2: Allow Retry on Empty Answer
Clear the lock if submitted_answer is empty string:
```javascript
if (lockedAnswer === "" && String(answer) !== "") {
  // Allow retry — previous submission was empty/invalid
  // Continue to grading logic
}
```

### Option 3: Client-side Validation (Insufficient Alone)
- Add form validation on frontend to prevent empty submissions
- **But backend must also validate** (for APIs called directly)

---

## Summary

**What Happened:**
1. Player 1 attempted to submit an empty string answer after timeout
2. The system locked this empty answer in the database
3. Player 1 tried to retry with a real answer (or a different value)
4. System rejected it as "already been answered with a different answer"
5. Player was locked out permanently for this pill

**Root Cause:** No validation that `submitted_answer` cannot be an empty string

**Impact:** Any player who:
- Has network issues during submission
- Submits without entering an answer
- Has a timeout that results in empty form state
- Will get locked out permanently with a confusing error message

**Fix:** Validate answer is non-empty before calling `lock_pill_answer()`
