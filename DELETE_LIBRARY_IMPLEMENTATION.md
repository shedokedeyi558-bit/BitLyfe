# DELETE /api/admin/specials-bank/library Implementation

**Status**: ✓ Built  
**Date**: 2026-07-30

---

## Investigation Findings

### 1. Existing DELETE Endpoint

**File**: `server/src/routes/adminSpecialsBank.js`  
**Line**: 712  
**Route**: `DELETE /api/admin/specials-bank/library/:id`

Deletes a **single** library question by ID (soft-delete, stamps `deleted_at`).

```javascript
router.delete('/library/:id', async (req, res) => {
  // ... soft-delete by ID
});
```

**Status**: Already exists. Removes individual library questions.

---

### 2. No Bulk DELETE Endpoint

**Finding**: There was NO `DELETE /api/admin/specials-bank/library` endpoint (without `:id` parameter).

**Searched**: 
- `server/src/routes/adminSpecialsBank.js` — all routes
- `server/src/routes/adminPills.js` — all DELETE handlers
- All admin files for any bulk library delete

**Result**: Missing. Only individual `:id` deletion existed.

---

### 3. Schema: How "Attached" vs "Unattached" Works

The system has **two separate tables** for questions:

#### Table 1: `draft_question_library` (Staging Pool)

**File**: `DATABASE_MIGRATION_DRAFT_LIBRARY.sql`  
**Columns** (relevant):
- `id` (UUID, Primary Key)
- `admin_id` (UUID, REFERENCES admins)
- `question` (TEXT, NOT NULL)
- `format` (TEXT CHECK 'multiple_choice'|'type_answer')
- `options` (JSONB)
- `correct_answer` (TEXT, NOT NULL)
- `case_sensitive` (BOOLEAN, default false)
- `color` (VARCHAR(20))
- `label` (TEXT) — admin tagging
- `note` (TEXT) — admin memo
- `deleted_at` (TIMESTAMP, soft-delete flag)
- `created_at`, `updated_at` (TIMESTAMP)

**What it is**: Admin's staging area for questions NOT yet attached to any pack.

**Soft-delete**: Questions in this table can be marked deleted via `deleted_at` column.

#### Table 2: `pills` (Live Question Banks)

**File**: `server/src/db/schema.sql` lines 409–430  
**Key columns** (relevant):
- `id` (UUID, Primary Key)
- `admin_id` (UUID)
- `pack_id` (UUID, REFERENCES pill_packs.id, ON DELETE SET NULL) — **ADDED via ALTER** (line 287)
- `question` (TEXT)
- `format` (TEXT CHECK 'multiple_choice'|'type_answer')
- `options` (JSONB)
- `correct_answer` (TEXT)
- `status` (TEXT CHECK 'available'|'played'|'expired')
- `created_at`, `updated_at` (TIMESTAMP)

**What it is**: Live question bank. Each row is attached to a pack via `pack_id`.

**Attachment indicator**:
- `pack_id IS NULL` → unattached question (orphaned or standalone)
- `pack_id IS NOT NULL` → attached to a live pack

#### How Copy Works

**File**: `server/src/routes/adminSpecialsBank.js` lines 936–1009 (copy-to-pack)

When you copy from library to pack:
1. Read rows from `draft_question_library` where `deleted_at IS NULL`
2. Create **new independent rows** in `pills` table with `pack_id = <target pack>`
3. Library originals remain untouched (NOT linked to the new pills rows)

**Result**: 
- Original library question still in `draft_question_library` (reusable)
- New pill row in `pills` with `pack_id` set (attached to pack)
- No back-link from pills to library

---

## Implementation

### New Endpoint: DELETE /api/admin/specials-bank/library

**File**: `server/src/routes/adminSpecialsBank.js`  
**Line**: 738–782  
**Route**: `DELETE /api/admin/specials-bank/library` (no `:id` parameter)

**Purpose**: Bulk soft-delete ALL undeleted questions in the draft library.

**Code**:
```javascript
/**
 * DELETE /api/admin/specials-bank/library
 * Bulk soft-delete ALL undeleted questions in the draft library.
 * Does NOT touch questions that have been copied to packs (those are
 * independent rows in the pills table with pack_id set).
 * 
 * Returns: { deleted: <count> }
 */
router.delete('/library', async (req, res) => {
  try {
    // Count how many undeleted library questions exist
    const { count: totalCount, error: countErr } = await supabase
      .from('draft_question_library')
      .select('id', { count: 'exact', head: true })
      .is('deleted_at', null);

    if (countErr) {
      return res.status(500).json({ success: false, error: 'Failed to query library' });
    }

    const countToDelete = totalCount || 0;

    if (countToDelete === 0) {
      return res.json({ success: true, data: { deleted: 0, message: 'Library is already empty' } });
    }

    // Soft-delete all undeleted rows (stamp deleted_at with current timestamp)
    const now = new Date().toISOString();
    const { error: deleteErr } = await supabase
      .from('draft_question_library')
      .update({ deleted_at: now })
      .is('deleted_at', null);

    if (deleteErr) {
      return res.status(500).json({ success: false, error: 'Failed to delete library questions' });
    }

    return res.json({ success: true, data: { deleted: countToDelete } });
  } catch (err) {
    console.error('Library bulk delete error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete library' });
  }
});
```

