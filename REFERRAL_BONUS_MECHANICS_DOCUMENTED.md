# Referral Bonus Mechanics — Complete Real Implementation

**Date**: 2026-07-30  
**Status**: Fully documented with code citations

---

## Executive Summary

**Referee Gets**: ₦0 on signup + 15% of first deposit (max ₦1,000 as **real balance**, credited on first deposit)  
**Referrer Gets**: ₦200 flat **bonus_balance** (credited when referee completes referral: first deposit + first game played)

**Key Distinction**:
- Referee bonus is **real balance** (real money, withdrawable)
- Referrer bonus is **bonus_balance** (spendable on games only, NOT withdrawable)

---

## 1. NEW PLAYER SIGNUP WITH REFERRAL

### When a new player signs up using a referral code

**File**: `server/src/routes/auth.js`  
**Endpoint**: `POST /api/auth/signup`  
**Lines**: 193–376

**Referral Parameter**:
```javascript
const refCode = req.query.ref || req.body.ref || null;  // Line 200
```

**What happens**:

#### Step 1: Resolve the referrer (lines 252–260)
```javascript
let referrerId = null;
if (refCode) {
  const { data: referrer } = await supabase
    .from('players')
    .select('id')
    .eq('referral_code', refCode.trim().toUpperCase())
    .maybeSingle();
  if (referrer) referrerId = referrer.id;
  // Invalid codes are silently ignored — don't block signup
}
```

**Behavior**: If referral code is valid, store referrer's player ID. Invalid codes are silently ignored and don't prevent signup.

#### Step 2: New player created with "new_user_bonus" (lines 265–290)
```javascript
const { data: settings } = await supabase
  .from('app_settings')
  .select('new_user_bonus')
  .eq('id', 1)
  .single();

const newUserBonus = settings?.new_user_bonus ?? 0;

// Generate unique referral code for this new player
const newReferralCode = await generateReferralCode();

// Step 1: Insert new player
const { data: inserted, error: insertErr } = await supabase
  .from('players')
  .insert({
    email: normalizedEmail,
    password_hash: passwordHash,
    phone: normalizedPhone,
    name: name || null,
    balance: newUserBonus,  // ← Only gets new_user_bonus (default 0)
    is_admin: false,
    referral_code: newReferralCode,
  });
```

**Behavior**: 
- New player starts with `balance = new_user_bonus` (default 0)
- A unique 6-char `referral_code` is generated and assigned to them
- **No referral bonus is credited at signup** — only new_user_bonus (which is 0 by default)

#### Step 3: Referral relationship created (lines 331–338)
```javascript
if (referrerId) {
  await supabase.from('referrals').insert({
    referrer_id: referrerId,
    referee_id: player.id,
    status: 'pending',
    first_deposit_done: false,
    first_game_done: false,
    first_deposit_amount: 0,
  });
}
```

**Behavior**: If a valid referrer was found, a row is inserted in the `referrals` table with:
- `status: 'pending'` — waiting for referral completion conditions
- `first_deposit_done: false` — watching for referee's first deposit
- `first_game_done: false` — watching for referee's first game

---

## 2. REFEREE'S FIRST DEPOSIT

### When the REFEREE makes their first deposit

**File**: `server/src/routes/wallet.js`  
**Function**: Deposit completion webhook handler  
**Line**: 352

```javascript
// Trigger referral first-deposit check (fire-and-forget)
checkReferralCompletion(player.id, 'deposit', amountNaira).catch(() => {});
```

**Flow**:

**File**: `server/src/routes/referrals.js`  
**Function**: `checkReferralCompletion(refereeId, actionType, depositAmount)`  
**Lines**: 27–72

```javascript
async function checkReferralCompletion(refereeId, actionType, depositAmount = 0) {
  // Fetch the pending referral for this referee
  const { data: referral } = await supabase
    .from('referrals')
    .select('*')
    .eq('referee_id', refereeId)
    .eq('status', 'pending')
    .maybeSingle();

  if (!referral) return; // no pending referral for this player

  const updates = {};

  if (actionType === 'deposit' && !referral.first_deposit_done) {
    updates.first_deposit_done = true;
    updates.first_deposit_amount = depositAmount;  // ← Store the deposit amount
  }

  if (actionType === 'game' && !referral.first_game_done) {
    updates.first_game_done = true;
  }

  // Apply the flag update
  const updatedDepositDone   = updates.first_deposit_done   ?? referral.first_deposit_done;
  const updatedGameDone      = updates.first_game_done      ?? referral.first_game_done;
  const updatedDepositAmount = updates.first_deposit_amount ?? referral.first_deposit_amount;

  await supabase
    .from('referrals')
    .update(updates)
    .eq('id', referral.id);

  // Both conditions met → complete the referral
  if (updatedDepositDone && updatedGameDone) {
    await supabase
      .from('referrals')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', referral.id);

    await distributeReferralRewards(referral.referrer_id, refereeId, updatedDepositAmount);
    await checkMilestoneBonuses(referral.referrer_id);
  }
}
```

**Behavior**:
- Marks `first_deposit_done = true`
- Stores the deposit amount
- **Does NOT immediately distribute rewards**
- Rewards only distributed when BOTH conditions are met: first deposit + first game played

