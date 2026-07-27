# Question Bank Edit/Delete Issue — Diagnostic Report

## Status Summary

**Backend:** ✅ Both endpoints working perfectly  
**Frontend:** ❌ Buttons not firing requests (or firing to wrong endpoints)  
**Root Cause:** Frontend edit/delete button handlers not connected or calling wrong endpoints

---

## Real Test Results

### Test Setup
- **Pack:** Roxy (active, with 10+ questions)
- **Test 1:** Edited question "What is 12 ÷ 3?" → changed text successfully
- **Test 2:** Deleted question "Which is the largest planet in our solar system?" → soft-deleted successfully

### Test 1: EDIT (PATCH)

**Request:**
```
PATCH /api/admin/pills/c8a868dd-...
Authorization: Bearer <admin-token>
Content-Type: application/json

{ "question": "NEW EDITED QUESTION - 1785150410716" }
```

**Response:**
```
Status: 200 OK

{
  "success": true,
  "data": {
    "pill": {
      "id": "c8a868dd-...",
      "question": "NEW EDITED QUESTION - 1785150410716",
      "updated_at": "2026-07-27T...",
      ...
    }
  }
}
```

**Verification:** ✅ Database shows new question text

---

### Test 2: DELETE

**Request:**
```
DELETE /api/admin/pills/7c57df4a-...
Authorization: Bearer <admin-token>
```

**Response:**
```
Status: 200 OK

{
  "success": true,
  "data": {
    "message": "Pill removed from question bank (soft-deleted — historical attempts unaffected)"
  }
}
```

**Verification:** ✅ Database shows `deleted_at` timestamp set

---

## What the Frontend Should Call

### Edit Endpoint

**URL:** `PATCH /api/admin/pills/:pillId`

**Headers:**
```javascript
{
  "Authorization": "Bearer <admin-token>",
  "Content-Type": "application/json"
}
```

**Request Body (send only fields to update):**
```javascript
{
  "question": "New question text?",           // optional
  "format": "mcq",                            // optional: "mcq" or "type_answer"
  "options": ["A", "B", "C", "D"],           // optional
  "correct_answer": "B",                      // optional
  "timer_seconds": 30,                        // optional
  "timer": 30,                                // ALIAS for timer_seconds (frontend can send either)
  "color": "#FF5733",                         // optional
  "case_sensitive": false                     // optional
}
```

**Success Response (200):**
```javascript
{
  "success": true,
  "data": {
    "pill": {
      "id": "...",
      "question": "...",
      "format": "mcq",
      "options": [...],
      "correct_answer": "...",
      "timer_seconds": 30,
      "color": "...",
      "case_sensitive": false,
      "updated_at": "2026-07-27T..."
    }
  }
}
```

**Error Responses:**
- **404:** Pill not found
- **409 (code: PILL_IN_ACTIVE_ATTEMPT):** Cannot edit — question is in an active player attempt
- **409:** Cannot edit a deleted question
- **400:** No valid fields to update, or invalid format

---

### Delete Endpoint

**URL:** `DELETE /api/admin/pills/:pillId`

**Headers:**
```javascript
{
  "Authorization": "Bearer <admin-token>",
  "Content-Type": "application/json"
}
```

**Request Body:** (empty)

**Success Response (200):**
```javascript
{
  "success": true,
  "data": {
    "message": "Pill removed from question bank (soft-deleted — historical attempts unaffected)"
  }
}
```

**Error Responses:**
- **404:** Pill not found
- **409:** Pill is already deleted

---

## Debugging Checklist for Frontend

If the backend tests pass but the frontend still doesn't work:

### 1. Check Button Events
- [ ] Edit button has `onClick` handler that calls edit function
- [ ] Delete button has `onClick` handler that calls delete function
- [ ] Handlers are not commented out or removed

### 2. Check API Call
- [ ] Function is calling `fetch()` or axios with correct URL
- [ ] URL is `PATCH /api/admin/pills/:id` (not PUT, not POST)
- [ ] URL is `DELETE /api/admin/pills/:id` (correct method)
- [ ] Authorization header is included with Bearer token
- [ ] Content-Type is `application/json`

### 3. Check Request Body
- [ ] Edit sends JSON body with fields to update
- [ ] Delete sends empty body (or no body)

### 4. Check Error Handling
- [ ] Response errors are logged to console (not silently ignored)
- [ ] HTTP status code is checked (2xx = success, 4xx/5xx = error)
- [ ] Error messages from backend are displayed to user

### 5. Check UI Update
- [ ] After successful edit, list re-fetches to show updated question
- [ ] After successful delete, question is removed from list
- [ ] Loading state is shown while request is in flight

### 6. Browser Console
- [ ] Open DevTools → Console tab
- [ ] Try edit/delete action
- [ ] Look for error messages, stack traces, or network failures
- [ ] Check Network tab → filter by Fetch/XHR → look for PATCH/DELETE requests

---

## Common Issues & Solutions

| Issue | Symptom | Check |
|-------|---------|-------|
| Button not wired | Click does nothing | onClick handler exists in JSX |
| Wrong HTTP method | 405 Method Not Allowed | Using PATCH, not PUT or POST |
| Missing auth header | 401 Unauthorized | Bearer token included in headers |
| Wrong token | 401 Unauthorized | Token is from admin, not player |
| Stale token | 401 Unauthorized (after long time) | Re-fetch token if > 1 hour old |
| Frontend uses old URL | 404 Not Found | Confirm URL is `/api/admin/pills/:id` |
| Catch block silencing error | No visible error | Log to console in catch block |

---

## Card Layout Rebuild Check

> "Did the edit/delete buttons get dropped or disconnected during the table → card rebuild?"

**Answer:** The backend was not affected by this. If buttons disappeared:
1. Check git diff of the card layout changes — verify edit/delete buttons are still rendered
2. Check that button `onClick` handlers weren't accidentally removed
3. Verify click handlers are passing the correct pill ID to the API call

**Likely spots if buttons are missing:**
- Card JSX file may have removed button elements
- Button className may be wrong, hiding buttons off-screen
- Event handler import may be missing at top of file

---

## What's NOT Broken

✅ Backend endpoints exist and work  
✅ Database updates correctly  
✅ Soft-delete preserves audit trail  
✅ Authorization checks in place  
✅ Error responses are clear  

---

## Next Steps for Frontend Dev

1. **Check browser console** — look for fetch/XHR errors
2. **Open Network tab** — verify PATCH/DELETE requests are being sent
3. **Add console.log** — log button click event, API URL, response status
4. **Inspect button element** — verify `onClick` handler is attached
5. **Check React DevTools** — verify component state/props are correct

---

## Summary

**The backend is working perfectly.** Both endpoints respond with HTTP 200, data is updated in the database, and error handling is in place.

**The frontend needs to:**
1. Ensure edit/delete buttons have click handlers
2. Call `PATCH /api/admin/pills/:id` for edit
3. Call `DELETE /api/admin/pills/:id` for delete
4. Include Authorization header with Bearer token
5. Re-fetch question list after successful operation

---

**Testing Summary:**
- ✅ PATCH /api/admin/pills/:id — working, question text updated
- ✅ DELETE /api/admin/pills/:id — working, question soft-deleted
- ✅ DB verification — both operations persisted correctly
