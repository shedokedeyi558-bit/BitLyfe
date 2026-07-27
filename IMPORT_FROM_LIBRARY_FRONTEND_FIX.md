# Import from Library — Frontend Integration Fix

## Status

**Backend Endpoint:** ✅ **EXISTS and FULLY FUNCTIONAL**  
**Path:** `POST /api/admin/specials-bank/library/copy-to-pack`  
**Action Needed:** Frontend URL fix only — no backend endpoint build required

---

## What Was Broken

Frontend's "Import from Library" button was calling a **nonexistent URL**, causing import to fail silently or show errors.

**What it was probably calling:**
```javascript
POST /api/admin/specials-bank/packs/:packId/import-from-library
```
❌ This endpoint does NOT exist.

**What it SHOULD call:**
```javascript
POST /api/admin/specials-bank/library/copy-to-pack
```
✅ This endpoint exists and works perfectly.

---

## Endpoint Details

### URL
```
POST /api/admin/specials-bank/library/copy-to-pack
```

### Headers
```javascript
{
  "Authorization": "Bearer <admin-token>",
  "Content-Type": "application/json"
}
```

### Request Body

```javascript
{
  "question_ids": ["uuid-1", "uuid-2", "uuid-3"],  // array of draft library question IDs to copy
  "pack_id": "target-pack-uuid"                     // UUID of the Specials pack to copy INTO
}
```

**Example:**
```javascript
{
  "question_ids": [
    "76c76177-a1b2-4c3d-8e9f-0123456789ab",
    "f7a5e63e-b2c3-4d5e-9f0a-1234567890bc",
    "9b28c2eb-c3d4-5e6f-0a1b-234567890cde"
  ],
  "pack_id": "ad7ae447-1234-5678-9abc-def0123456789"
}
```

### Success Response (201)

```javascript
{
  "success": true,
  "data": {
    "copied": 3,                    // number of questions actually copied
    "pack_id": "ad7ae447-...",      // target pack ID (echoed back)
    "questions": [
      {
        "id": "new-pill-id-1",
        "pack_id": "ad7ae447-...",
        "question": "Which animal is known as the King of the Jungle?",
        "format": "mcq",
        "options": ["Lion", "Tiger", "Elephant", "Bear"],
        "correct_answer": "Lion",
        "case_sensitive": false,
        "color": "#8B5CF6",
        "entry_fee": 50,
        "prize": 100,
        "status": "available",
        "times_answered": 0,
        "times_correct": 0,
        "created_at": "2026-07-27T...",
        ...
      },
      // ... more questions
    ]
  }
}
```

### Error Responses

| Status | Code | Reason | Message |
|--------|------|--------|---------|
| 400 | — | Missing pack_id | `"pack_id is required"` |
| 400 | — | Missing/invalid question_ids | `"question_ids must be a non-empty array"` |
| 404 | — | Pack not found | `"Pack not found"` |
| 404 | — | No valid library questions | `"No matching non-deleted library questions found"` |
| 409 | NOT_SPECIAL_PACK | Pack is not a Specials pack | `"Pack is not a Specials pack"` |
| 500 | — | Database error | `"Copy failed: ..."` |

---

## Test Results (Confirmed Working)

**Test Scenario:**
- Target pack: "Roxy" (active Specials pack)
- Source: 3 draft library questions
- Action: Copy all 3 into Roxy's bank

**Results:**
```
✅ Status: 201 Created
✅ Copied: 3 questions
✅ Pack DB shows: 51 → 54 questions (+3)
✅ Copied questions appear in pack's bank with correct content
```

---

## What Frontend Should Do

### 1. Update Import Button Click Handler

**Before (broken):**
```javascript
// DON'T do this:
const importSelectedQuestions = async (selectedIds, packId) => {
  const res = await fetch(
    `/api/admin/specials-bank/packs/${packId}/import-from-library`,  // ❌ WRONG URL
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ ids: selectedIds })  // ❌ WRONG field names
    }
  );
};
```

**After (fixed):**
```javascript
// DO this instead:
const importSelectedQuestions = async (selectedIds, packId) => {
  const res = await fetch(
    '/api/admin/specials-bank/library/copy-to-pack',  // ✅ CORRECT URL
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        question_ids: selectedIds,  // ✅ CORRECT field name
        pack_id: packId              // ✅ CORRECT field name
      })
    }
  );

  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Import failed');
  }

  const result = await res.json();
  return result.data.questions;  // Returns the newly created pill rows
};
```

### 2. Update UI After Successful Import

```javascript
try {
  const newQuestions = await importSelectedQuestions(selectedIds, packId);
  
  // UI updates needed:
  // 1. Show success toast: "Imported 3 questions successfully"
  // 2. Refresh the pack's question bank list (re-fetch pills)
  // 3. Clear the selection checkboxes
  // 4. Close the import dialog
  
  // Refresh question list:
  const { data: updatedQuestions } = await supabase
    .from('pills')
    .select('*')
    .eq('pack_id', packId)
    .is('deleted_at', null);
  
  setQuestionsInBank(updatedQuestions);
  setSelectedLibraryQuestions([]);
  closeImportDialog();
  showToast('success', `Imported ${newQuestions.length} questions`);
  
} catch (error) {
  showToast('error', error.message);
}
```

### 3. No Changes Needed For:

- ✅ Authorization header (Bearer token)
- ✅ Selection UI (checkboxes, multi-select)
- ✅ Library question list display
- ✅ Pack selector

---

## Why This URL, Not a New One?

The existing endpoint was built specifically for this use case:
- Takes draft library question IDs
- Copies them into a target Specials pack
- Returns the newly created pills in the pack
- Preserves library originals (no consumption)
- Allows copying same drafts to multiple packs

There's no functional reason to build a new endpoint — this one handles it perfectly.

**Decision:** Reuse existing endpoint. Zero backend work needed.

---

## Integration Checklist

- [ ] Update import button click handler to call correct URL
- [ ] Change request body to use `question_ids` (not `ids`)
- [ ] Change request body to use `pack_id` in body (not URL param)
- [ ] Add error handling for 400, 404, 409 responses
- [ ] Refresh question bank list after successful import
- [ ] Clear selection after import completes
- [ ] Close import dialog
- [ ] Show success toast with number of imported questions
- [ ] Test with real library questions on real pack
- [ ] Verify newly imported questions appear in pack's bank

---

## Quick Reference

| Item | Value |
|------|-------|
| **Method** | `POST` |
| **URL** | `/api/admin/specials-bank/library/copy-to-pack` |
| **Auth Header** | `Bearer <admin-token>` |
| **Body.question_ids** | `string[]` — draft question UUIDs |
| **Body.pack_id** | `string` — target pack UUID |
| **Success Status** | 201 |
| **Backend Status** | ✅ Works perfectly |
| **Action Needed** | Frontend URL + payload update only |

---

## Summary

The backend endpoint exists and works. The frontend just needs to:
1. Change URL from `POST /api/admin/specials-bank/packs/:packId/import-from-library` to `POST /api/admin/specials-bank/library/copy-to-pack`
2. Change request body from `{ ids: [...] }` to `{ question_ids: [...], pack_id: "..." }`
3. That's it — no backend changes needed.

**Commit this fix and the import feature will work end-to-end.**
