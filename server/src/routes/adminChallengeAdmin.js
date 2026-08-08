/**
 * adminChallengeAdmin.js — Admin-facing routes for "Beat the Admin"
 * Mounted at /api/admin/beat-the-admin
 *
 * Endpoints:
 *   GET  /queue                          — pending non-expired requests
 *   POST /:requestId/approve             — approve, create match
 *   POST /:requestId/reject              — reject + refund
 *   POST /match/:matchId/move            — admin submits RPS move for current round
 *   GET  /match/:matchId                 — live match state + scoreboard
 *   GET  /settings                       — read settings
 *   PUT  /settings                       — update settings
 */

const express = require('express');
const supabase = require('../db/supabase');
const adminAuth = require('../middleware/adminAuth');
const { resolveRound, getOrCreateCurrentRound, buildMatchScoreboard } = require('../services/adminChallengeLogic');

const router = express.Router();
router.use(adminAuth);

// ─── GET /queue ───────────────────────────────────────────────────────────────
router.get('/queue', async (req, res) => {
  try {
    const now = new Date().toISOString();

    const { data: requests, error } = await supabase
      .from('admin_challenge_requests')
      .select('id, player_id, game_type, stake, status, requested_at, expires_at, players(phone, name)')
      .eq('status', 'pending')
      .gt('expires_at', now)
      .order('requested_at', { ascending: true });

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch queue' });

    const queue = (requests || []).map(r => ({
      id:                r.id,
      player_id:         r.player_id,
      player_phone:      r.players?.phone || null,
      player_name:       r.players?.name  || null,
      game_type:         r.game_type,
      stake:             r.stake,
      status:            r.status,
      requested_at:      r.requested_at,
      expires_at:        r.expires_at,
      seconds_remaining: Math.max(0, Math.floor((new Date(r.expires_at) - new Date()) / 1000)),
    }));

    return res.json({ success: true, data: { queue, total: queue.length } });
  } catch (err) {
    console.error('beat-the-admin/queue error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch queue' });
  }
});

// ─── POST /:requestId/approve ─────────────────────────────────────────────────
router.post('/:requestId/approve', async (req, res) => {
  try {
    const { requestId } = req.params;

    const { data: request } = await supabase
      .from('admin_challenge_requests')
      .select('id, player_id, game_type, stake, status, expires_at')
      .eq('id', requestId)
      .single();

    if (!request) return res.status(404).json({ success: false, error: 'Request not found' });
    if (request.status !== 'pending') {
      return res.status(409).json({ success: false, error: `Request status is "${request.status}" — only pending requests can be approved` });
    }
    if (new Date(request.expires_at) <= new Date()) {
      return res.status(410).json({ success: false, code: 'REQUEST_EXPIRED', error: 'Request has expired' });
    }

    const { count: inProgress } = await supabase
      .from('admin_matches')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'in_progress');

    if ((inProgress || 0) > 0) {
      return res.status(409).json({
        success: false,
        code: 'MATCH_IN_PROGRESS',
        error: 'Another match is currently in progress — complete it before approving a new request',
      });
    }

    // Snapshot num_rounds from settings at match creation time
    const { data: settings } = await supabase
      .from('admin_challenge_settings')
      .select('num_rounds')
      .eq('id', 1)
      .single();
    const numRounds = settings?.num_rounds ?? 5;

    const { data: match, error: matchErr } = await supabase
      .from('admin_matches')
      .insert({
        request_id:  request.id,
        player_id:   request.player_id,
        game_type:   request.game_type,
        stake:       request.stake,
        payout:      request.stake * 2,
        status:      'in_progress',
        num_rounds:  numRounds,
        player_round_wins: 0,
        admin_round_wins:  0,
        current_round:     1,
      })
      .select()
      .single();

    if (matchErr || !match) {
      console.error('approve match insert error:', matchErr?.message);
      return res.status(500).json({ success: false, error: 'Failed to create match' });
    }

    // Create round 1 row immediately so both sides can start writing moves
    await supabase.from('admin_match_rounds').insert({ match_id: match.id, round_number: 1 });

    await supabase
      .from('admin_challenge_requests')
      .update({ status: 'approved', match_id: match.id })
      .eq('id', request.id);

    return res.json({
      success: true,
      data: {
        match_id:   match.id,
        request_id: request.id,
        player_id:  request.player_id,
        game_type:  match.game_type,
        stake:      match.stake,
        payout:     match.payout,
        status:     match.status,
        started_at: match.started_at,
        ...buildMatchScoreboard(match),
      },
    });
  } catch (err) {
    console.error('beat-the-admin/approve error:', err);
    return res.status(500).json({ success: false, error: 'Failed to approve request' });
  }
});

