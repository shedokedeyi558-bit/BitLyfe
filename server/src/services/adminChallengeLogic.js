/**
 * adminChallengeLogic.js
 *
 * Pure game logic + resolution for Beat the Admin — best-of-N rounds.
 * No routes, no HTTP — called by route handlers.
 */

const supabase = require('../db/supabase');

// ─── RPS Resolution ───────────────────────────────────────────────────────────

const RPS_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

/**
 * resolveRPS(playerMove, adminMove) → 'player' | 'admin' | 'draw'
 */
function resolveRPS(playerMove, adminMove) {
  if (playerMove === adminMove) return 'draw';
  return RPS_BEATS[playerMove] === adminMove ? 'player' : 'admin';
}

// ─── Round Resolution ─────────────────────────────────────────────────────────

/**
 * resolveRound(matchId)
 *
 * Called when both player_move and admin_move are set on the current round row.
 * Handles draw-replay logic and majority-win detection.
 *
 * Returns:
 * {
 *   round_number:      number,
 *   round_result:      'player' | 'admin' | 'draw',
 *   player_round_wins: number,
 *   admin_round_wins:  number,
 *   current_round:     number,   // round to play next (same if draw, incremented if decisive)
 *   match_resolved:    boolean,
 *   match_winner:      'player' | 'admin' | null,
 *   match:             full admin_matches row after update
 * }
 */
async function resolveRound(matchId) {
  // Fetch full match state
  const { data: match, error: fetchErr } = await supabase
    .from('admin_matches')
    .select('id, player_id, game_type, stake, payout, status, num_rounds, player_round_wins, admin_round_wins, current_round')
    .eq('id', matchId)
    .single();

  if (fetchErr || !match) throw new Error(`Match ${matchId} not found`);
  if (match.status !== 'in_progress') return { match_resolved: true, match };

  // Fetch current round row
  const { data: round, error: roundErr } = await supabase
    .from('admin_match_rounds')
    .select('*')
    .eq('match_id', matchId)
    .eq('round_number', match.current_round)
    .single();

  if (roundErr || !round) throw new Error(`Round ${match.current_round} not found for match ${matchId}`);
  if (!round.player_move || !round.admin_move) throw new Error(`Both moves not yet submitted for round ${match.current_round}`);
  if (round.result !== null) {
    // Already resolved — idempotent, return current match state
    return { round_number: round.round_number, round_result: round.result, match_resolved: match.status === 'completed', match };
  }

  // Resolve this round
  const roundResult = resolveRPS(round.player_move, round.admin_move);
  const now = new Date().toISOString();

  // Mark round resolved
  await supabase
    .from('admin_match_rounds')
    .update({ result: roundResult, resolved_at: now })
    .eq('id', round.id);

  const majority = Math.floor(match.num_rounds / 2) + 1; // e.g. 5 rounds → 3

  if (roundResult === 'draw') {
    // Draw: same round number, clear moves so both can resubmit
    // The round row stays with result='draw', we insert a NEW row for the replay
    // with the SAME round_number so the scoreboard reflects the replay
    await supabase.from('admin_match_rounds').insert({
      match_id: matchId,
      round_number: match.current_round,
      // player_move and admin_move are null — waiting for resubmission
    });
    // Note: UNIQUE(match_id, round_number) would conflict — we need to allow multiple
    // rows per round for draw replays. We'll use a different approach:
    // Delete the old round row for this round_number and insert fresh.
    // Actually: mark old row result='draw', then upsert a fresh pending row.
    // Since UNIQUE constraint exists, we instead UPDATE the existing row to clear moves.
    await supabase
      .from('admin_match_rounds')
      .update({ player_move: null, admin_move: null, result: null, resolved_at: null })
      .eq('match_id', matchId)
      .eq('round_number', match.current_round);

    // current_round stays the same — no counter change
    return {
      round_number:       match.current_round,
      round_result:       'draw',
      player_round_wins:  match.player_round_wins,
      admin_round_wins:   match.admin_round_wins,
      current_round:      match.current_round,
      match_resolved:     false,
      match_winner:       null,
      match,
    };
  }

  // Decisive round — update win counters
  const newPlayerWins = match.player_round_wins + (roundResult === 'player' ? 1 : 0);
  const newAdminWins  = match.admin_round_wins  + (roundResult === 'admin'  ? 1 : 0);
  const matchWinner   = newPlayerWins >= majority ? 'player' : newAdminWins >= majority ? 'admin' : null;
  const matchResolved = matchWinner !== null;
  const nextRound     = matchResolved ? match.current_round : match.current_round + 1;

  // Update match counters (and optionally mark completed)
  const matchUpdate = {
    player_round_wins: newPlayerWins,
    admin_round_wins:  newAdminWins,
    current_round:     nextRound,
  };
  if (matchResolved) {
    matchUpdate.status       = 'completed';
    matchUpdate.winner       = matchWinner;
    matchUpdate.completed_at = now;
  }

  const { data: updatedMatch } = await supabase
    .from('admin_matches')
    .update(matchUpdate)
    .eq('id', matchId)
    .select()
    .single();

  // If match is over, apply payout
  if (matchResolved) {
    await _applyMatchPayout(match, matchWinner);
  }

  return {
    round_number:       match.current_round,
    round_result:       roundResult,
    player_round_wins:  newPlayerWins,
    admin_round_wins:   newAdminWins,
    current_round:      nextRound,
    match_resolved:     matchResolved,
    match_winner:       matchWinner,
    match:              updatedMatch,
  };
}

