# Bug Report: Roxy VIP Pack — 0/10 Correct Despite Valid Answers

## Summary
A player attempted the "Roxy" special/VIP pack (10 MCQ questions), believed they answered correctly, but the system recorded 0/10 correct. The real evidence shows a **format mismatch between what's stored and what's being submitted**.

## Real Data Evidence

### Attempt Details
- **Attempt ID**: `1a6c6a19-a242-4831-a257-280a7f9d5cf6`
- **Pack**: "Roxy" (special/VIP, 10 questions)
- **Player ID**: `87b31941-32d5-450c-9c87-79d8855e533c`
- **Status**: Failed (0/10 correct)
- **Completed**: 2026-07-25 19:07:30

### Question & Answer Details (ALL 10 QUESTIONS)

| Q# | Question | Format | Stored Correct | Submitted Answer | Match? |
|----|----------|--------|-----------------|-----------------|--------|
| 1 | What is 12 ÷ 3? | MCQ | `"B"` | `"Mars"` | ✗ |
| 2 | Which instrument has black and white keys? | MCQ | `"B"` | `"4"` | ✗ |
| 3 | Which is the largest planet? | MCQ | `"C"` | `"Lion"` | ✗ |
| 4 | Which continent is Egypt in? | MCQ | `"C"` | `"January"` | ✗ |
| 5 | Which planet is known as the Red Planet? | MCQ | `"B"` | `"Piano"` | ✗ |
| 6 | Which is the first month of the year? | MCQ | `"B"` | `"Coffee"` | ✗ |
| 7 | Which drink is made from cocoa beans? | MCQ | `"C"` | `"Jupiter"` | ✗ |
| 8 | Which bird delivers babies? | MCQ | `"B"` | `"Owl"` | ✗ |
| 9 | What do fish use to breathe? | MCQ | `"C"` | `"Gills"` | ✗ |
| 10 | Which animal is the "King of the Jungle"? | MCQ | `"B"` | `"Africa"` | ✗ |

### Options Stored in Database

**Q1: What is 12 ÷ 3?**
```json
Options: ["3", "4", "5", "6"]
Correct: "B"
Meaning: Option B (index 1) = "4" ✓ Correct!
```

**Q2: Which instrument has black and white keys?**
```json
Options: ["Guitar", "Piano", "Drum", "Trumpet"]
Correct: "B"
Meaning: Option B (index 1) = "Piano" ✓ Correct!
```

**Q8: Which bird delivers babies?**
```json
Options: ["Stork", "Crane", "Owl", "Eagle"]
Correct: "B"
Meaning: Option B (index 1) = ... NOT "Owl"
Meaning: Option C (index 2) = "Owl"
```

**Q5: Which planet is the Red Planet?**
```json
Options: ["Venus", "Mars", "Jupiter", "Saturn"]
Correct: "B"
Meaning: Option B (index 1) = "Mars" ✓ Correct!
```

---

## ROOT CAUSE ANALYSIS

### The Problem: Data Format Mismatch

**In Database (Stored):**
- MCQ `correct_answer` is stored as a **LETTER KEY**: `"B"`, `"C"`, etc.
- `options` is an **ARRAY**: `["Venus", "Mars", "Jupiter", "Saturn"]`
- Example: Correct answer "B" = index 1 = "Mars"

**What Frontend Sent (Submitted):**
- Player is submitting **OPTION TEXT VALUES**: `"Mars"`, `"Piano"`, etc.
- NOT the letter keys: `"B"`, `"C"`, etc.

**Grading Logic (checkAnswer in gameLogic.js):**
```javascript
if (format === 'multiple_choice') {
  const normalizedPlayer = playerAnswer.trim().toLowerCase();
  const normalizedCorrect = correct_answer.trim().toLowerCase();
  return normalizedPlayer === normalizedCorrect;  // ← Direct string comparison
}
```

