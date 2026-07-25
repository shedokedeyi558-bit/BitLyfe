# TASK 4 FINAL: Complete Removal of Per-Question Timer from Draft Library

**Status**: ✅ COMPLETE (code done, database migration pending)

---

## Summary

Timer per question has been **completely removed** from the draft library. The library now only stores question templates—timers are not needed at this level since Specials packs handle timing at the pack level via `quiz_expires_at`.

---

## Changes Made

### Backend Code (`server/src/routes/adminSpecialsBank.js`)

1. **normaliseRow() helper**: Removed all timer handling
   - No longer reads or processes `timer_seconds` or `timer` fields
   - Removed from return object

2. **GET /api/admin/specials-bank/library**: Removed timer from SELECT
   - Now selects: `id, question, format, options, correct_answer, case_sensitive, color, label, note, created_at, updated_at`
   - Timer no longer returned in responses

3. **POST /api/admin/specials-bank/library**: Removed timer parameter and handling
   - No longer accepts or processes timer
   - Only stores: question, format, options, correct_answer, case_sensitive, color, label, note

4. **PATCH /api/admin/specials-bank/library/:id**: Removed timer from updates
   - Can no longer update timer field (field doesn't exist anymore)

5. **POST /api/admin/specials-bank/library/import**: Removed timer from bulk imports
   - CSV/JSON columns no longer include timer
   - normaliseRow() doesn't process it

6. **POST /api/admin/specials-bank/library/copy-to-pack**: Removed timer from copy logic
   - When copying from library to pack: explicitly does NOT copy timer
   - Pack uses pack-level `quiz_expires_at` for time control

### Database Schema (`DATABASE_MIGRATION_DRAFT_LIBRARY.sql`)

- Removed `timer_seconds  INTEGER,` column definition

### Database Migration (`DATABASE_MIGRATION_DRAFT_LIBRARY_TIMER_OPTIONAL.sql` - renamed)

Now contains:
```sql
ALTER TABLE draft_question_library
DROP COLUMN IF EXISTS timer_seconds;
```

---

## What This Means

| Aspect | Before | After |
|--------|--------|-------|
| Library stores timer? | Yes (default 30) | ❌ No |
| POST /library accepts timer? | Yes (optional) | ❌ No |
| GET /library returns timer? | Yes | ❌ No |
| Existing library questions affected? | Still have timer=30 | ✅ Cleared by migration |
| Pack-level time control | quiz_expires_at | ✅ Still works (only mechanism) |

---

## Production Deployment Steps

### Step 1: Deploy Code
✅ Already pushed to main branch

Commits:
- `440c9f4` - Remove timer_seconds column from draft_question_library
- `31540f7` - Add TASK 4 documentation
- `0a9e46d` - Update: Make timer optional in normaliseRow and POST /library

### Step 2: Run Database Migration (Required)

**In Supabase SQL Editor**, execute:

```sql
ALTER TABLE draft_question_library
DROP COLUMN IF EXISTS timer_seconds;
```

This will:
- ✅ Remove the column from the table
- ✅ Idempotent (IF EXISTS clause prevents errors if already dropped)
- ✅ All existing row data cleaned up

---

## Verification Checklist

**After code deployment:**
- [x] Server starts without errors
- [x] GET /library doesn't include timer_seconds in responses
- [x] POST /library doesn't accept timer field
- [x] PATCH /library doesn't accept timer field
- [x] Bulk import doesn't process timer

**After database migration:**
- [ ] Column successfully dropped in Supabase
- [ ] POST /library without timer works
- [ ] GET /library returns questions without timer field
- [ ] Existing questions no longer have timer_seconds

---

## Impact Analysis

### What Still Works
- ✅ Draft library CRUD (all operations)
- ✅ Bulk import/export questions
- ✅ Copying questions to Specials packs
- ✅ Specials pack time limits (quiz_expires_at)
- ✅ All other backend functionality

### What Changed
- ❌ Draft library no longer stores per-question timers
- ❌ API no longer accepts/returns timer_seconds
- ❌ CSV/JSON imports can't include timer column (ignored if present)

### What This Enables
- ✅ Simpler, cleaner data model
- ✅ Frontend removes timer UI from library forms
- ✅ No confusion between pack-level vs question-level timing
- ✅ Eliminates redundant/unused field

---

## Technical Details

### Why Remove Completely?

1. **Library is just a template store** - questions don't execute here
2. **Timing is at the pack level** - all questions in a pack use the same `quiz_expires_at`
3. **Complexity without value** - per-question timer never actually used
4. **Schema clarity** - reduces cognitive load on data model

### Copy-to-Pack Behavior

When copying library questions to a Specials pack:
- Questions transferred WITHOUT any timer field
- Pack's `quiz_expires_at` applies to all questions in that pack
- No timer inheritance or conflicts

---

## Git History

```
440c9f4 - Remove timer_seconds column from draft_question_library
31540f7 - Add TASK 4 documentation and clean up test file
0a9e46d - Update: Make timer optional in normaliseRow and POST /library
c81a791 - Task 4: Make draft library question timer optional
```

**Branch**: `main` (deployed)

---

## Next Task

Once database migration is run in production, the draft library is fully clean and ready for use with no per-question timers.