// ─── Payout / Refund ─────────────────────────────────────────────────────────

async function _applyMatchPayout(match, winner) {
  if (winner === 'player') {
    const { data: player } = await supabase.from('players').select('balance').eq('id', match.player_id).single();
    const newBalance = Number(player?.balance || 0) + match.payout;
    await supabase.from('players').update({ balance: newBalance }).eq('id', match.player_id);
    await supabase.from('transactions').insert({
      player_id:   match.player_id,
      type:        'admin_challenge_win',
      amount:      match.payout,
      description: `Beat the Admin (${match.game_type.toUpperCase()}) — won ₦${match.payout}`,
    });
  } else if (winner === 'draw') {
    // Shouldn't happen at match level (matches can't end in a draw with odd num_rounds)
    // but guard it anyway — refund stake
    const { data: player } = await supabase.from('players').select('balance').eq('id', match.player_id).single();
    await supabase.from('players').update({ balance: Number(player?.balance || 0) + match.stake }).eq('id', match.player_id);
    await supabase.from('transactions').insert({
      player_id:   match.player_id,
      type:        'admin_challenge_draw',
      amount:      match.stake,
      description: `Beat the Admin (${match.game_type.toUpperCase()}) — draw, stake refunded`,
    });
  }
  // winner === 'admin': stake already deducted at request time, nothing to credit
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * getOrCreateCurrentRound(matchId, roundNumber)
 * Returns the admin_match_rounds row for this match+round, creating it if absent.
 */
async function getOrCreateCurrentRound(matchId, roundNumber) {
  const { data: existing } = await supabase
    .from('admin_match_rounds')
    .select('*')
    .eq('match_id', matchId)
    .eq('round_number', roundNumber)
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('admin_match_rounds')
    .insert({ match_id: matchId, round_number: roundNumber })
    .select()
    .single();

  if (error) throw new Error(`Failed to create round ${roundNumber} for match ${matchId}: ${error.message}`);
  return created;
}

/**
 * buildMatchScoreboard(match) — extract scoreboard fields from a match row
 */
function buildMatchScoreboard(match) {
  return {
    num_rounds:        match.num_rounds,
    current_round:     match.current_round,
    player_round_wins: match.player_round_wins,
    admin_round_wins:  match.admin_round_wins,
  };
}

// Keep resolveMatch as a thin alias for backward compat with scheduler
// (scheduler doesn't call this for new matches, but keep it safe)
async function resolveMatch(matchId) {
  return resolveRound(matchId);
}

module.exports = { resolveRPS, resolveRound, resolveMatch, getOrCreateCurrentRound, buildMatchScoreboard };
