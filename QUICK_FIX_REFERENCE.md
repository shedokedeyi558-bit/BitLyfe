# Quick Reference: Specials Pack Creation Fix

**What was fixed**: Specials pack creation failing with `PGRST204` schema cache error  
**How**: Explicit column selection + omit problematic column on insert  
**Deploy**: `git pull origin main` (commit `7dadf39`)  
**Risk**: Minimal — code-only change, no data loss, no breaking changes

---

## Test Immediately After Deploy

### Step 1: Create a Specials Pack
1. Open admin panel
2. Pills → Create Pack
3. Fill form:
   - **Name**: "Test Specials"
   - **Category**: "Science"
   - **Question Count**: 10
   - **Total Time**: 15 (minutes)
   - **Required Correct**: 8
   - **Target Bank Size**: 300
4. Click Create
5. **Expected**: ✅ Success (201 status)

### Step 2: Check Database
```sql
SELECT id, name, pack_type, current_entries, max_entries, status
FROM pill_packs 
WHERE name = 'Test Specials'
LIMIT 1;
```

**Expected result**:
```
id: <uuid>
name: Test Specials
pack_type: special
current_entries: 0         ← Key verification
max_entries: null
status: draft
```

### Step 3: Check Backend Logs
Look for:
```
[timestamp] POST /api/admin/pills/packs
POST /packs request body: { name: 'Test Specials', ... }
```

Should **NOT** see:
```
PGRST204
Could not find the 'current_entries' column
```

---

## If Something Goes Wrong

### Error: Still getting PGRST204
- Double-check that `7dadf39` was deployed
- Check git log: `git log --oneline -1` should show `7dadf39`
- Redeploy if needed

### Error: Different schema error
- Check Supabase dashboard for any ongoing maintenance
- Verify database connection string in `.env`
- Check application logs for full error details

### Pack created but current_entries not 0
- Check database directly:
```sql
SELECT current_entries, created_at FROM pill_packs WHERE name = 'Test Specials';
```
- If it shows NULL or wrong value, the DEFAULT constraint may not have worked
- Check Supabase schema: `PRAGMA table_info(pill_packs);`

---

## What Was Changed

**File**: `server/src/routes/adminPills.js`

**3 endpoints updated**:
1. `POST /packs` — Create pack
2. `PUT /packs/:packId` — Update pack  
3. `PUT /packs/:packId/feature` — Set featured

**Change pattern**:
- **Before**: `.select()` → PostgREST tries to validate ALL columns in cache
- **After**: `.select('id, name, ..., max_entries, is_featured, created_at')` → Only validates listed columns

---

## Rollback (If Needed)

If the fix causes unexpected issues:
```bash
git revert 7dadf39
git push origin main
```

This will revert only that commit. The original error will return, but at least you can investigate further.

---

## Questions?

- Check `SPECIALS_PACK_CREATION_FIX.md` for full technical explanation
- Check `SESSION_7_COMPLETE_SUMMARY.md` for session overview
- Check backend logs for specific error details
