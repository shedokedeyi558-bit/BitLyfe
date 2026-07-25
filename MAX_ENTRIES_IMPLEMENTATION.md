# Max Entries Implementation for Specials Packs

## Overview

Added entry-count-based expiry for Specials packs, allowing admins to cap a pack by total number of entry attempts instead of/in addition to time-based `quiz_expires_at`. When the cap is reached, no new entries are accepted.

## Changes Made

### 1. Database Schema

**New Migration File**: `DATABASE_MIGRATION_MAX_ENTRIES.sql`

Added two columns to `pill_packs` table:
- `max_entries` (nullable INTEGER): Admin-configurable cap on total entry attempts. NULL = no cap.
- `current_entries` (INTEGER, DEFAULT 0): Real-time counter of attempts started for this pack.

**Specials-only semantics**: 
- For standard Pills packs: both columns remain NULL/0 (not used).
- For Specials packs: `max_entries` is actively enforced on player attempt creation.

**Schema changes updated in**: `server/src/db/schema.sql`

### 2. Backend API Updates

#### Admin Create Pack (POST /api/admin/pills/packs)

**New Request Body Parameter**:
```javascript
{
  name,
  pack_type: 'special',
  question_count: 10,
  total_time_seconds: 600,
  required_correct: 7,
  // Optional expiry — any combination:
  quiz_expires_at: "2026-07-31T23:59:59Z",  // time-based (independent)
  max_entries: 50,                           // entry-count-based (independent)
  // Both can be set simultaneously — whichever hits first closes the pack
}
```

File: `server/src/routes/adminPills.js` (POST /packs handler)
- Accepts `max_entries` parameter for Specials packs
- Initializes `current_entries` to 0
- Null for standard packs

#### Admin Update Pack (PUT /api/admin/pills/packs/:packId)

**New Request Body Parameter**:
```javascript
{
  max_entries: 50,        // set a cap
  max_entries: null,      // remove cap (allow unlimited)
}
```

File: `server/src/routes/adminPills.js` (PUT /packs/:packId handler)
- Allows updating `max_entries` independently of other fields
- Can be set to null to remove the cap

#### Admin Pack List (GET /api/admin/pills/packs)

**New Response Fields** (Specials-only):
```javascript
{
  // ... existing fields ...
  max_entries: 50 | null,           // admin's configured cap
  current_entries: 23,              // real-time entry count
  entries_remaining: 27,            // calculated: max - current (null if no cap)
  entry_cap_reached: false,         // true if current_entries >= max_entries
}
```

File: `server/src/routes/adminPills.js` (GET /packs handler)
- Displays both time-based and entry-cap expiry status
- Calculated fields help admins monitor pack status in real time

### 3. Player Attempt Flow

#### Start Special Attempt (POST /api/pills/special/start)

