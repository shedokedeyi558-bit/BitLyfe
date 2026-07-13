const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');
const { createNotification } = require('./notifications');

const router = express.Router();

// ─── SHARED HELPERS ───────────────────────────────────────────────────────────

/**
 * Generate a unique pill ticket code
 */
function generatePillTicketCode() {
  return 'PLT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substr(2, 7).toUpperCase();
}

/**
 * Check and complete a referral after a qualifying action (deposit or game).
 * Call this from wallet.js (on first deposit) and any game-entry endpoint (on first game).
 *
 * actionType: 'deposit' | 'game'
 * depositAmount: only relevant when actionType = 'deposit'
 *
 * This function is idempotent — safe to call multiple times.
 */
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
    updates.first_deposit_amount = depositAmount;
  }

  if (actionType === 'game' && !referral.first_game_done) {
    updates.first_game_done = true;
  }

  if (Object.keys(updates).length === 0) return; // nothing new to update

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

/**
 * Credit referee bonus (15% of first deposit, capped ₦1,000) — credits real balance
 * Credit referrer bonus_balance += 200 (spendable on any game, winnings always real)
 * No pill ticket issued for new completions going forward.
 */
async function distributeReferralRewards(referrerId, refereeId, firstDepositAmount) {
  // ── Referee bonus: 15% of first deposit, capped ₦1,000 (real balance) ───
  const refereeBonusRaw = Math.floor(firstDepositAmount * 0.15);
  const refereeBonus = Math.min(refereeBonusRaw, 1000);

  if (refereeBonus > 0) {
    const { data: referee } = await supabase.from('players').select('balance').eq('id', refereeId).single();
    await supabase.from('players').update({ balance: (referee?.balance || 0) + refereeBonus }).eq('id', refereeId);
    await supabase.from('transactions').insert({
      player_id: refereeId,
      type: 'referral_bonus',
      amount: refereeBonus,
      description: `Referral deposit-match bonus (15% of first deposit, max ₦1,000)`,
    });
    await createNotification(refereeId, 'win', 'Referral Bonus! 🎉',
      `₦${refereeBonus.toLocaleString()} credited as a deposit-match bonus for joining via referral.`);
  }

  // ── Referrer reward: ₦200 bonus_balance (usable on any game mode) ────────
  const referrerBonus = 200;
  const { data: referrer } = await supabase
    .from('players')
    .select('bonus_balance')
    .eq('id', referrerId)
    .single();

  await supabase
    .from('players')
    .update({ bonus_balance: (referrer?.bonus_balance || 0) + referrerBonus })
    .eq('id', referrerId);

  await supabase.from('transactions').insert({
    player_id: referrerId,
    type: 'referral_bonus',
    amount: referrerBonus,
    description: `Referral reward — ₦200 bonus balance added (spendable on any game)`,
  });

  await createNotification(referrerId, 'win', 'Referral Reward! 🎁',
    `Your referral is complete! ₦${referrerBonus} bonus balance added — use it on any game mode.`);
}

/**
 * Check milestone bonuses for a referrer after a new completion.
 * Milestones: 5 completed referrals → ₦1,000 | 15 → ₦3,000
 * One-time only — guarded by referral_milestones table unique constraint.
 */
