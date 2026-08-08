/**
 * adminChallenge.js — Player-facing routes for "Beat the Admin"
 * Mounted at /api/admin-challenge
 *
 * Endpoints:
 *   GET  /api/admin-challenge/status       — feature availability + current lock state
 *   POST /api/admin-challenge/request      — submit a challenge request (deducts stake)
 *   GET  /api/admin-challenge/my-request   — poll own pending/approved request + live scoreboard
 *   POST /api/admin-challenge/move         — submit RPS move for current round
 *   GET  /api/admin-challenge/history      — past requests/matches
 */

const express = require('express');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');
const { deductEntryFee } = require('../services/billing');
const { resolveRound, getOrCreateCurrentRound, buildMatchScoreboard } = require('../services/adminChallengeLogic');

const router = express.Router();

// ─── GET /status ──────────────────────────────────────────────────────────────
router.get('/status', auth, async (req, res) => {
  try {
    const { data: settings } = await supabase
      .from('admin_challenge_settings')
      .select('is_available, min_stake, max_stake, num_rounds')
      .eq('id', 1)
      .single();

    if (!settings) return res.status(500).json({ success: false, error: 'Settings not configured' });

    const { count: inProgressCount } = await supabase
      .from('admin_matches')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'in_progress');

    return res.json({
      success: true,
      data: {
        is_available:      settings.is_available,
        match_in_progress: (inProgressCount || 0) > 0,
        min_stake:         settings.min_stake,
        max_stake:         settings.max_stake,
        num_rounds:        settings.num_rounds,
      },
    });
  } catch (err) {
    console.error('admin-challenge/status error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch status' });
  }
});

// ─── POST /request ────────────────────────────────────────────────────────────
router.post('/request', auth, async (req, res) => {
  try {
    const { game_type, stake } = req.body;
    const player = req.player;

    if (!game_type || game_type !== 'rps') {
      return res.status(400).json({ success: false, error: 'game_type must be "rps"' });
    }
    const stakeNum = Math.floor(Number(stake));
    if (!stake || isNaN(stakeNum) || stakeNum <= 0) {
      return res.status(400).json({ success: false, error: 'stake must be a positive integer' });
    }

    const { data: settings } = await supabase
      .from('admin_challenge_settings')
      .select('is_available, min_stake, max_stake, request_expiry_seconds, num_rounds')
      .eq('id', 1)
      .single();

    if (!settings) return res.status(500).json({ success: false, error: 'Settings not configured' });

    if (!settings.is_available) {
      return res.status(503).json({ success: false, code: 'FEATURE_UNAVAILABLE', error: 'Beat the Admin is not available right now' });
    }
    if (stakeNum < settings.min_stake || stakeNum > settings.max_stake) {
      return res.status(400).json({
        success: false,
        code: 'STAKE_OUT_OF_RANGE',
        error: `Stake must be between ₦${settings.min_stake} and ₦${settings.max_stake}`,
      });
    }

    const { count: inProgressCount } = await supabase
      .from('admin_matches')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'in_progress');

    if ((inProgressCount || 0) > 0) {
      return res.status(409).json({
        success: false,
        code: 'MATCH_IN_PROGRESS',
        error: 'A match is currently in progress. Please wait for it to complete.',
      });
    }

    const { data: existingRequest } = await supabase
      .from('admin_challenge_requests')
      .select('id, status')
      .eq('player_id', player.id)
      .in('status', ['pending', 'approved'])
      .maybeSingle();

    if (existingRequest) {
      return res.status(409).json({
        success: false,
        code: 'ALREADY_REQUESTED',
        error: 'You already have an active challenge request',
      });
    }

    let billing;
    try {
      billing = await deductEntryFee(player.id, stakeNum, {
        type: 'admin_challenge_entry',
        description: `Beat the Admin (${game_type.toUpperCase()}) — stake ₦${stakeNum}`,
      });
    } catch (billingErr) {
      if (billingErr.insufficientFunds) {
        return res.status(402).json({ success: false, error: billingErr.message });
      }
      throw billingErr;
    }

    const expiresAt = new Date(Date.now() + settings.request_expiry_seconds * 1000).toISOString();

    const { data: request, error: insertErr } = await supabase
      .from('admin_challenge_requests')
      .insert({ player_id: player.id, game_type, stake: stakeNum, status: 'pending', expires_at: expiresAt })
      .select()
      .single();

    if (insertErr || !request) {
      // Refund stake on failure
      const { data: fp } = await supabase.from('players').select('balance').eq('id', player.id).single();
      await supabase.from('players').update({ balance: (fp?.balance || 0) + stakeNum }).eq('id', player.id);
      await supabase.from('transactions').insert({
        player_id: player.id, type: 'admin_challenge_refund', amount: stakeNum,
        description: 'Beat the Admin — refund (request insert failed)',
      });
      return res.status(500).json({ success: false, error: 'Failed to create request' });
    }

    return res.status(201).json({
      success: true,
      data: {
        request_id:       request.id,
        game_type:        request.game_type,
        stake:            request.stake,
        status:           request.status,
        expires_at:       request.expires_at,
        new_balance:      billing.newBalance,
        new_bonus_balance:billing.newBonusBalance,
      },
    });
  } catch (err) {
    console.error('admin-challenge/request error:', err);
    return res.status(500).json({ success: false, error: 'Failed to submit request' });
  }
});