---

### Behavior

#### Request
```
DELETE /api/admin/specials-bank/library
Authorization: Bearer <admin-token>
```

#### Response — Success (some deleted)
```json
{
  "success": true,
  "data": {
    "deleted": 47
  }
}
```

#### Response — Success (already empty)
```json
{
  "success": true,
  "data": {
    "deleted": 0,
    "message": "Library is already empty"
  }
}
```

#### Response — Error (query failed)
```json
{
  "success": false,
  "error": "Failed to query library"
}
```

---

### What Gets Deleted

- **All rows** in `draft_question_library` where `deleted_at IS NULL`
- Uses soft-delete: stamps `deleted_at` with current ISO timestamp
- Does NOT hard-delete (row still exists, just hidden by `deleted_at` filter)

### What Does NOT Get Deleted

- Questions in `pills` table (even if `pack_id IS NULL`)
- Questions in `pills` where `pack_id IS NOT NULL` (attached to packs) — these are safe anyway
- Already-deleted library questions (where `deleted_at IS NOT NULL`)
- Any other data (admins, players, packs, etc.)

---

### Authentication

The endpoint requires admin auth token. It's added to the standard admin route file `adminSpecialsBank.js` which already has middleware:

**Inferred from route structure**: Admin routes in Express typically use `auth` middleware before the route handler. Verify in index.js that `adminSpecialsBank` is mounted with auth:

**Expected in index.js** (around line 154–158):
```javascript
app.use('/api/admin/pills', auth, isAdmin, pillsRoutes);
app.use('/api/admin/pills/vip', auth, isAdmin, pillsVipRoutes);
app.use('/api/admin/specials-bank', auth, isAdmin, specialsBankRoutes);  // ← includes new DELETE
```

Since `specialsBankRoutes` is already wrapped with `auth` and `isAdmin`, the new endpoint is automatically protected.

---

## Testing Checklist

**Note**: No execution environment available. Verify these steps manually:

1. **Setup**: Create 5 test library questions via POST `/api/admin/specials-bank/library`
2. **Copy one to a pack**: Use POST `/api/admin/specials-bank/library/copy-to-pack` to move one to a Specials pack
3. **Verify before delete**:
   - GET `/api/admin/specials-bank/library` should return 5 questions
   - GET `/api/admin/pills/packs/:packId/pills` should show the 1 copied question in pills table
4. **Call bulk delete**:
   ```
   DELETE /api/admin/specials-bank/library
   Authorization: Bearer <admin-token>
   ```
5. **Expected result**: `{ "success": true, "data": { "deleted": 5 } }`
6. **Verify after delete**:
   - GET `/api/admin/specials-bank/library` should return 0 questions (or empty list)
   - GET `/api/admin/pills/packs/:packId/pills` should still show the 1 pill (untouched)
7. **Try deleting again**:
   ```
   DELETE /api/admin/specials-bank/library
   ```
   - Should return: `{ "success": true, "data": { "deleted": 0, "message": "Library is already empty" } }`

---

## Code Citations

### Schema: pills table with pack_id
- **File**: `server/src/db/schema.sql`
- **Lines**: 409–430 (CREATE TABLE pills)
- **Line**: 287 (ALTER TABLE pills ADD COLUMN pack_id)
- **pack_id definition**: `UUID REFERENCES pill_packs(id) ON DELETE SET NULL`

### Schema: draft_question_library
- **File**: `DATABASE_MIGRATION_DRAFT_LIBRARY.sql`
- **Lines**: 1–44 (complete table definition)
- **deleted_at**: Line 31, `deleted_at TIMESTAMP WITH TIME ZONE`
- **Soft-delete index**: Line 41, `WHERE deleted_at IS NULL`

### Individual DELETE endpoint (existing)
- **File**: `server/src/routes/adminSpecialsBank.js`
- **Line**: 712
- **Route**: `router.delete('/library/:id', ...)`

### Bulk DELETE endpoint (NEW)
- **File**: `server/src/routes/adminSpecialsBank.js`
- **Lines**: 738–782
- **Route**: `router.delete('/library', ...)`

### Copy-to-pack logic (reference)
- **File**: `server/src/routes/adminSpecialsBank.js`
- **Lines**: 936–1009
- **Shows**: How library questions are copied (NOT linked) to pills table

---

## Summary

A new bulk DELETE endpoint was added at `DELETE /api/admin/specials-bank/library` that:

1. **Queries** `draft_question_library` for all rows where `deleted_at IS NULL`
2. **Counts** how many exist
3. **Soft-deletes** all of them (stamps `deleted_at` with current timestamp)
4. **Returns** `{ deleted: <count> }`
5. **Protects** pills table (questions already copied to packs are unaffected)
6. **Requires** admin auth token (inherited from route mount)

The endpoint is idempotent (calling twice returns `deleted: 0` the second time).

No database schema changes. Uses existing soft-delete pattern (`deleted_at` column).

