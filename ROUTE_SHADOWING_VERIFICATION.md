# Route Shadowing Verification: GET /api/admin/pills/packs

**Status**: ✓ VERIFIED — No shadowing, exactly one handler

---

## Mount Configuration

**File**: `server/src/index.js` lines 150–170

```javascript
app.use('/api/pills', gameLimiter, pillsRoutes);           // Line 154
app.use('/api/pills/vip', gameLimiter, pillsVipRoutes);   // Line 155

app.use('/api/admin/games', gamesRoutes);                  // Line 162
app.use('/api/admin/pills', adminPillsRoutes);             // Line 163 ← adminPills.js
app.use('/api/admin/specials-bank', adminSpecialsBankRoutes); // Line 164
app.use('/api/admin/predictions', adminPredictionsRoutes);    // Line 165
app.use('/api/admin/blitz', adminBlitzRoutes);                // Line 166
app.use('/api/admin/withdrawals', withdrawalRoutes);          // Line 167
app.use('/api/admin/challenges', challengeRoutes);            // Line 168

// Generic admin router (stats, players, settings, analytics, seed, export, etc.)
app.use('/api/admin', adminRoutes);                        // Line 170
```

**Important note (line 162)**: Comment says "Admin subroutes BEFORE generic /api/admin so they aren't shadowed" — this is the correct order to prevent shadowing.

---

## All GET /packs Routes in Codebase

### 1. Player-Facing: GET /api/pills/packs

**File**: `server/src/routes/pills.js`  
**Line**: 123  
**Full path**: `GET /api/pills/packs`  
**Auth**: Yes (auth middleware)  

```javascript
/**
 * GET /api/pills/packs
 * List all public standard packs (player view)
 * Returns packs with computed fields: ...
 */
router.get('/packs', auth, async (req, res) => {
```

**Purpose**: Player endpoint to list available Pill packs.

---

### 2. Admin-Facing: GET /api/admin/pills/packs

**File**: `server/src/routes/adminPills.js`  
**Line**: 35  
**Full path**: `GET /api/admin/pills/packs`  
**Auth**: Inherits from mount (wrapped by auth, isAdmin middleware)  

```javascript
/**
 * GET /api/admin/pills/packs
 * List all packs with their pills (admin view — includes all fields)
 * Query params:
 *   ?includeInactive=false (default: false)
 *     - false: exclude archived packs (status='inactive' AND available_count=0)
 *     - true: include all packs including archived ones
 */
router.get('/packs', async (req, res) => {
```

**Purpose**: Admin endpoint to list all packs (standard + specials) with full details and filter option.

---

## Route Priority & Shadowing Analysis

### Mount Order (index.js lines 162–170)

```
1. app.use('/api/admin/games', ...)        ← Admin subroutes first
2. app.use('/api/admin/pills', ...)        ← adminPills.js mounted here
3. app.use('/api/admin/specials-bank', ...)
4. app.use('/api/admin/predictions', ...)
5. app.use('/api/admin/blitz', ...)
6. app.use('/api/admin/withdrawals', ...)
7. app.use('/api/admin/challenges', ...)
8. app.use('/api/admin', ...)              ← Generic admin router LAST
```

### Path Resolution

When Express receives `GET /api/admin/pills/packs`:

1. `/api/admin/games` → No match (different path prefix)
2. `/api/admin/pills` → **MATCH** → Routes within adminPills.js are checked
   - `GET /packs` in adminPills.js → **MATCHES** ✓
3. (Router stops here; later routes not checked)

**Result**: The request is handled by `adminPills.js` line 35. No shadowing occurs.

---

## Other /packs Routes (Different Paths)

All other `/packs` routes use parameters (`:packId`, `/attempt-stats`, `/pills`) and don't conflict:

| File | Line | Path | Type | Notes |
|---|---|---|---|---|
| adminSpecialsBank.js | 43 | `GET /packs/:packId/questions` | Specific pack | Different path |
| adminSpecialsBank.js | 170 | `GET /packs/:packId` | Specific pack | Different path |
| adminPills.js | 717 | `GET /packs/attempt-stats` | Stats endpoint | More specific than `/packs` |
| adminPills.js | 920 | `GET /packs/:packId/stats` | Specific pack stats | Different path |
| adminPills.js | 1017 | `GET /packs/:packId/pills` | Specific pack's pills | Different path |

**Route specificity order** (Express matches from most to least specific):
1. `/packs/attempt-stats` (literal string, most specific)
2. `/packs/:packId/stats` (with param)
3. `/packs/:packId/pills` (with param)
4. `/packs/:packId` (single param)
5. `/packs/:packId/questions` (with param)
6. `/packs` (no params, matches any query params)

---

## Conclusion: No Shadowing Detected

### ✓ GET /api/admin/pills/packs (Line 35)

**Is it the unique handler?** YES

**Verification**:
1. Mounted under `/api/admin/pills` (line 163)
2. Registered as `router.get('/packs')` (line 35)
3. Full path: `GET /api/admin/pills/packs`
4. Mount order correct (admin subroutes before generic `/api/admin`)
5. No earlier catch-all route shadows it
6. No duplicate `router.get('/packs')` in the same file

**Shadowing threats**: None found
- Different sub-routers have `:packId` variants, not exact `/packs` matches
- `/packs/attempt-stats` is more specific (matches before `/packs`)
- Generic `/api/admin` mounted last, can't shadow earlier admin subroutes

**Query param handling**: Correctly parsed by the handler (line 38, verified in previous report)

---

## Code Citations

| Item | File | Line |
|---|---|---|
| Admin subroute mount | `server/src/index.js` | 163 |
| Admin router mount (last) | `server/src/index.js` | 170 |
| Mount order comment | `server/src/index.js` | 162 |
| GET /packs handler | `server/src/routes/adminPills.js` | 35 |
| Query param parsing | `server/src/routes/adminPills.js` | 38 |
| Filter logic | `server/src/routes/adminPills.js` | 138–153 |
| Player GET /packs | `server/src/routes/pills.js` | 123 |

---

## Summary

**GET /api/admin/pills/packs is uniquely defined** with no shadowing:

- Only one `router.get('/packs')` registered in `adminPills.js` (line 35)
- Mounted under `/api/admin/pills` (line 163 in index.js)
- Registered with correct query param parsing and filter logic
- No earlier catch-all routes shadow it
- No parameter variants in the same file conflict with it
- Mount order ensures admin subroutes are checked before generic `/api/admin`

The route is clean, unique, and correctly configured.