---

## 3. REFEREE'S FIRST GAME PLAY

### When the REFEREE plays their first game

**Trigger**: Any game-entry endpoint calls `checkReferralCompletion(playerId, 'game')`

**Same logic as deposit**: Marks `first_game_done = true`.

When both `first_deposit_done` and `first_game_done` are true, the referral is marked as `status: 'completed'` and rewards are distributed.

---

## 4. REWARD DISTRIBUTION

### When referral is completed (first deposit + first game both done)

**File**: `server/src/routes/referrals.js`  
**Function**: `distributeReferralRewards(referrerId, refereeId, firstDepositAmount)`  
**Lines**: 78–119

#### REFEREE BONUS (Real Balance)

**File**: `server/src/routes/referrals.js`  
**Lines**: 80–95

```javascript
// ── Referee bonus: 15% of first deposit, capped ₦1,000 (real balance) ───
const refereeBonusRaw = Math.floor(firstDepositAmount * 0.15);  // ← 15% calculation
const refereeBonus = Math.min(refereeBonusRaw, 1000);  // ← Capped at ₦1,000

if (refereeBonus > 0) {
  const { data: referee } = await supabase.from('players').select('balance').eq('id', refereeId).single();
  await supabase.from('players').update({ balance: (referee?.balance || 0) + refereeBonus }).eq('id', refereeId);  // ← UPDATE players.balance
  await supabase.from('transactions').insert({
    player_id: refereeId,
    type: 'referral_bonus',
    amount: refereeBonus,
    description: `Referral deposit-match bonus (15% of first deposit, max ₦1,000)`,
  });
  await createNotification(refereeId, 'win', 'Referral Bonus! 🎉',
    `₦${refereeBonus.toLocaleString()} credited as a deposit-match bonus for joining via referral.`);
}
```

**What's credited**:
- **Amount**: `15% of first deposit, capped at ₦1,000`
- **Type**: Real balance (same pool as deposits, withdrawable)
- **When**: On referral completion (first deposit + first game played)
- **Transaction type**: `referral_bonus`

**Example**:
- Referee deposits ₦5,000 → bonus = `floor(5000 * 0.15)` = `₦750` credited to real balance
- Referee deposits ₦10,000 → bonus = `floor(10000 * 0.15)` = `₦1,500`, capped to `₦1,000` credited

#### REFERRER BONUS (Bonus Balance)

**File**: `server/src/routes/referrals.js`  
**Lines**: 97–119

```javascript
// ── Referrer reward: ₦200 bonus_balance (usable on any game mode) ────────
const referrerBonus = 200;  // ← Flat ₦200 (NOT a percentage)
const { data: referrer } = await supabase
  .from('players')
  .select('bonus_balance')
  .eq('id', referrerId)
  .single();

await supabase
  .from('players')
  .update({ bonus_balance: (referrer?.bonus_balance || 0) + referrerBonus })  // ← UPDATE players.bonus_balance
  .eq('id', referrerId);

await supabase.from('transactions').insert({
  player_id: referrerId,
  type: 'referral_bonus',
  amount: referrerBonus,
  description: `Referral reward — ₦200 bonus balance added (spendable on any game)`,
});

await createNotification(referrerId, 'win', 'Referral Reward! 🎁',
  `Your referral is complete! ₦${referrerBonus} bonus balance added — use it on any game mode.`);
```