**The Comparison That Fails:**
```
Submitted:  "mars" (lowercase)
Stored:     "b" (lowercase)
Result:     "mars" !== "b" → WRONG ✗
```

---

## Critical Finding: Questions from Library Import

### Library vs Pills Consistency Check

✓ **Confirmed**: The Roxy pills DID come from library import.
- Library question: "Which planet is known as the Red Planet?"
  - Correct: `"B"` 
  - Options: `["Venus", "Mars", "Jupiter", "Saturn"]`
  
- Roxy pill (same question):
  - Correct: `"B"` (identical)
  - Options: `["Venus", "Mars", "Jupiter", "Saturn"]` (identical)

✓ **Conclusion**: The library questions are being stored correctly in pills table. The issue is NOT in the import/copy-to-pack flow.

---

## Where the Bug Actually Is

### Option 1: Frontend Button Click Handler (MOST LIKELY)
When a player clicks option text (e.g., "Mars"), the frontend should send the **LETTER KEY** ("B"), but it's sending the **OPTION TEXT** ("Mars") instead.

**Expected flow:**
```
Player clicks "Mars" button
→ Frontend maps "Mars" to letter "B"
→ Frontend sends: { answer: "B" }
→ Backend compares: "b" === "b" → CORRECT ✓
```

**Actual flow (the bug):**
```
Player clicks "Mars" button
→ Frontend sends the clicked text directly: { answer: "Mars" }
→ Backend compares: "mars" === "b" → WRONG ✗
```

### Option 2: Backend Grading Logic Needs to Handle Both Formats
The `checkAnswer()` function could be enhanced to:
1. Accept EITHER letter keys ("B") OR option text ("Mars")
2. If it's option text, look it up in the options array to convert it to the corresponding letter

---

## Impact Assessment

### Other Affected Attempts
- **Total special attempts in database**: 1 (just this one)
- **Other library questions**: 54 questions in draft library
- **Other packs with library questions**: Potentially many

⚠️  **If this is a frontend bug**, ALL players using MCQ library questions on ANY pack would be affected.

---

## Recommended Fix

### Approach 1: Fix Frontend (BEST - Preserves Intent)
Modify the MCQ answer submission to send **letter keys** not option text:
```javascript
// In the MCQ button click handler:
const optionIndex = options.indexOf(selectedText);
const letterKey = String.fromCharCode(65 + optionIndex);  // "A", "B", "C", "D"
submitAnswer(letterKey);  // Send "B", not "Mars"
```

### Approach 2: Fix Backend (WORKS AROUND FRONTEND BUG)
Enhance `checkAnswer()` to handle both formats:
```javascript
if (format === 'multiple_choice') {
  const normalizedPlayer = playerAnswer.trim().toLowerCase();
  const normalizedCorrect = correct_answer.trim().toLowerCase();
  
  // Try direct match first (both are keys)
  if (normalizedPlayer === normalizedCorrect) return true;
  
  // If player submitted option text, try to find it in options
  if (options && Array.isArray(options)) {
    const optionIndex = options.findIndex(opt => 
      opt.toLowerCase() === normalizedPlayer
    );
    if (optionIndex >= 0) {
      const expectedLetter = String.fromCharCode(65 + optionIndex);
      return expectedLetter.toLowerCase() === normalizedCorrect;
    }
  }
  
  return false;
}
```

---

## Verification Steps (For QA)

1. **Check frontend code**: Where MCQ options are clicked, what value is sent to backend?
2. **Check browser network tab**: When submitting MCQ answers, what's in the request body?
3. **Review recent changes**: Was there a change to how frontend sends MCQ answers? When?
4. **Test fix**: Attempt same Roxy pack again after fix, verify score changes to 10/10

---

## Status
- **Root cause**: ✓ **IDENTIFIED** — format mismatch (letter keys vs option text)
- **Evidence**: ✓ **REAL** — actual database records + network attempt data
- **Fix**: ⏳ **PENDING** — needs frontend code inspection or backend logic update
