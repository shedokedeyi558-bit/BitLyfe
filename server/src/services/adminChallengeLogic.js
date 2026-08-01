/**
 * adminChallengeLogic.js
 *
 * Pure game logic + resolution for Beat the Admin.
 * No routes, no HTTP — called by route handlers and the scheduler.
 */

const supabase = require('../db/supabase');
const { deductEntryFee, refundEntryFee } = require('./billing');

// ─── RPS Resolution ───────────────────────────────────────────────────────────

const RPS_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

/**
 * resolveRPS(playerMove, adminMove) → 'player' | 'admin' | 'draw'
 * Standard RPS rules.
 */
function resolveRPS(playerMove, adminMove) {
  if (playerMove === adminMove) return 'draw';
  return RPS_BEATS[playerMove] === adminMove ? 'player' : 'admin';
}

// ─── Match Resolution ─────────────────────────────────────────────────────────

/**
 * resolveMatch(matchId)
 *
 * Called once both player_move and admin_move are set on an admin_matches row.
 * Idempotent guard: checks status === 'in_progress' before doing anything.
 *
 * Outcomes:
 *   winner='player' → credit payout (stake * 2) to player's real balance
 *   winner='admin'  → stake already deducted at request time, nothing more to do
 *   winner='draw'   → refund full stake to player's real balance
 *
 * Returns the updated match row.
 */
async function resolveMatch(matchId) {
  // Fetch match — include player_id and stake for payout/refund
  const { data: match, error: fetchErr } = await supabase
    .from('admin_matches')
    .select('id, player_id, game_type, stake, payout, player_move, admin_move, status')
    .eq('id', matchId)
    .single();

  if (fetchErr || !match) throw new Error(`Match ${matchId} not found`);
  if (match.status !== 'in_progress') {
    // Already resolved — return current state, don't re-process
    return match;
  }
  if (!match.player_move || !match.admin_move) {
    throw new Error(`Cannot resolve match ${matchId}: both moves not yet submitted`);
  }

  // Determine winner
  let winner;
  if (match.game_type === 'rps') {
    winner = resolveRPS(match.player_move, match.admin_move);
  } else {
    throw new Error(`Unknown game_type: ${match.game_type}`);
  }

  const completedAt = new Date().toISOString();

  // Mark match completed — use .eq('status','in_progress') as idempotency guard
  const { error: updateErr } = await supabase
    .from('admin_matches')
    .update({ status: 'completed', winner, completed_at: completedAt })
    .eq('id', matchId)
    .eq('status', 'in_progress');

  if (updateErr) throw new Error(`Failed to update match status: ${updateErr.message}`);

  // Apply payout / refund
  if (winner === 'player') {
    // Credit payout (stake * 2) to real balance
    const { data: player } = await supabase
      .from('players')
      .select('balance')
      .eq('id', match.player_id)
      .single();

    const newBalance = Number(player?.balance || 0) + match.payout;
    await supabase.from('players').update({ balance: newBalance }).eq('id', match.player_id);

    await supabase.from('transactions').insert({
      player_id: match.player_id,
      type: 'admin_challenge_win',
      amount: match.payout,
      description: `Beat the Admin (${match.game_type.toUpperCase()}) — won ₦${match.payout}`,
    });
  } else if (winner === 'draw') {
    // Refund stake to real balance
    const { data: player } = await supabase
      .from('players')
      .select('balance')
      .eq('id', match.player_id)
      .single();

    const newBalance = Number(player?.balance || 0) + match.stake;
    await supabase.from('players').update({ balance: newBalance }).eq('id', match.player_id);

    await supabase.from('transactions').insert({
      player_id: match.player_id,
      type: 'admin_challenge_draw',
      amount: match.stake,
      description: `Beat the Admin (${match.game_type.toUpperCase()}) — draw, stake refunded`,
    });
  }
  // winner === 'admin': stake already deducted, nothing to do

  return { ...match, status: 'completed', winner, completed_at: completedAt };
}

module.exports = { resolveRPS, resolveMatch };
