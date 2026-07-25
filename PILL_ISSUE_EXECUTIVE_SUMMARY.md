# Executive Summary: Type-Answer Pill Submission Bug

## Problem Statement
Player encountered error **"This question has already been answered with a different answer"** after watching the countdown hit 0 on a type-answer pill, even though they never successfully submitted anything.

---

## Root Cause
**Empty string answer was submitted and locked into the database**, preventing any subsequent submission attempts.

### Data Evidence
```
Pill: "What is my name" (ID: 7ec486af-3df2-4d33-a1eb-31c30de20f14)

Player 1's attempt:
- Opened: 2026-07-23T07:20:11.593131+00:00
- Submitted: "" (empty string)
- Locked at: 2026-07-23T07:20:30.977+00:00
- Won: false
- Error on retry: "already answered with different answer"

Player 2 (earlier):
- Submitted: "Tunde" (correct answer)
- Won: true
```

---

## What Happened

### Timeline
1. **Player opened pill** → `pill_plays` row created, timer started (15 seconds)
2. **Player waited for timeout** → Countdown reached 0
3. **Player attempted submission** (or form auto-submitted with empty value) → Empty string `""` locked
4. **Player tried to retry or submit again** → New answer rejected with error
5. **Player permanently locked out** for this pill

### Why the Confusing Error Message?

When `lock_pill_answer()` returns `lockCount = 0` (meaning already locked):
```javascript
const lockedAnswer = freshPlay?.submitted_answer ?? play.submitted_answer;

if (lockedAnswer !== null && lockedAnswer !== undefined && 
    String(lockedAnswer) === String(answer)) {
  // Same answer — idempotent retry allowed
} else {
  // Different answer — error!
  return res.status(409).json({
    error: 'This question has already been answered with a different answer'
  });
}
```

- First submission: `lockedAnswer = ""`
- Second submission: `answer = "myname"` (or any non-empty value)
- Comparison: `"" !== "myname"` → **Error thrown**

---

## The Bug

### Missing Validation
The code at line 627 of `pills.js` does **NOT** validate that the answer is non-empty:

```javascript
// Current code (NO validation)
const { data: lockCount, error: lockErr } = await supabase
  .rpc('lock_pill_answer', {
    p_pill_id:   pillId,
    p_player_id: player.id,
    p_answer:    String(answer),  ← Empty string allowed!
    p_now:       now,
  });
```

### Scenarios That Trigger This Bug

1. **Network timeout** → Form submitted with empty state
2. **Client-side error** → Input field not populated before submission
3. **Race condition** → Timer expired before form validation
4. **Direct API call** → No frontend validation
5. **Browser issue** → Form cleared unintentionally

---

## Impact
- **High severity**: Player permanently locked out with cryptic error
- **No self-service recovery**: Cannot retry or override
- **Support required**: Only admin can unlock by deleting/updating `pill_plays` row
- **User experience**: Appears as if system is broken or unfair

---

## Fix Required

### Minimum Fix (Recommended)
Add validation before locking:

```javascript
// In /api/pills/answer route (lines 620-630 area)
if (!answer || String(answer).trim().length === 0) {
  return res.status(400).json({
    success: false,
    code: 'EMPTY_ANSWER',
    error: 'Please enter an answer before submitting'
  });
}
```

### Also Recommended: Enhanced Error Message
Update the "already answered" error to be less confusing:

```javascript
return res.status(409).json({
  success: false,
  code: 'ALREADY_ANSWERED',
  error: lockedAnswer === '' 
    ? 'Your previous submission was incomplete. Contact support to retry.'
    : 'This question has already been answered with a different answer',
  locked: true,
  locked_at: freshPlay?.locked_at ?? play.locked_at,
});
```

---

## Affected Code Locations

### Primary Issue
- **File**: `server/src/routes/pills.js`
- **Line**: ~630 (POST /api/pills/answer endpoint)
- **Function**: Answer submission handler

### Related Files (Need Review)
- `server/src/routes/pillsVip.js` (VIP pills answer submission)
- `server/src/routes/pillsSpecial.js` (Special exam-style pills)
- Check if they have the same vulnerability

---

## Testing Required After Fix

### Test Case 1: Empty String Validation
```
1. Open any type_answer pill
2. Try to submit empty string directly (via API or form)
3. Expected: 400 Bad Request with "Please enter an answer" message
4. Actual: Should NOT lock the answer
```

### Test Case 2: Valid Submission After Empty Attempt (if empty was somehow locked)
```
1. Manually reset pill_plays.submitted_answer to NULL
2. Try submitting a valid answer
3. Expected: Should succeed
```

### Test Case 3: VIP & Special Pill Paths
```
1. Test same scenario on VIP pills
2. Test same scenario on Special (exam-style) pills
3. Verify they have empty-answer validation
```

---

## Database Cleanup

If other players are affected, you can identify them with:

```sql
SELECT id, pill_id, player_id, locked_at, submitted_answer, won, created_at
FROM pill_plays
WHERE submitted_answer = '' 
  AND locked_at IS NOT NULL
  AND won = false
ORDER BY created_at DESC;
```

To unlock a player:
```sql
UPDATE pill_plays
SET submitted_answer = NULL, locked_at = NULL
WHERE id = 'PLAY_ID_HERE';
```

---

## Files Attached

1. **PILL_ISSUE_INVESTIGATION.md** - Detailed technical analysis
2. **query_pill_issue.js** - Query script used for investigation
3. **deep_pill_analysis.js** - Deep analysis script with lock state details
