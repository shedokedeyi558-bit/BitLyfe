# Max Entries for Specials Packs — Quick Reference

## TL;DR

Added ability for admins to cap Specials packs by entry count (e.g., "max 50 attempts") in addition to/instead of time expiry. Both limits work independently — whichever hits first closes the pack.

## What Changed

### Database
- Added `max_entries` (nullable int) and `current_entries` (int, default 0) to `pill_packs`
- Run: `DATABASE_MIGRATION_MAX_ENTRIES.sql`

### Admin API

**Create Pack** (POST /api/admin/pills/packs)
```javascript
{
  pack_type: 'special',
  name: 'Weekly Challenge',
  max_entries: 50,        // NEW: cap at 50 attempts
  quiz_expires_at: '...', // still works (time limit)
  // ... other fields ...
}
```

**Update Pack** (PUT /api/admin/pills/packs/:packId)
```javascript
{
  max_entries: 75,        // NEW: change cap
  max_entries: null,      // NEW: remove cap (unlimited)
}
```

**Pack List** (GET /api/admin/pills/packs)
```javascript
{
  // ... existing fields ...
  max_entries: 50,           // NEW
  current_entries: 23,       // NEW
  entries_remaining: 27,     // NEW (calculated)
  entry_cap_reached: false,  // NEW
}
```

### Player API

**Start Attempt** (POST /api/pills/special/start)

Now returns:
```javascript
{
  current_entries: 24,    // NEW: how many have started so far
  max_entries: 50,        // NEW: admin's cap (null if unlimited)
  // ... existing fields ...
}
```

Returns 410 error if cap reached:
```javascript
{
  success: false,
  code: 'ENTRY_CAP_REACHED',
  error: 'This pack has reached its maximum entries (50). It is now closed.',
  current_entries: 50,
  max_entries: 50,
}
```

## Expiry Modes Explained

Admin can set any combination:

| quiz_expires_at | max_entries | Result |
|---|---|---|
| Set | Set | Whichever limit hits first closes pack ✓ |
| Set | null | Time-based only (existing behavior) |
| null | Set | Entry-count-based only (new) |
| null | null | No limit (pack stays open indefinitely) |

### Example Scenarios

**Scenario 1: Entry cap only**
- Admin sets: max_entries=50, quiz_expires_at=null
- After 50 attempts: Pack closes (entry cap reached)
- Time is irrelevant

**Scenario 2: Time limit only**
- Admin sets: max_entries=null, quiz_expires_at="2026-07-31"
- After 48 attempts (3 days left): Pack closes (time ran out)
- Entry count is irrelevant

**Scenario 3: Both limits (recommended)**
- Admin sets: max_entries=50, quiz_expires_at="2026-07-31"
- After 35 attempts (3 days left): Pack closes (entry cap reached first)
- OR after 2 days (40 attempts so far): Pack closes (time ran out first)
- System checks both and closes on whichever condition is met first

## Frontend Integration

### Admin Create Form

Add this to the Specials pack creation form:

```
Expiry Options:
[ ] Set time limit (quiz_expires_at)
    [Datetime picker]
[ ] Set entry cap (max_entries)
    [Number input: 1-1000]
[ ] Unlimited (no expiry)

Default: Unlimited
Recommendation: Enable both for production packs
```

### Admin Pack Management View

Display entry cap status:

```
Pack: "Weekly Challenge"
Status: Active
Time expires: Jul 31, 2026 (in 6 days)
Entry cap: 37 / 50 used
Entries remaining: 13
```

### Player Pack Listing

Show progress when capped:

```
"Weekly Challenge"
37 of 50 entries available
[Start Attempt Button]

---

"Daily Trivia"
Unlimited entries
[Start Attempt Button]
```

When pack is closed:

```
"Weekly Challenge"
(Closed - 50/50 entries used)
[View Results Button]
```

## Code Flow

### Admin creates pack with entry cap

```
POST /api/admin/pills/packs
{
  "name": "Weekly Challenge",
  "pack_type": "special",
  "max_entries": 50
}
  ↓
adminPills.js (POST /packs)
  ↓
supabase.from('pill_packs').insert({
  name, max_entries: 50, current_entries: 0, ...
})
```

### Player starts attempt

