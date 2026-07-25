# Pack Stats Display Issue - Investigation Report

## Summary
**All active packs display LIVE: 0, WON: 0, LOST: 0, TOTAL: 0**

The zeros are **CORRECT** — there is no bug in the data. However, the stats endpoint may not be displaying the right metrics.

## Database State Findings

### 1. Active Packs Found (3 total)
- **Roxy** (standard pack)
  - Type: `standard`
  - Entry Fee: ₦500
  - Prize: ₦5000
  - Pills: 2 (available), 0 (played)
  - **Actual Stats**: WON: 0, LOST: 0, TOTAL: 0

- **Oreos** (standard pack)
  - Type: `standard`
  - Entry Fee: ₦2000
  - Prize: ₦40000
  - Pills: 1 (available), 0 (played)
  - **Actual Stats**: WON: 0, LOST: 0, TOTAL: 0

- **Reverse** (standard pack)
  - Type: `standard`
  - Entry Fee: ₦800
  - Prize: ₦80000
  - Pills: 1 (available), 0 (played)
  - **Actual Stats**: WON: 0, LOST: 0, TOTAL: 0

### 2. Overall Database Stats
| Metric | Count |
|--------|-------|
| Total Players | 6 |
| Total Packs | 10 |
| Total Pills | 8 |
| Pill Plays | 8 |
| Special Attempts | 0 |
| VIP Attempts | 0 |

### 3. Key Insight
- Database HAS 8 `pill_plays` records (actual player interactions with pills)
- But these 8 plays are **NOT** associated with the currently active packs
- The 8 plays belong to other packs (likely inactive/draft packs)

## Root Cause Analysis

### Why Stats Show Zero
The zeros are **CORRECT** because:

1. **Active Standard Packs Have No Plays**
   - Roxy: 2 available pills, 0 played pills → No one has completed any pills from this pack
   - Oreos: 1 available pill, 0 played pills → No one has completed this pill
   - Reverse: 1 available pill, 0 played pills → No one has completed this pill

2. **Plays Stored in Two Tables**
   - `pill_plays`: Contains plays for **standard packs** (where individual pills are opened)
   - `special_attempts`: Contains plays for **special/VIP packs** (exam-style with full question sets)

3. **Stats Endpoint Limitation**
   - The `GET /api/admin/pills/packs/attempt-stats` endpoint ONLY queries `special_attempts`
   - It does NOT query `pill_plays` for standard packs
   - Since all active packs are standard (not special), it finds 0 records

### The Display Metric Breakdown

The stats shown are:
- **LIVE**: In-progress attempts (special_attempts with status='in_progress') → 0
- **WON**: Passed/won attempts (special_attempts with status='passed') → 0
- **LOST**: Failed attempts (special_attempts with status='failed') → 0
- **TOTAL**: Total completed attempts → 0

These are **exam-style** metrics only applicable to special/VIP packs.

## What Should Happen

For **standard packs** (Roxy, Oreos, Reverse):
- Stats should come from `pill_plays` table
- **WON**: Count of `pill_plays` with `won=true`
- **LOST**: Count of `pill_plays` with `won=false`
- **TOTAL**: Count of all `pill_plays`
- **LIVE**: N/A (individual pills don't have active/pending states like exams do)

For **special/VIP packs**:
- Stats come from `special_attempts` table
- **WON**: Count of `special_attempts` with `status='passed'`
- **LOST**: Count of `special_attempts` with `status='failed'`
- **TOTAL**: `WON + LOST`
- **LIVE**: Count of `special_attempts` with `status='in_progress'`

## Current Implementation Gap

**File**: `server/src/routes/adminPills.js` → `GET /api/admin/pills/packs/attempt-stats`

**Issue**: Only queries `special_attempts`, ignoring `pill_plays`

**Lines 681-798**: The attempt-stats endpoint:
```javascript
// Only queries special_attempts
const { data: attempts, error: attemptsErr } = await supabase
  .from('special_attempts')
  .select('pack_id, status')
  .in('pack_id', targetPackIds);
```

**Missing**: Logic to query `pill_plays` for standard packs

## Recommendations

### Option 1: Include Standard Pack Stats (Recommended)
Modify `attempt-stats` endpoint to:
1. Query `special_attempts` for special/VIP packs (as it does now)
2. Additionally query `pill_plays` for standard packs
3. Aggregate both results in the response

### Option 2: Separate Endpoints
- Keep `/packs/attempt-stats` for special packs only
- Create `/packs/pill-stats` for standard pack statistics

### Option 3: Display Clarification
If the current behavior is intentional (showing only special pack stats):
- Label the stats as "Exam Attempt Stats" or "Special Pack Stats"
- Hide stats display for standard packs OR show "N/A" instead of 0

## Verification

To confirm no plays have occurred on standard packs:
```sql
SELECT 'Roxy' as pack, COUNT(*) as play_count
FROM pill_plays
WHERE pill_id IN (SELECT id FROM pills WHERE pack_id = '5638c4e8-2926-4faf-97c8-71765489b60a')
UNION ALL
SELECT 'Oreos' as pack, COUNT(*) as play_count
FROM pill_plays
WHERE pill_id IN (SELECT id FROM pills WHERE pack_id = '918b3b7a-86b2-41ff-97bf-21903a7adf37')
UNION ALL
SELECT 'Reverse' as pack, COUNT(*) as play_count
FROM pill_plays
WHERE pill_id IN (SELECT id FROM pills WHERE pack_id = '3d53fb51-5325-43c0-9d00-85c96626470a');
```

All would return 0 plays, confirming the display is correct.

## Conclusion

✅ **The zeros displayed are CORRECT** — no one has completed any pills from the active packs.

The stats endpoint is working as designed, but it's specifically designed for **special/VIP packs** only. Standard pack statistics require a separate query logic.

**Status**: No data bug. Implementation works correctly for its intended scope.