**Existing code already checks entry cap**:
```javascript
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

**Entry counter increment** (fire-and-forget):
```javascript
// Increment current_entries counter after successful attempt creation
if (pack.max_entries !== null && pack.max_entries !== undefined) {
  supabase.from('pill_packs')
    .update({ current_entries: (pack.current_entries || 0) + 1 })
    .eq('id', packId)
    .catch(() => {});
}
```

**Response includes entry cap info**:
```javascript
return res.status(201).json({
  success: true,
  // ... existing fields ...
  current_entries: newCounter,   // updated count
  max_entries: pack.max_entries, // admin's cap (null if no limit)
  // ... rest of response ...
});
```

File: `server/src/routes/pillsSpecial.js` (POST /start handler)

#### Continue / Resume Attempt (POST /api/pills/special/start - resume path)

Already handles pack state queries correctly; entry cap info flows through naturally.

### 4. Error Handling

Both expiry mechanisms return consistent HTTP 410 (Gone) status:

**Time-based expiry**:
```json
{
  "success": false,
  "code": "QUIZ_EXPIRED",
  "error": "This pack is no longer accepting new entries — it has ended."
}
```

**Entry cap reached**:
```json
{
  "success": false,
  "code": "ENTRY_CAP_REACHED",
  "error": "This pack has reached its maximum entries (50). It is now closed.",
  "current_entries": 50,
  "max_entries": 50
}
```

### 5. Player-Facing Display

The frontend can show entry caps in two ways:

**When cap is active (e.g., max_entries = 50, current_entries = 37)**:
```
37 / 50 entries used
```

**When no cap or unlimited**:
```
Unlimited entries
```

This uses existing response fields from `/start` endpoint:
- `current_entries` (actual count)
- `max_entries` (admin's cap, or null if unlimited)

No special player-facing changes needed — display logic is on frontend based on these fields.

## Implementation Decision: Dual Expiry

**Chosen approach**: **Both limits simultaneously** (whichever hits first closes the pack)

**Rationale**:
- Both `quiz_expires_at` and `max_entries` are treated as independent, mutually-checked guards
- Cleaner than "either/or" selector — admin can set both and system enforces both
- No complex UI logic for "pick one mode"
- Simpler to reason about: "pack closes when time OR entry count limit is reached"
- Matches existing code pattern where both limits are checked with `||` logic

**Example usage**:
- Admin sets: `quiz_expires_at: Jul 31, max_entries: 50`
- If time runs out on Jul 29 with 30 entries used: pack closes (time limit hit first)
- If 50 entries used on Jul 28: pack closes (entry cap hit first)
- If neither limit reached by Jul 31: pack closes (time ran out)

## Standard Pills Unaffected

Standard (non-Specials) packs:
- `max_entries` stays NULL
- `current_entries` stays 0
- Entry flow unchanged
- No cap enforcement
- No player-facing changes

**Verified in code**:
- Entry cap check only runs when `pack.max_entries !== null && pack.max_entries !== undefined`
- Only Specials packs (pack_type='special' or is_vip=true) pass max_entries in admin creation
- Response fields null for non-Specials in admin pack list

## Files Modified

1. **Database**:
   - `DATABASE_MIGRATION_MAX_ENTRIES.sql` (new)
   - `server/src/db/schema.sql` (updated with new columns)

2. **Admin API** (`server/src/routes/adminPills.js`):
   - POST /packs: Accept max_entries, initialize current_entries
   - PUT /packs/:packId: Update max_entries
   - GET /packs: Display entry cap status

3. **Player API** (`server/src/routes/pillsSpecial.js`):
   - POST /start: Check max_entries cap, return entry info (already implemented, just needed DB columns)

## Testing Checklist

- [ ] Run DATABASE_MIGRATION_MAX_ENTRIES.sql migration
- [ ] Create a Specials pack with max_entries=5
- [ ] Verify admin can update max_entries
- [ ] Attempt 1-4: All succeed, current_entries increments
- [ ] Attempt 5: Succeeds, current_entries = 5
- [ ] Attempt 6: Returns 410 ENTRY_CAP_REACHED
- [ ] Admin pack list shows entry cap fields
- [ ] Standard Pills packs unaffected (no changes needed)
- [ ] Both quiz_expires_at and max_entries work independently
- [ ] Time limit still works (can be set alongside max_entries)

## Frontend Integration Notes

### Admin Create Form
Add field for entry cap:
```
Expiry Mode:
  ○ By time (quiz_expires_at)
  ○ By entry count (max_entries)
  ○ Both (recommended: whichever hits first closes pack)
  ○ No limit

When "Both": show time picker AND number field
When "By entry count": show number field (max_entries)
When "By time": show time picker
When "No limit": both null
```

Suggested: Default to "No limit" for backwards compatibility; allow admin to pick others.

### Admin Pack Management
Display entry cap status in pack list or detail view:
```
Entry Cap: 50 / 50 used
Status: [Entry cap reached]

OR

Entry Cap: 37 / 50 used
Status: [Active, 13 entries remaining]

OR

Entry Cap: Unlimited
Status: [Active]
```

### Player Pack Listing
Show entry progress if cap is set:
```
"37/50 entries" (if max_entries set)
"Unlimited entries" (if max_entries null)
```

When pack is closed due to entry cap:
```
"Pack closed (50/50 entries used)"
```

## Backwards Compatibility

✅ Fully backwards compatible:
- New columns nullable (max_entries) or defaulted (current_entries=0)
- Existing Specials packs: max_entries=null, current_entries=0 → no cap enforced
- Existing Standard Pills: unaffected
- No breaking API changes
- Response fields only added (not renamed/removed)

## Performance Notes

- `current_entries` incremented fire-and-forget (non-blocking)
- Index added on (id, max_entries, current_entries) for Specials packs
- Entry cap check is O(1) single condition
- No new joins or complex queries