// ─── POST /:requestId/reject ──────────────────────────────────────────────────
router.post('/:requestId/reject', async (req, res) => {
  try {
    const { requestId } = req.params;

    const { data: request } = await supabase
      .from('admin_challenge_requests')
      .select('id, player_id, stake, status')
      .eq('id', requestId)
      .single();

    if (!request) return res.status(404).json({ success: false, error: 'Request not found' });
    if (request.status !== 'pending') {
      return res.status(409).json({ success: false, error: `Request status is "${request.status}" — only pending requests can be rejected` });
    }

    await supabase.from('admin_challenge_requests').update({ status: 'rejected' }).eq('id', request.id);

    const { data: player } = await supabase.from('players').select('balance').eq('id', request.player_id).single();
    await supabase.from('players').update({ balance: Number(player?.balance || 0) + request.stake }).eq('id', request.player_id);

    await supabase.from('transactions').insert({
      player_id:   request.player_id,
      type:        'admin_challenge_refund',
      amount:      request.stake,
      description: 'Beat the Admin — request rejected by admin, stake refunded',
    });

    return res.json({ success: true, data: { message: 'Request rejected and stake refunded', refunded: request.stake } });
  } catch (err) {
    console.error('beat-the-admin/reject error:', err);
    return res.status(500).json({ success: false, error: 'Failed to reject request' });
  }
});

// ─── POST /match/:matchId/move ────────────────────────────────────────────────
/**
 * Body: { move }
 * Admin submits RPS move for the current round.
 *
 * Response includes full round resolution data if player has also moved.
 */
router.post('/match/:matchId/move', async (req, res) => {
  try {
    const { matchId } = req.params;
    const { move } = req.body;

    if (!['rock', 'paper', 'scissors'].includes(move)) {
      return res.status(400).json({ success: false, error: 'move must be rock, paper, or scissors' });
    }

    const { data: match } = await supabase
      .from('admin_matches')
      .select('id, status, num_rounds, current_round, player_round_wins, admin_round_wins')
      .eq('id', matchId)
      .single();

    if (!match) return res.status(404).json({ success: false, error: 'Match not found' });
    if (match.status !== 'in_progress') {
      return res.status(409).json({ success: false, code: 'MATCH_ALREADY_COMPLETED', error: 'Match is already completed' });
    }

    // Get or create current round row
    const round = await getOrCreateCurrentRound(match.id, match.current_round);

    if (round.admin_move !== null) {
      return res.status(409).json({ success: false, code: 'MOVE_ALREADY_SUBMITTED', error: 'Admin move already recorded for this round' });
    }

    // Write admin move — atomic guard
    const { error: moveErr } = await supabase
      .from('admin_match_rounds')
      .update({ admin_move: move })
      .eq('id', round.id)
      .is('admin_move', null);

    if (moveErr) {
      console.error('admin move update error:', moveErr.message);
      return res.status(500).json({ success: false, error: 'Failed to record move' });
    }

    // If player has already moved, resolve the round now
    if (round.player_move) {
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
          player_move:       round.player_move,
          admin_move:        move,
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
        message:           'Admin move recorded — waiting for player to play',
      },
    });
  } catch (err) {
    console.error('beat-the-admin/match/move error:', err);
    return res.status(500).json({ success: false, error: 'Failed to submit move' });
  }
});

// ─── GET /match/:matchId ──────────────────────────────────────────────────────
/**
 * Live match state for admin — includes full round history and scoreboard.
 */
