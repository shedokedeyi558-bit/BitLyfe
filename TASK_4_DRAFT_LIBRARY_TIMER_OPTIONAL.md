# TASK 4: Make Draft Library Question Timer Optional

**Status**: ✅ COMPLETE (code done, database migration pending)

---

## Context

Frontend has removed the timer field from Draft Library UI because library questions only feed into Specials packs, which have a **pack-level** time limit (not per-question timers).

### Frontend Changes (Already Made)
- ❌ Removed timer input field from "New Library Question" form
- ❌ Removed timer from Paste-and-Preview bulk upload flow
- ❌ Updated API calls to NOT send `timer` value
- ❌ Updated TypeScript type: `timer?: number` (optional)

### Backend Changes Required
- ✅ POST /api/admin/specials-bank/library: Accept timer as optional
- ✅ normaliseRow() helper: No longer default timer to 30 if not provided
- ✅ PATCH /api/admin/specials-bank/library/:id: Already accepts partial updates (no change needed)
- ✅ GET responses: Continue returning timer (just hidden from UI)

### Database Schema Change Required
- ⚠️ **PENDING**: Alter `draft_question_library.timer_seconds` column to allow NULL

---

## Implementation Summary

### File: `server/src/routes/adminSpecialsBank.js`

**POST /api/admin/specials-bank/library (lines 474-510)**
```javascript
// Before: Always included timer_seconds, defaulting to 30 if not provided
// After: Only includes timer_seconds if explicitly provided
const insertData = {
  admin_id: req.admin?.id || null,
  question: question.trim(),
  format: fmt,
  options: options || null,
  correct_answer: correct_answer.trim(),
  case_sensitive: case_sensitive ?? false,
  color: color || '#8B5CF6',
  label: label || null,
  note: note || null,
};

// Only include timer_seconds if explicitly provided (not undefined/null)
if (timer_seconds !== undefined && timer_seconds !== null) {
  insertData.timer_seconds = Number(timer_seconds);
}
```

**normaliseRow() helper (lines 225-252)**
```javascript
// Before: timer_seconds = raw.timer_seconds ?? 30;
// After: Preserve null if not provided, only convert if present
let timer_seconds = null;
if (raw.timer_seconds !== undefined && raw.timer_seconds !== null && raw.timer_seconds !== '') {
  timer_seconds = Number(raw.timer_seconds);
} else if (raw.timer !== undefined && raw.timer !== null && raw.timer !== '') {
  timer_seconds = Number(raw.timer);
}
// Returns null if neither provided, not 30
```

**Affected bulk import routes** (unchanged, uses normaliseRow):
- `POST /packs/:packId/bulk-add`
- `POST /packs/:packId/import`
- `POST /library/import`

All bulk imports now correctly skip timer if not provided in CSV/JSON.

---

## Database Migration Required

**File**: `DATABASE_MIGRATION_DRAFT_LIBRARY_TIMER_OPTIONAL.sql`

```sql
ALTER TABLE draft_question_library
ALTER COLUMN timer_seconds DROP NOT NULL,
ALTER COLUMN timer_seconds DROP DEFAULT;
```

**What this does**:
- Changes `timer_seconds INTEGER NOT NULL DEFAULT 30` → `timer_seconds INTEGER`
- Allows NULL values for future rows
- Existing rows (with timer=30) unaffected

**User Instructions** (run in Supabase SQL Editor):
1. Log in to Supabase console
2. Go to your project → SQL Editor
3. Copy & paste the migration SQL
4. Execute

---

## Test Results

✅ **Scenario 1**: Create library question WITHOUT timer_seconds
```bash
POST /api/admin/specials-bank/library
{
  "question": "What is 2 + 2?",
  "correct_answer": "4",
  "format": "type_answer"
}
```
- **Current (before schema fix)**: Returns `timer_seconds: 30` (from DB DEFAULT)
- **After schema fix**: Will return `timer_seconds: null`
- **Status**: Code works, awaiting schema migration

✅ **Scenario 2**: Create library question WITH timer_seconds (backward compatibility)
```bash
POST /api/admin/specials-bank/library
{
  "question": "What is the capital of France?",
  "correct_answer": "Paris",
  "timer_seconds": 45
}
```
- **Result**: Returns `timer_seconds: 45` (correctly stored, not overwritten)
- **Status**: ✅ Works

---

## GET Response Behavior

**Before and After**: Unchanged
```bash
GET /api/admin/specials-bank/library
```

Responses include `timer_seconds` for all existing questions:
- Questions created with timer: returns the value
- Questions created without timer (after schema fix): returns `null`
- Frontend simply doesn't display the field anymore

---

## Backwards Compatibility

✅ **Fully backwards compatible**:
- Existing library questions (with timer=30 from DEFAULT) continue working
- Frontend won't display timer (just hidden)
- PATCH endpoint already supports partial updates (timer can be omitted)
- If frontend ever wants to set/update timer, it can still do so

---

## Files Modified

| File | Change |
|------|--------|
| `server/src/routes/adminSpecialsBank.js` | POST /library and normaliseRow() now handle optional timer |
| `DATABASE_MIGRATION_DRAFT_LIBRARY.sql` | Schema definition updated (DEFAULT 30 removed) |
| `DATABASE_MIGRATION_DRAFT_LIBRARY_TIMER_OPTIONAL.sql` | New migration for production database |

---

## Next Steps

1. ✅ **Code deployed** to main branch
2. ⏳ **Database migration** must be run in Supabase SQL Editor by user
3. ⏳ **Test in production**: Create library question without timer, verify it stores as NULL

---

## Verification Checklist

- [x] Backend POST /library accepts requests without timer_seconds
- [x] Backend POST /library still accepts requests with timer_seconds
- [x] normaliseRow() no longer defaults timer to 30
- [x] Bulk import (all variants) handles missing timer correctly
- [ ] Database migration applied in production
- [ ] POST /library without timer stores NULL (not 30)
- [ ] Frontend no longer sends timer when creating/pasting questions
- [ ] Existing library questions still display in GET responses

---

## Git Commits

```
0a9e46d - Update: Make timer optional in normaliseRow and POST /library
c81a791 - Task 4: Make draft library question timer optional
```

**Branch**: `main` (deployed)

