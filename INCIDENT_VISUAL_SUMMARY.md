# Pill Race Condition Incident: Visual Summary

## The Problem in One Diagram

```
Timeline: July 28, 2026

TIME        PLAYER B                      PLAYER A                      PILL STATUS
────────────────────────────────────────────────────────────────────────────────────
20:36:53    Open pill #1                                                available
            ✓ Check status != 'played'                                 
            → Deduct ₦200                                              opening
            → Create pill_plays entry                                  
                                                                       
20:36:54    [Timer running...]            
            [Has 30 seconds...]
                                          
20:39:02                                  Open pill #1                 available ← BUG!
                                          ✓ Check status != 'played'   (not yet marked)
                                          → Deduct ₦200 ← FRAUDULENT   
                                          → Create pill_plays entry    

20:41:28    Submit "Q" (CORRECT)                                        opening
            ✓ Locks answer                                             
            ✓ Marks pill = 'played'                                    played
            ✓ Credits ₦15,000             
                                          
20:42:00                                  [Timer expires or abandons]
                                          No answer submitted
            
RESULT:     ✓ Won ₦15,000                ✗ Lost ₦200                 DUPLICATED ✗
            Balance: ₦58,730              Balance: ₦0                 

Status:     LEGITIMATE WIN                FRAUDULENT CHARGE           RACE CONDITION
```

## The Root Cause

```
┌──────────────────────────────────────────────────────────────┐
│ ATOMICITY PROBLEM: No Lock Between Fetch and Claim         │
└──────────────────────────────────────────────────────────────┘

CURRENT BROKEN FLOW:
═══════════════════════════════════════════════════════════════

Fetch pill (status='available')
    ↓
    Check status != 'played' ✓ (passes)
    ↓
    ← RACE CONDITION WINDOW →
    ← Any player can also fetch here and pass the check ←
    ↓
    Deduct entry fee
    ↓
    Create pill_plays record


FIXED FLOW (with atomic claiming):
═══════════════════════════════════════════════════════════════

Fetch pill (status='available')
    ↓
    Atomically UPDATE: status='available' → 'opening'
    ↓ 
    If UPDATE succeeds: We own this pill ✓
    If UPDATE fails: Another player already owns it ✗ → REJECT
    ↓
    Deduct entry fee (only if claim succeeded)
    ↓
    Create pill_plays record
```

## Evidence Trail

```
DATABASE EVIDENCE:

Pill ID: 1bc3f6e7-116d-451d-a53f-7dca3363c408
┌─────────────────────────────────────────────────────────────┐
│                    pill_plays TABLE                          │
├──────────────────────────────────────────────────────────────┤
│ ID           │ player_id      │ locked_at        │ won │     │
├──────────────┼────────────────┼──────────────────┼─────┤     │
│ 1ec3d33f...  │ eb9b5078...    │ NULL             │ f   │ ← Abandoned
│ e09158d3...  │ a7c13796...    │ 2026-07-28...    │ t   │ ← Winner
└──────────────┼────────────────┼──────────────────┼─────┤
               │ 2 PLAYS        │ SAME PILL ID    │     │
               └────────────────┴──────────────────┴─────┘

TRANSACTION EVIDENCE:

Player A (eb9b5078):
  20:38:39  Deposit    +₦200
  20:39:02  Pill_open  -₦200  ← Charged for pill
  20:39:02  Balance    ₦0     ← No compensation

Player B (a7c13796):
  20:36:36  Deposit    +₦200
  20:36:53  Pill_open  -₦200  ← Charged for pill
  20:36:53  Bonus      +₦30   ← Referral bonus
  20:41:28  Pill_win   +₦15000 ← Won prize
  20:46:40  Pill_open  -₦200  ← 2nd pill
  20:47:53  Pill_win   +₦15000 ← 2nd win
  [... 2 more pills ...]
  Balance    ₦58,730 ← 4 pills won
```

## The Fix in One Picture

```
STATE MACHINE: Before vs After

BEFORE (BROKEN):
═════════════════════
    available
        ↓
    [fetch + charge]
        ↓
    pill_plays created
        ↓
    [answer submitted]
        ↓
    played

ISSUE: Multiple players can be between 'fetch' and 'pill_plays'


AFTER (FIXED):
═════════════════════
    available
        ↓
    [ATOMIC CLAIM: UPDATE status='opening']
        ↓
    If success: continue
    If fail: reject (another player already claimed)
        ↓
    [charge]
        ↓
    pill_plays created
        ↓
    [answer submitted]
        ↓
    played

BENEFIT: Only ONE player can be in 'opening' state
```

## Impact Summary