**What's credited**:
- **Amount**: **₦200 flat** (not a percentage, always exactly 200)
- **Type**: bonus_balance (only usable for game entries, NOT withdrawable)
- **When**: On referral completion (referee's first deposit + first game)
- **Transaction type**: `referral_bonus`

---

## 5. MILESTONE BONUSES

### Referrer milestone rewards

**File**: `server/src/routes/referrals.js`  
**Function**: `checkMilestoneBonuses(referrerId)`  
**Lines**: 121–162

```javascript
async function checkMilestoneBonuses(referrerId) {
  const { count } = await supabase
    .from('referrals')
    .select('id', { count: 'exact', head: true })
    .eq('referrer_id', referrerId)
    .eq('status', 'completed');  // ← Count completed referrals

  const milestones = [
    { threshold: 5,  bonus: 1000 },   // ← 5 referrals → ₦1,000 real balance
    { threshold: 15, bonus: 3000 },   // ← 15 referrals → ₦3,000 real balance
  ];

  for (const { threshold, bonus } of milestones) {
    if ((count || 0) >= threshold) {
      // Attempt insert — unique constraint (player_id, milestone) prevents duplicates
      const { error } = await supabase
        .from('referral_milestones')
        .insert({ player_id: referrerId, milestone: threshold });

      if (!error) {
        // Insert succeeded → first time hitting this milestone
        const { data: referrer } = await supabase.from('players').select('balance').eq('id', referrerId).single();
        await supabase.from('players').update({ balance: (referrer?.balance || 0) + bonus }).eq('id', referrerId);  // ← UPDATE players.balance (real)
        await supabase.from('transactions').insert({
          player_id: referrerId,
          type: 'referral_milestone_bonus',
          amount: bonus,
          description: `Referral milestone bonus — ${threshold} completed referrals`,
        });
        await createNotification(referrerId, 'win', `Referral Milestone! 🏆`,
          `You've completed ${threshold} referrals! ₦${bonus.toLocaleString()} bonus credited.`);
      }
      // If error (duplicate) — milestone already credited, skip silently
    }
  }
}
```

**Thresholds**:
- 5 completed referrals → ₦1,000 **real balance**
- 15 completed referrals → ₦3,000 **real balance**

**Mechanics**:
- One-time per milestone (guarded by unique constraint on `referral_milestones` table)
- Credits to **real balance** (withdrawable)
- Checked automatically after each referral completion

---

## 6. Search Results: Is There Any 30% Calculation?

**Search Results**: ✗ **NO**

Searched for `0.3`, `30`, `percent.*deposit`, `deposit.*percent` across all JavaScript files.

**Results**:
- `0.3` found only in Blitz prize distribution (50/30/20 split for positions 1/2/3) — NOT referral related
- `30` found in timer defaults, analytics date ranges, JWT expiry times — NOT referral related
- No 30% calculation anywhere tied to referrals or deposits

**Conclusion**: The only percentage in referral is **15%** (referee bonus). There is no 30% feature anywhere in the codebase.

---

## 7. COMPLETE bonus_balance UPDATE TRACE

### All places that UPDATE players.bonus_balance for referral reasons:

| File | Line | Function | Trigger | Amount | Recipient | Notes |
|---|---|---|---|---|---|---|
| `server/src/routes/referrals.js` | 107 | `distributeReferralRewards` | Referral completed | +₦200 | Referrer | Bonus balance, usable on games |
| — | — | — | — | — | — | — |

**That's it.** Only one code path updates `bonus_balance` for referral purposes: when a referral is completed, the referrer gets +₦200 bonus_balance.

### All places that UPDATE players.balance for referral reasons:

| File | Line | Function | Trigger | Amount | Recipient | Notes |
|---|---|---|---|---|---|---|
| `server/src/routes/referrals.js` | 85 | `distributeReferralRewards` | Referral completed | +15% deposit (max ₦1,000) | Referee | Real balance, withdrawable |
| `server/src/routes/referrals.js` | 145 | `checkMilestoneBonuses` | Reach 5 completed referrals | +₦1,000 | Referrer | Real balance, withdrawable |
| `server/src/routes/referrals.js` | 145 | `checkMilestoneBonuses` | Reach 15 completed referrals | +₦3,000 | Referrer | Real balance, withdrawable |

---

## 8. SCHEMA: referrals Table

**File**: `server/src/db/schema.sql`  
**Columns** (relevant):
- `id` (UUID, Primary Key)
- `referrer_id` (UUID, REFERENCES players)
- `referee_id` (UUID, REFERENCES players, UNIQUE per referee)
- `status` (TEXT CHECK: 'pending' | 'completed')
- `first_deposit_done` (BOOLEAN, default false)
- `first_game_done` (BOOLEAN, default false)
- `first_deposit_amount` (INTEGER, default 0) — stores first deposit for bonus calculation
- `created_at` (TIMESTAMP)
- `completed_at` (TIMESTAMP)

---

## 9. SUMMARY TABLE: Before → After

| Aspect | Referee | Referrer |
|---|---|---|
| **On Signup** | ₦0 (new_user_bonus default 0) | — |
| **On First Deposit** | Referral marked: first_deposit_done=true, deposit amount stored | Referral marked pending |
| **On First Game** | Referral marked: first_game_done=true | Referral marked pending |
| **On Referral Completion** | +15% of first deposit (max ₦1,000) to **real balance** | +₦200 to **bonus_balance** |
| **On 5 Referrals Completed** | — | +₦1,000 to **real balance** |
| **On 15 Referrals Completed** | — | +₦3,000 to **real balance** |

---

## Code Citation Summary

| Topic | File | Lines |
|---|---|---|
| Signup + referral code resolution | `server/src/routes/auth.js` | 193–376 |
| Referral creation on signup | `server/src/routes/auth.js` | 331–338 |
| First deposit trigger | `server/src/routes/wallet.js` | 352 |
| Referral completion logic | `server/src/routes/referrals.js` | 27–72 |
| Referee bonus (15% real balance) | `server/src/routes/referrals.js` | 80–95 |
| Referrer bonus (₦200 bonus_balance) | `server/src/routes/referrals.js` | 97–119 |
| Milestone bonuses | `server/src/routes/referrals.js` | 121–162 |
| referrals table schema | `server/src/db/schema.sql` | Lines with "referrals" table |

---

## Key Findings

1. **No 30% anywhere** — only 15% for referee deposit match
2. **₦200 is flat, never a percentage** — always exactly 200
3. **Bonus_balance is non-withdrawable** — referrer bonus is game-only
4. **Real balance is withdrawable** — referee bonus, milestone bonuses
5. **Referral completion requires TWO actions**: first deposit + first game
6. **Milestones are one-time each**: 5 referrals, 15 referrals
7. **Invalid referral codes don't block signup** — silently ignored

