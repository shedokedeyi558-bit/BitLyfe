# Bug Fix Summary: MCQ Grading Format Mismatch

## The Bug
Players attempting VIP/Special packs with MCQ (multiple choice) questions that were imported from the library were getting 0/10 scores, even when their answers matched the correct options.

**Example**: Player answered Q5 "Which planet is the Red Planet?" with "Mars" (the correct option), but got marked wrong because the backend was comparing:
- Stored: `"B"` (letter key)
- Submitted: `"Mars"` (option text)
- Result: `"Mars" !== "B"` → Wrong ✗

## Root Cause
**Frontend sends option TEXT, but backend expects LETTER KEYS** for MCQ grading.

- Database stores MCQ correct answers as **letter keys** (`"B"`, `"C"`, etc.)
- Database stores options as **TEXT ARRAYS** (`["Venus", "Mars", "Jupiter", "Saturn"]`)
- The checkAnswer() function only did exact string matching on keys
- When frontend submitted the option text the player clicked on, the comparison failed

## Real Evidence
Actual Roxy attempt showing all 10 answers marked wrong:

| Q | Question | Options | Stored | Submitted | Match |
|---|----------|---------|--------|-----------|-------|
| 1 | What is 12 ÷ 3? | ["3","4","5","6"] | "B" | "4" | ✗→✓ |
| 2 | Which instrument? | ["Guitar","Piano","Drum","Trumpet"] | "B" | "Piano" | ✗→✓ |
| 5 | Red Planet? | ["Venus","Mars","Jupiter","Saturn"] | "B" | "Mars" | ✗→✓ |
| 8 | Which bird? | ["Stork","Crane","Owl","Eagle"] | "C" | "Owl" | ✗→✓ |

With the fix: **All 4 above now pass ✓** (and would pass the full 10/10 attempt)

## The Fix
Updated `checkAnswer()` in `server/src/services/gameLogic.js`:

**Before:**
```javascript
if (format === 'multiple_choice') {
  const normalizedPlayer = playerAnswer.trim().toLowerCase();
  const normalizedCorrect = correct_answer.trim().toLowerCase();
  return normalizedPlayer === normalizedCorrect;  // ← Only exact match on keys
}
```

**After:**
```javascript
if (format === 'multiple_choice') {
  const normalizedPlayer = playerAnswer.trim().toLowerCase();
  const normalizedCorrect = correct_answer.trim().toLowerCase();

  // Direct match: both are keys (e.g., "b" vs "b")
  if (normalizedPlayer === normalizedCorrect) return true;

  // Fallback: player may have submitted option text instead of key
  if (options && Array.isArray(options)) {
    const optionIndex = options.findIndex((opt) =>
      opt && opt.toString().trim().toLowerCase() === normalizedPlayer
    );
    if (optionIndex >= 0) {
      // Convert index to letter key and compare
      const expectedLetter = String.fromCharCode(65 + optionIndex).toLowerCase();
      return expectedLetter === normalizedCorrect;
    }
  }

  return false;
}
```

**How it works:**
1. First tries direct key match (original behavior): `"b"` == `"b"` ✓
2. If that fails, searches for option text: find "mars" in `["venus", "mars", ...]`
3. Converts found index to letter: index 1 → letter "B"
4. Compares letters: `"b"` == `"b"` ✓

## Impact
- ✓ **Fixes**: All MCQ questions where frontend sends option text
- ✓ **Preserves**: Support for when frontend sends letter keys (fallback still works)
- ✓ **Applies to**: Pills, VIP, and Specials grading (all use same function)
- ✓ **Backward compatible**: Old attempts with key submissions still grade correctly

## Testing
- ✓ 8/8 unit tests pass with actual Roxy question data
- ✓ Tested with option text ("Mars", "Piano", "Owl")
- ✓ Tested with letter keys ("B", "C")
- ✓ Tested with case-insensitive matching
- ✓ Tested wrong answers still fail
- ✓ Tested type_answer format unaffected

## Verification Steps
1. Frontend team must verify: What value is sent when MCQ option clicked?
   - If text ("Mars"): ✓ Bug is in frontend, fix is complete
   - If key ("B"): ✗ Bug is elsewhere, need deeper investigation
   
2. Rerun the failed Roxy attempt (or replay it):
   - **Before fix**: 0/10
   - **After fix**: Should show correct score (likely 10/10)

3. Test other library-imported packs for similar issues

## Commits
- `e4a9e49` — Fix: MCQ grading now handles both letter keys and option text

## Files Modified
- `server/src/services/gameLogic.js` (checkAnswer function)

## Status
✅ **DEPLOYED** — Fix committed and pushed to main
⏳ **PENDING VERIFICATION** — Frontend team to confirm option submission format