```
BEFORE FIX (VULNERABLE):
════════════════════════

┌─ PILL ────────────────────────────┐
│                                   │
│  Player 1 opens → not locked     │
│  Player 2 opens → not locked ✗   │  Both charged!
│  Player 1 answers → locked       │
│  Player 2 abandoned              │
│                                   │
│  Result: ₦200 lost from Player 2 │
└───────────────────────────────────┘


AFTER FIX (PROTECTED):
══════════════════════

┌─ PILL ────────────────────────────┐
│                                   │
│  Player 1 opens → claims (status) │  Only one allowed!
│  Player 2 opens → REJECTED        │  Error: being opened
│  Player 1 answers → locked        │
│                                   │
│  Result: ₦0 lost (nobody charged)│
└───────────────────────────────────┘
```

## Verification Checklist

```
BEFORE DEPLOYING:
✓ Database backup exists
✓ RPC functions ready
✓ Code changes ready
✓ Test suite passes

AFTER DEPLOYING:
□ No new duplicates (query hourly)
□ Race condition test: 2nd player rejected
□ Concurrent load test: passes
□ Production monitoring active

ROLLBACK READY:
□ Can revert code in < 5 minutes
□ Can revert DB in < 1 minute (RPC functions compatible)
□ Incident log stored
□ Players notified (if applicable)
```

## Quick Decision Tree

```
"Should we deploy the fix?"

                            ┌─ YES? Do it immediately
                            │  (Closes critical vulnerability)
                            │
Is pill.status race
condition confirmed?  ───── 
                            │
                            └─ NO? Continue investigation

Did it cause financial harm?

                            ┌─ YES? Refund affected players
                            │  (Goodwill gesture)
                            │
Is this a regression?  ─────
                            │
                            └─ NO? Document as historical

Is the fix ready?

                            ┌─ YES? Deploy immediately
                            │  (Fix prevents future incidents)
                            │
Can we test it?  ───────────
                            │
                            └─ NO? Complete setup first
```

## Key Numbers

```
┌─────────────────────────────────────────┐
│ INCIDENT METRICS                        │
├─────────────────────────────────────────┤
│ Pills in database:          205         │
│ Pills with duplicates:      1           │
│ Duplicate ratio:            0.49%       │
│                                         │
│ Financial impact:           ₦200 lost   │
│ Money fraudulently charged: ₦200        │
│ Money legitimately won:     ₦15,000     │
│                                         │
│ Players affected:           2           │
│ Charge disputes expected:   1           │
│                                         │
│ Root cause:                 Race        │
│ Regression risk:            None        │
│ Fix complexity:             Moderate    │
│ Deployment risk:            Low         │
│ Time to deploy:             ~30 min     │
│ Time to verify:             ~2 hours    │
└─────────────────────────────────────────┘
```

## One-Line Summaries

| Topic | Summary |
|-------|---------|
| **Problem** | Two players opened same pill simultaneously, both charged |
| **Cause** | Race condition between pill fetch and pill_plays creation |
| **Why** | Atomic claiming didn't exist; only UNIQUE(player, pill) existed |
| **Impact** | Player A: ₦200 lost; Player B: ₦15,000 won (correct) |
| **Regression** | No — recent Specials changes didn't touch this code |
| **Fix** | Add 'opening' state with atomic claiming via RPC |
| **Risk** | Low — backward compatible, isolated to pills |
| **Next** | Deploy database migration + code update |

---

## Files Quick Reference

```
INVESTIGATION FILES:
├── INVESTIGATION_SUMMARY.md       ← Start here (5 min read)
├── PILL_RACE_CONDITION_REPORT.md  ← Full technical report
├── FINDINGS.md                     ← Root cause deep-dive
└── INCIDENT_VISUAL_SUMMARY.md     ← This file

AUDIT SCRIPTS:
├── run_pill_audit.js              ← Verified no regression
├── pill_deep_audit.js             ← Found the duplicate
├── pill_issue_analysis.js         ← Timeline reconstruction
└── test_pill_race_fix.js          ← Verifies fix deployment

DEPLOYMENT FILES:
├── DATABASE_MIGRATION_PILL_RACE_FIX.sql  ← Run first
├── pills.js (updated)                    ← Deploy second
└── ADMIN_ACTION_ITEMS.md                 ← Deployment checklist

EVIDENCE:
└── INCIDENT_VISUAL_SUMMARY.md    ← This file with diagrams
```

---

**Status: INVESTIGATION COMPLETE, FIX READY FOR DEPLOYMENT**

All findings documented. All evidence presented. All verification tests created.
Safe to proceed with fix deployment.