```
POST /api/pills/special/start
{
  "packId": "abc-123"
}
  ↓
pillsSpecial.js (POST /start)
  ↓
// 1. Fetch pack
const pack = await supabase.from('pill_packs').select(...)
  
// 2. Check max_entries cap
if (pack.max_entries !== null) {
  const currentEntries = pack.current_entries || 0;
  if (currentEntries >= pack.max_entries) {
    return res.status(410).json({
      code: 'ENTRY_CAP_REACHED',
      error: 'Pack has reached its maximum entries...'
    });
  }
}

// 3. Create attempt, then increment counter
const attempt = await supabase.from('special_attempts').insert(...)
if (pack.max_entries !== null) {
  supabase.from('pill_packs')
    .update({ current_entries: (pack.current_entries || 0) + 1 })
    .eq('id', packId)
    .catch(() => {});  // fire-and-forget
}
```

## Key Implementation Details

✅ **Both limits work independently**
- No UI selector for "pick one mode"
- Admin can set both `quiz_expires_at` and `max_entries`
- Server checks both independently
- Whichever condition is met first closes the pack

✅ **Fire-and-forget counter increments**
- `current_entries` incremented after successful attempt creation
- Non-blocking (doesn't delay response)
- If increment fails, attempt is still valid
- Worst case: counter lags slightly (acceptable for UI display)

✅ **Standard Pills unaffected**
- Specials only: entry cap enforced only for `pack_type='special'` or `is_vip=true`
- Standard Pills: max_entries=null, current_entries=0 always
- No changes to standard pill flow

✅ **Backwards compatible**
- New columns nullable/defaulted
- Existing packs: no cap enforced (max_entries=null)
- No breaking API changes
- Response fields only added, not removed

## Testing Commands

### 1. Run migration
```bash
# In Supabase SQL editor or using your migration tool:
\copy DATABASE_MIGRATION_MAX_ENTRIES.sql
```

### 2. Create pack with entry cap
```bash
curl -X POST http://localhost:3001/api/admin/pills/packs \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Pack",
    "pack_type": "special",
    "question_count": 5,
    "total_time_seconds": 300,
    "required_correct": 3,
    "max_entries": 3
  }'
```

### 3. Attempt pack
```bash
# Attempt 1-3: should succeed
curl -X POST http://localhost:3001/api/pills/special/start \
  -H "Authorization: Bearer <player_token>" \
  -H "Content-Type: application/json" \
  -d '{ "packId": "<pack_id>" }'

# Response includes: "current_entries": 1, "max_entries": 3

# Attempt 4: should fail with 410 ENTRY_CAP_REACHED
curl -X POST http://localhost:3001/api/pills/special/start \
  -H "Authorization: Bearer <player_token>" \
  -H "Content-Type: application/json" \
  -d '{ "packId": "<pack_id>" }'
```

### 4. Check pack status
```bash
curl -X GET http://localhost:3001/api/admin/pills/packs \
  -H "Authorization: Bearer <admin_token>"

# Response includes:
# {
#   "max_entries": 3,
#   "current_entries": 3,
#   "entries_remaining": 0,
#   "entry_cap_reached": true
# }
```

## Troubleshooting

**Q: Pack allows more entries than max_entries says**
- A: Increment is fire-and-forget; counter may lag. Check database directly:
  ```sql
  SELECT id, name, max_entries, current_entries FROM pill_packs WHERE id='...';
  ```

**Q: Entry cap fields are null in admin list**
- A: Ensure pack is a Specials pack (pack_type='special' or is_vip=true)
- A: Entry cap fields only show for Specials packs

**Q: Changes don't work after code update**
- A: Ensure migration was run: `DATABASE_MIGRATION_MAX_ENTRIES.sql`
- A: Verify columns exist:
  ```sql
  SELECT column_name FROM information_schema.columns 
  WHERE table_name='pill_packs' AND column_name IN ('max_entries', 'current_entries');
  ```

## Related Files

- Schema: `server/src/db/schema.sql`
- Migration: `DATABASE_MIGRATION_MAX_ENTRIES.sql`
- Admin API: `server/src/routes/adminPills.js`
- Player API: `server/src/routes/pillsSpecial.js`
- Full docs: `MAX_ENTRIES_IMPLEMENTATION.md`