async function checkMilestoneBonuses(referrerId) {
  const { count } = await supabase
    .from('referrals')
    .select('id', { count: 'exact', head: true })
    .eq('referrer_id', referrerId)
    .eq('status', 'completed');

  const milestones = [
    { threshold: 5,  bonus: 1000 },
    { threshold: 15, bonus: 3000 },
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
        await supabase.from('players').update({ balance: (referrer?.balance || 0) + bonus }).eq('id', referrerId);
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

// Export helpers for use in wallet.js and game entry endpoints
module.exports = { router, checkReferralCompletion };

// ─── PLAYER ENDPOINTS ─────────────────────────────────────────────────────────

/**
 * GET /api/player/referrals/stats
 * Returns referral code, link, referral counts, and total earnings.
 */
router.get('/stats', auth, async (req, res) => {
  try {
    const playerId = req.player.id;

    // Fetch player's referral code
    const { data: player } = await supabase
      .from('players')
      .select('referral_code')
      .eq('id', playerId)
      .single();

    const referralCode = player?.referral_code || null;
    const referralLink = referralCode
      ? `${process.env.FRONTEND_URL || 'https://bitlyfe.app'}/signup?ref=${referralCode}`
      : null;

    // Fetch all referrals made by this player
    const { data: referrals } = await supabase
      .from('referrals')
      .select('status, completed_at')
      .eq('referrer_id', playerId);

    const pending   = (referrals || []).filter(r => r.status === 'pending').length;
    const completed = (referrals || []).filter(r => r.status === 'completed').length;

    // Total earned from referral transactions
    const { data: earningsTxns } = await supabase
      .from('transactions')
      .select('amount')
      .eq('player_id', playerId)
      .in('type', ['referral_bonus', 'referral_milestone_bonus']);

    const totalEarned = (earningsTxns || []).reduce((sum, t) => sum + (t.amount || 0), 0);

    return res.json({
      success: true,
      data: {
        referral_code: referralCode,
        referral_link: referralLink,
        referred_count: pending + completed,
        pending_count: pending,
        completed_count: completed,
        total_earned: totalEarned,
      },
    });
  } catch (err) {
    console.error('Get referral stats error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch referral stats' });
  }
});

/**
 * GET /api/player/referrals/tickets
 * Returns all active tickets for the player — both pill tickets (referral-sourced)
 * and Blitz near-miss tickets — merged into a unified shape.
 * status: "unused" in DB → "active" in response
 * code: normalised field name (from ticket_code / ticket_code)
 * type: "pill" | "blitz"
 */
router.get('/tickets', auth, async (req, res) => {
  try {
    const playerId = req.player.id;
    const now = new Date().toISOString();

    // ── Lazy-expire stale pill_tickets ───────────────────────────────────────
    const { data: stalePill } = await supabase
      .from('pill_tickets')
      .select('id')
      .eq('player_id', playerId)
      .eq('status', 'unused')
      .lte('expires_at', now);

    if (stalePill && stalePill.length > 0) {
      await supabase
        .from('pill_tickets')
        .update({ status: 'expired' })
        .in('id', stalePill.map(t => t.id));
    }

    // ── Lazy-expire stale blitz_tickets ──────────────────────────────────────
    const { data: staleBlitz } = await supabase
      .from('blitz_tickets')
      .select('id')
      .eq('player_id', playerId)
      .eq('status', 'unused')
      .lte('expires_at', now);

    if (staleBlitz && staleBlitz.length > 0) {
      await supabase
        .from('blitz_tickets')
        .update({ status: 'expired' })
        .in('id', staleBlitz.map(t => t.id));
    }

    // ── Fetch active pill tickets ─────────────────────────────────────────────
    const { data: pillTickets } = await supabase
      .from('pill_tickets')
      .select('id, ticket_code, expires_at, status')
      .eq('player_id', playerId)
      .eq('status', 'unused')
      .gt('expires_at', now)
      .order('expires_at', { ascending: true });

    // ── Fetch active blitz tickets ────────────────────────────────────────────
    const { data: blitzTickets } = await supabase
      .from('blitz_tickets')
      .select('id, ticket_code, expires_at, status')
      .eq('player_id', playerId)
      .eq('status', 'unused')
      .gt('expires_at', now)
      .order('expires_at', { ascending: true });

    // ── Merge and normalise ───────────────────────────────────────────────────
    const tickets = [
      ...(pillTickets || []).map(t => ({
        id: t.id,
        code: t.ticket_code,
        type: 'pill',
        expires_at: t.expires_at,
        status: 'active',          // unused → active in response
      })),
      ...(blitzTickets || []).map(t => ({
        id: t.id,
        code: t.ticket_code,
        type: 'blitz',
        expires_at: t.expires_at,
        status: 'active',
      })),
    ].sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));

    return res.json({
      success: true,
      data: {
        tickets,
        count: tickets.length,
      },
    });
  } catch (err) {
    console.error('Get tickets error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch tickets' });
  }
});
