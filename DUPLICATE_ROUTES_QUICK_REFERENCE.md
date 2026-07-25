# Duplicate Routes — Quick Reference

**Audit Date**: 2026-07-25  
**Status**: Complete — 1 fix applied, 3 decisions pending, 4 refactorings recommended

---

## One-Line Status for Each Finding

| Issue | Type | Status | Action |
|-------|------|--------|--------|
| VIP entry spend limit | 🔴 BUG | ✅ FIXED | Commit 642292f |
| Prediction creation fields | 🟡 DESIGN | ⏳ DECISION | Consolidate endpoints? |
| pillsSpecial.js dead code | 🟡 DESIGN | ⏳ DECISION | Delete if unused? |
| checkSpendLimit triplicated | 🟢 DRY | 📋 REFACTOR | Extract to service |
| Referral logic duplicated | 🟢 DRY | 📋 REFACTOR | Extract to service |

---

## What Got Fixed Today

```
pillsVip.js — Added spend limit check before entry fee deduction
- Lines: 23–77 (added checkSpendLimit() function)
- Lines: 366–370 (added validation call)
- Behavior: Now returns HTTP 429 if daily/weekly limit exceeded
- Matches: pills.js, predictions.js, blitz.js patterns
```

---

## The Four Major Duplications

### 1. Three-Way Duplication: checkSpendLimit()

```
predictions.js (lines 17–77)  ├─ IDENTICAL (180 lines)
pills.js (lines 17–77)        │
blitz.js (lines 16–76)        └─ All same, should be: server/src/services/spendLimits.js
```

**Fix**: Extract to shared service, import in all 3  
**Time**: ~2 hours  
**Risk**: Low

---

### 2. Two-Way Duplication: Referral Processing

```
auth.js → signup (lines ~300–350)   ├─ IDENTICAL (150 lines)
auth.js → register (lines ~580–630) └─ Should be: server/src/services/referralProcessing.js
```

**Fix**: Extract to shared service, import in both  
**Time**: ~2 hours  
**Risk**: Low

---

### 3. Two-Way Incompatibility: Prediction Creation

```
games.js → POST /admin/games/create (line 349)
  Input: countdown_end (ISO date)
  Behavior: Converts to seconds

adminPredictions.js → POST /admin/predictions (line 66)
  Input: countdown_seconds (number)
  Behavior: Converts to ISO date
```

**Risk**: MEDIUM — Different param names, field mismatch bug pattern  
**Fix**: Delete one, keep one (POST /admin/games/create recommended)  
**Impact**: Breaking change for any frontend calling POST /admin/predictions  
**Decision**: Team choice

---

### 4. One Dead Code: pillsSpecial.js

```
pillsSpecial.js (entire file)
  Routes: /api/pills/special/*
  Frontend calls: NONE (superseded by pillsVip.js)
  Status: Unused, redundant
```

**Risk**: LOW for deletion (git history preserved), HIGH for keeping (future drift)  
**Fix**: Delete if confirmed unused  
**Decision**: Team choice

---

## Who Should Make Each Decision

| Decision | Team | Input Needed |
|----------|------|--------------|
| Delete pillsSpecial.js? | Backend | Confirm no clients use `/api/pills/special/*` |
| Consolidate predictions? | Backend/Frontend | Confirm POST /admin/predictions not used |
| Refactor checkSpendLimit? | Backend | Prioritize in sprint (medium effort, low risk) |
| Refactor referral logic? | Backend | Prioritize in sprint (medium effort, low risk) |

---

## Testing Recommendations After Fixes

### VIP Entry Spend Limit (Already Fixed ✅)

```javascript
// Test 1: Normal entry works
POST /api/pills/vip/start { packId: "..." }
Expected: 200 OK

// Test 2: With daily limit set to ₦5000
player_limits.daily_limit = 5000
player.balance = 10000

POST /api/pills/vip/start { packId: "..." } // entry_fee = 6000
Expected: 429 LIMIT_REACHED

// Test 3: Within limit works
POST /api/pills/vip/start { packId: "..." } // entry_fee = 3000
Expected: 200 OK
```

### Prediction Consolidation (If Done)

```javascript
// Before consolidation: Both work with different inputs
POST /admin/games/create { game_type: 'predictions', countdown_end: '...' }
POST /admin/predictions { countdown_seconds: 3600 }

// After consolidation: Only one endpoint
POST /admin/games/create { game_type: 'predictions', countdown_end: '...' }
// POST /admin/predictions returns 404
```

---

## Code Location Reference

**Entry Fee Checking**:
- pills.js: 494
- predictions.js: 173
- pillsVip.js: **366** (now fixed)
- blitz.js: 337
- pillsSpecial.js: missing (dead code)

**Spend Limit Function** (identical copies):
- predictions.js: 17–77
- pills.js: 17–77
- blitz.js: 16–76

**Prediction Creation** (incompatible formats):
- games.js: 349–371 (uses: countdown_end)
- adminPredictions.js: 66–97 (uses: countdown_seconds)

**Referral Logic** (duplicated):
- auth.js signup: ~300–350
- auth.js register: ~580–630

---

## Commit History

```
642292f - Fix: Add missing spend limit check to VIP pack entry
├─ pillsVip.js: +79 lines (checkSpendLimit function + call)
└─ Pushed to main ✅

b17c1e5 - Fix: Specials packs now use quiz_expires_at instead of entry_window_end
├─ pillsSpecial.js: Fixed field binding
├─ pills.js: Removed wrong field check
└─ Pushed to main ✅

ab10af1 - Fix: Add missing welcome notification to signup endpoint
├─ auth.js: Consistent with register endpoint
└─ Pushed to main ✅
```

---

## Summary for Standup

**Found**: 15+ code duplications across backend  
**Fixed**: 1 critical bug (VIP spend limit)  
**Identified**: 3 design issues needing team decision  
**Documented**: Complete audit with refactoring recommendations  
**Priority**: 
- ✅ Bug fix: Done
- ⏳ Decisions: Needed this week
- 📋 Refactoring: Can schedule next sprint

---

*For detailed technical analysis, see DUPLICATE_ROUTES_AUDIT.md*