router.get('/match/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;

    const { data: match } = await supabase
      .from('admin_matches')
      .select('id, player_id, game_type, stake, payout, status, winner, started_at, completed_at, num_rounds, current_round, player_round_wins, admin_round_wins, players(phone, name)')
      .eq('id', matchId)
      .single();

    if (!match) return res.status(404).json({ success: false, error: 'Match not found' });

    const { data: rounds } = await supabase
      .from('admin_match_rounds')
      .select('round_number, player_move, admin_move, result, resolved_at')
      .eq('match_id', matchId)
      .order('round_number', { ascending: true });

    return res.json({
      success: true,
      data: {
        match: {
          id:           match.id,
          player_id:    match.player_id,
          player_phone: match.players?.phone || null,
          player_name:  match.players?.name  || null,
          game_type:    match.game_type,
          stake:        match.stake,
          payout:       match.payout,
          status:       match.status,
          winner:       match.winner,
          started_at:   match.started_at,
          completed_at: match.completed_at,
          ...buildMatchScoreboard(match),
        },
        rounds: (rounds || []).map(r => ({
          round_number: r.round_number,
          player_move:  r.player_move,
          admin_move:   r.admin_move,
          result:       r.result,
          resolved_at:  r.resolved_at,
        })),
      },
    });
  } catch (err) {
    console.error('beat-the-admin/match error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch match' });
  }
});

// ─── GET /settings ────────────────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const { data: settings, error } = await supabase
      .from('admin_challenge_settings')
      .select('*')
      .eq('id', 1)
      .single();

    if (error || !settings) return res.status(500).json({ success: false, error: 'Settings not found' });
    console.log(`[beat-the-admin/settings GET] read:`, JSON.stringify({ id: settings.id, is_available: settings.is_available, num_rounds: settings.num_rounds }));
    return res.json({ success: true, data: { settings } });
  } catch (err) {
    console.error('beat-the-admin/GET settings error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

// ─── PUT /settings ────────────────────────────────────────────────────────────
router.put('/settings', async (req, res) => {
  try {
    const { max_stake, min_stake, is_available, request_expiry_seconds, num_rounds } = req.body;
    const updates = {};

    if (max_stake !== undefined) {
      const v = Number(max_stake);
      if (isNaN(v) || v < 1) return res.status(400).json({ success: false, error: 'max_stake must be a positive integer' });
      updates.max_stake = v;
    }
    if (min_stake !== undefined) {
      const v = Number(min_stake);
      if (isNaN(v) || v < 1) return res.status(400).json({ success: false, error: 'min_stake must be a positive integer' });
      updates.min_stake = v;
    }
    if (is_available !== undefined) {
      updates.is_available = is_available === true || is_available === 'true';
    }
    if (request_expiry_seconds !== undefined) {
      const v = Number(request_expiry_seconds);
      if (isNaN(v) || v < 10) return res.status(400).json({ success: false, error: 'request_expiry_seconds must be >= 10' });
      updates.request_expiry_seconds = v;
    }
    if (num_rounds !== undefined) {
      const v = Math.floor(Number(num_rounds));
      if (isNaN(v) || v < 1) return res.status(400).json({ success: false, error: 'num_rounds must be a positive integer' });
      if (v % 2 === 0) return res.status(400).json({ success: false, error: 'num_rounds must be odd (e.g. 3, 5, 7) so there is always a decisive majority winner' });
      updates.num_rounds = v;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    if (updates.min_stake !== undefined || updates.max_stake !== undefined) {
      const { data: current } = await supabase.from('admin_challenge_settings').select('min_stake, max_stake').eq('id', 1).single();
      const effectiveMin = updates.min_stake ?? current?.min_stake ?? 0;
      const effectiveMax = updates.max_stake ?? current?.max_stake ?? 0;
      if (effectiveMin > effectiveMax) {
        return res.status(400).json({ success: false, error: 'min_stake cannot exceed max_stake' });
      }
    }

    const { data: updated, error } = await supabase
      .from('admin_challenge_settings')
      .update(updates)
      .eq('id', 1)
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: 'Failed to update settings' });

    console.log(`[beat-the-admin/settings PUT] wrote:`, JSON.stringify(updates));
    console.log(`[beat-the-admin/settings PUT] persisted:`, JSON.stringify({ id: updated.id, is_available: updated.is_available, num_rounds: updated.num_rounds, min_stake: updated.min_stake, max_stake: updated.max_stake }));

    return res.json({ success: true, data: { settings: updated } });
  } catch (err) {
    console.error('beat-the-admin/settings error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

module.exports = router;
