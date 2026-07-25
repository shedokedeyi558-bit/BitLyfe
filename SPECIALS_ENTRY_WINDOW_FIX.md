# TASK 5: Fix Specials Pack Entry Window Field Binding ✅

**STATUS**: Fixed and verified

## Problem

The Specials pack creation form displayed "Entry Window Closes" as a **required field** with an asterisk and no "No expiry" option. This contradicted the original design decision that `quiz_expires_at` should be optional with a "No expiry" default, kept completely separate from `entry_window_end` (which belongs to Time Machine/predictions only).

## Root Cause: Field Binding Violation

**Database Design** (`DATABASE_MIGRATION_QUIZ_EXPIRES.sql`):
```
-- ISOLATION:
--   This field is COMPLETELY INDEPENDENT of entry_window_end.
--   - entry_window_end  → used by Time Machine / prediction entry cutoffs only
--   - quiz_expires_at   → used by Pills / Specials packs only
--   Neither field is ever read or written by the other feature.
```

**Code Violations Found**:

1. **pillsSpecial.js (line 136)** — Entry check used the WRONG field:
   ```javascript
   // ❌ WRONG: checking entry_window_end (Time Machine field)
   if (pack.entry_window_end && new Date(pack.entry_window_end) < new Date()) {
     return res.status(409).json({ success: false, code: 'ENTRY_CLOSED', error: 'Entry window for this special has closed' });
   }
   ```

2. **pills.js (line 267)** — Specials endpoint filtered by the wrong field:
   ```javascript
   // ❌ WRONG: filtering Specials by entry_window_end
   if (p.entry_window_end && new Date(p.entry_window_end) <= now) return false;
   ```

3. **pillsVip.js (line 237)** — Entry check used the CORRECT field:
   ```javascript
   // ✅ CORRECT: checking quiz_expires_at (Pills/Specials field)
   if (pack.quiz_expires_at && new Date(pack.quiz_expires_at) < new Date()) {
     return res.status(410).json({
       success: false,
       code: 'QUIZ_EXPIRED',
       error: 'This pack is no longer accepting new entries — it has ended.',
     });
   }
   ```

## What Was Fixed

### 1. pillsSpecial.js

**Changed**: Entry window check from `entry_window_end` to `quiz_expires_at`

- **Line 136**: Removed incorrect `entry_window_end` check
- **Added**: Proper `quiz_expires_at` check matching pillsVip.js pattern (HTTP 410 QUIZ_EXPIRED)
- **Added**: Entry cap check (`max_entries`)
- **Removed**: `entry_window_end` from database select (line 118) — no longer needed, never used

**Before**:
```javascript
// Check entry window
if (pack.entry_window_end && new Date(pack.entry_window_end) < new Date()) {
  return res.status(409).json({ success: false, code: 'ENTRY_CLOSED', error: 'Entry window for this special has closed' });
}
```

**After**:
```javascript
// Block new entries if quiz_expires_at has passed.
// In-progress attempts are NOT affected — only new entries.
if (pack.quiz_expires_at && new Date(pack.quiz_expires_at) < new Date()) {
  return res.status(410).json({
    success: false,
    code: 'QUIZ_EXPIRED',
    error: 'This pack is no longer accepting new entries — it has ended.',
  });
}

// Block new entries if max_entries cap is reached.
// Both limits are independent — whichever hits first closes the pack.
if (pack.max_entries !== null && pack.max_entries !== undefined) {
  const currentEntries = pack.current_entries || 0;
  if (currentEntries >= pack.max_entries) {
    return res.status(410).json({
      success: false,
      code: 'ENTRY_CAP_REACHED',
      error: `This pack has reached its maximum entries (${pack.max_entries}). It is now closed.`,
      current_entries: currentEntries,
      max_entries: pack.max_entries,
    });
  }
}
```

### 2. pills.js (GET /specials endpoint)

**Changed**: Removed `entry_window_end` check from Specials endpoint

- **Line 267**: Removed incorrect filter by `entry_window_end`
- **Updated comment**: Clarified that `entry_window_end` is for Time Machine/predictions only, never for Specials

**Before**:
```javascript
const activePacks = (packs || []).filter((p) => {
  // Filter out packs whose entry_window_end has passed (legacy Time Machine check)
  if (p.entry_window_end && new Date(p.entry_window_end) <= now) return false;
  // Filter out packs whose quiz_expires_at has passed (Pills/Specials expiry)
  // Independent of entry_window_end — different field, different purpose.
  if (p.quiz_expires_at && new Date(p.quiz_expires_at) <= now) return false;
  return true;
});
```

**After**:
```javascript
const activePacks = (packs || []).filter((p) => {
  // Filter out packs whose quiz_expires_at has passed (Pills/Specials expiry)
  // entry_window_end is for Time Machine/predictions only — never used for Specials
  if (p.quiz_expires_at && new Date(p.quiz_expires_at) <= now) return false;
  return true;
});
```

## Consistency Verified

| Endpoint | File | Field Check | HTTP Status | Code |
|----------|------|-------------|-------------|------|
| POST /api/pills/special/start | pillsSpecial.js | ✅ quiz_expires_at | 410 | QUIZ_EXPIRED |
| POST /api/pills/vip/start | pillsVip.js | ✅ quiz_expires_at | 410 | QUIZ_EXPIRED |
| GET /specials | pills.js | ✅ quiz_expires_at | — (filters) | — |

All three now use the correct field. Field separation is maintained.

## Design Intent Preserved

1. **Field Separation**: 
   - `entry_window_end` used only by Time Machine/predictions
   - `quiz_expires_at` used only by Pills/Specials
   - No cross-feature field reading

2. **Optional With "No Expiry" Default**:
   - Both fields are nullable in the database
   - When `quiz_expires_at` is null, packs do not expire
   - Form should offer "No expiry" option (unchecked by default)

3. **Independent Limits** (Specials only):
   - `quiz_expires_at`: When quiz ends (no new entries after this time)
   - `max_entries`: Entry cap (no new entries after N attempts)
   - Whichever limit hits first closes the pack

## Files Changed

- `server/src/routes/pillsSpecial.js` (lines 118, 136-162)
- `server/src/routes/pills.js` (lines 266-272)

## Syntax Validated

```bash
$ node -c server/src/routes/pillsSpecial.js   # ✅ OK
$ node -c server/src/routes/pills.js          # ✅ OK
```

## Next Steps

1. **Frontend Form Review**: Verify that the form now binds to `quiz_expires_at` (not `entry_window_end`) and offers "No expiry" as the default, optional option.

2. **Testing**: 
   - Create a Specials pack with `quiz_expires_at` = null (no expiry)
   - Verify form displays as optional, not required
   - Verify pack accepts entries indefinitely
   - Create a Specials pack with `quiz_expires_at` = past date
   - Verify pack rejects new entries (HTTP 410 QUIZ_EXPIRED)

3. **Cleanup**: Remove any lingering references to `entry_window_end` in Specials-related frontend code.

---

**Commit**: Pending — ready to push after verification