// ─── GET /my-request ──────────────────────────────────────────────────────────
router.get('/my-request', auth, async (req, res) => {
  try {
    const player = req.player;

    const { data: request } = await supabase
      .from('admin_challenge_requests')
      .select('id, game_type, stake, status, requested_at, expires_at, match_id')
      .eq('player_id', player.id)
      .in('status', ['pending', 'approved'])
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!request) return res.json({ success: true, data: { request: null } });

    const timeRemainingSeconds = Math.max(
      0,
      Math.floor((new Date(request.expires_at) - new Date()) / 1000)
    );

    let match = null;
    if (request.match_id) {
      const { data: matchRow } = await supabase
        .from('admin_matches')
        .select('id, game_type, stake, payout, status, winner, started_at, completed_at, num_rounds, current_round, player_round_wins, admin_round_wins')
        .eq('id', request.match_id)
        .single();

      if (matchRow) {
        // Fetch current round for player's own move status (never expose admin_move)
        const { data: currentRoundRow } = await supabase
          .from('admin_match_rounds')
          .select('round_number, player_move, result')
          .eq('match_id', matchRow.id)
          .eq('round_number', matchRow.current_round)
          .maybeSingle();

        match = {
          match_id:          matchRow.id,
          status:            matchRow.status,
          winner:            matchRow.winner,
          payout:            matchRow.winner === 'player' ? matchRow.payout : matchRow.winner === 'draw' ? matchRow.stake : 0,
          started_at:        matchRow.started_at,
          completed_at:      matchRow.completed_at,
          ...buildMatchScoreboard(matchRow),
          // Current round state — player_move shown so they know if they already played
          current_round_move_submitted: !!(currentRoundRow?.player_move),
        };
      }
    }

    return res.json({
      success: true,
      data: {
        request: {
          id:                    request.id,
          game_type:             request.game_type,
          stake:                 request.stake,
          status:                request.status,
          expires_at:            request.expires_at,
          time_remaining_seconds:timeRemainingSeconds,
        },
        match,
      },
    });
  } catch (err) {
    console.error('admin-challenge/my-request error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch request' });
  }
});

// ─── POST /move ───────────────────────────────────────────────────────────────
/**
 * Body: { requestId, move }
 * Writes player_move to the current round row.
 * If admin_move already set for this round, triggers resolveRound.
 *
 * Response:
 * {
 *   move_recorded: true,
 *   round_number, player_round_wins, admin_round_wins, current_round, num_rounds,
 *   round_result: 'player'|'admin'|'draw'|null,  // null if waiting for admin
 *   match_resolved: bool,
 *   match_winner: 'player'|'admin'|null,
 * }
 */
router.post('/move', auth, async (req, res) => {
  try {
    const { requestId, move } = req.body;
    const player = req.player;

    if (!requestId) return res.status(400).json({ success: false, error: 'requestId is required' });
    if (!['rock', 'paper', 'scissors'].includes(move)) {
      return res.status(400).json({ success: false, error: 'move must be rock, paper, or scissors' });
    }

    const { data: request } = await supabase
      .from('admin_challenge_requests')
      .select('id, player_id, match_id, status')
      .eq('id', requestId)
      .eq('player_id', player.id)
      .single();

    if (!request) return res.status(404).json({ success: false, error: 'Request not found' });
    if (request.status !== 'approved') {
      return res.status(409).json({
        success: false,
        code: 'REQUEST_NOT_APPROVED',
        error: `Request status is "${request.status}" — can only submit move when approved`,
      });
    }
    if (!request.match_id) {
      return res.status(409).json({ success: false, error: 'No match associated with this request' });
    }

    const { data: match } = await supabase
      .from('admin_matches')
      .select('id, status, num_rounds, current_round, player_round_wins, admin_round_wins')
      .eq('id', request.match_id)
      .single();

    if (!match) return res.status(404).json({ success: false, error: 'Match not found' });
    if (match.status !== 'in_progress') {
      return res.status(409).json({ success: false, code: 'MATCH_ALREADY_COMPLETED', error: 'Match is already completed' });
    }

    // Get or create current round row
    const round = await getOrCreateCurrentRound(match.id, match.current_round);

    if (round.player_move !== null) {
      return res.status(409).json({ success: false, code: 'MOVE_ALREADY_SUBMITTED', error: 'You have already submitted your move for this round' });
    }

    // Write player move — atomic guard with .is('player_move', null)
    const { error: moveErr } = await supabase
      .from('admin_match_rounds')
      .update({ player_move: move })
      .eq('id', round.id)
      .is('player_move', null);

    if (moveErr) {
      console.error('admin-challenge/move update error:', moveErr.message);
      return res.status(500).json({ success: false, error: 'Failed to record move' });
    }

    // If admin has also moved for this round, resolve it now
    if (round.admin_move) {
      const resolution = await resolveRound(match.id);
      return res.json({
        success: true,
        data: {
          move_recorded:     true,
          round_number:      resolution.round_number,
          round_result:      resolution.round_result,
          player_round_wins: resolution.player_round_wins,
          admin_round_wins:  resolution.admin_round_wins,
          current_round:     resolution.current_round,
          num_rounds:        match.num_rounds,
          match_resolved:    resolution.match_resolved,
          match_winner:      resolution.match_winner,
          // Only reveal admin move after round resolves
          admin_move:        round.admin_move,
          player_move:       move,
        },
      });
    }

    return res.json({
      success: true,
      data: {
        move_recorded:     true,
        round_number:      match.current_round,
        round_result:      null,
        player_round_wins: match.player_round_wins,
        admin_round_wins:  match.admin_round_wins,
        current_round:     match.current_round,
        num_rounds:        match.num_rounds,
        match_resolved:    false,
        match_winner:      null,
        message:           'Move recorded — waiting for admin to play',
      },
    });
  } catch (err) {
    console.error('admin-challenge/move error:', err);
    return res.status(500).json({ success: false, error: 'Failed to submit move' });
  }
});

// ─── GET /history ─────────────────────────────────────────────────────────────
router.get('/history', auth, async (req, res) => {
  try {
    const player = req.player;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const { data: requests, count, error } = await supabase
      .from('admin_challenge_requests')
      .select('id, game_type, stake, status, requested_at, expires_at, match_id', { count: 'exact' })
      .eq('player_id', player.id)
      .order('requested_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch history' });

    const matchIds = (requests || []).filter(r => r.match_id).map(r => r.match_id);
    let matchMap = {};
    if (matchIds.length > 0) {
      const { data: matches } = await supabase
        .from('admin_matches')
        .select('id, game_type, stake, payout, status, winner, started_at, completed_at, num_rounds, player_round_wins, admin_round_wins')
        .in('id', matchIds);
      for (const m of matches || []) matchMap[m.id] = m;
    }

    const history = (requests || []).map(r => {
      const m = r.match_id ? (matchMap[r.match_id] || null) : null;
      return {
        request_id:     r.id,
        game_type:      r.game_type,
        stake:          r.stake,
        request_status: r.status,
        requested_at:   r.requested_at,
        expires_at:     r.expires_at,
        match: m ? {
          match_id:          m.id,
          status:            m.status,
          winner:            m.winner,
          payout:            m.winner === 'player' ? m.payout : m.winner === 'draw' ? m.stake : 0,
          num_rounds:        m.num_rounds,
          player_round_wins: m.player_round_wins,
          admin_round_wins:  m.admin_round_wins,
          started_at:        m.started_at,
          completed_at:      m.completed_at,
        } : null,
      };
    });

    return res.json({ success: true, data: { history, total: count || 0, page, limit } });
  } catch (err) {
    console.error('admin-challenge/history error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch history' });
  }
});

module.exports = router;
