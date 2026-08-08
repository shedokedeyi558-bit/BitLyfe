/**
 * adminChallengeAdmin.js — Admin-facing routes for "Beat the Admin"
 * Mounted at /api/admin/beat-the-admin
 *
 * All routes require adminAuth.
 *
 * Endpoints:
 *   GET  /api/admin/beat-the-admin/queue                          — pending non-expired requests
 *   POST /api/admin/beat-the-admin/:requestId/approve             — approve a request, create match
 *   POST /api/admin/beat-the-admin/:requestId/reject              — reject + refund
 *   POST /api/admin/beat-the-admin/match/:matchId/move            — admin submits RPS move
 *   PUT  /api/admin/beat-the-admin/settings                       — update settings
 */

const express = require('express');
const supabase = require('../db/supabase');
const adminAuth = require('../middleware/adminAuth');
const { resolveMatch } = require('../services/adminChallengeLogic');

const router = express.Router();
router.use(adminAuth);

// ─── GET /queue ───────────────────────────────────────────────────────────────
/**
 * Returns pending, non-expired requests ordered by requested_at ASC (oldest first).
 * Includes basic player info for display.
 */
router.get('/queue', async (req, res) => {
  try {
    const now = new Date().toISOString();

    const { data: requests, error } = await supabase
      .from('admin_challenge_requests')
      .select('id, player_id, game_type, stake, status, requested_at, expires_at, players(phone, name)')
      .eq('status', 'pending')
      .gt('expires_at', now)               // only non-expired
      .order('requested_at', { ascending: true });

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch queue' });

    const queue = (requests || []).map(r => ({
      id: r.id,
      player_id: r.player_id,
      player_phone: r.players?.phone || null,
      player_name: r.players?.name || null,
      game_type: r.game_type,
      stake: r.stake,
      status: r.status,
      requested_at: r.requested_at,
      expires_at: r.expires_at,
      seconds_remaining: Math.max(0, Math.floor((new Date(r.expires_at) - new Date()) / 1000)),
    }));

    return res.json({ success: true, data: { queue, total: queue.length } });
  } catch (err) {
    console.error('beat-the-admin/queue error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch queue' });
  }
});

// ─── POST /:requestId/approve ─────────────────────────────────────────────────
/**
 * Approve a pending request and create the match row.
 *
 * Rejects if:
 *   - Request not found / not pending
 *   - Request has expired
 *   - Another match is already in_progress (global lock)
 */
router.post('/:requestId/approve', async (req, res) => {
  try {
    const { requestId } = req.params;

    // Fetch request
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

    // Global lock: no match currently in_progress
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

    // Create match row
    const { data: match, error: matchErr } = await supabase
      .from('admin_matches')
      .insert({
        request_id: request.id,
        player_id: request.player_id,
        game_type: request.game_type,
        stake: request.stake,
        payout: request.stake * 2,
        status: 'in_progress',
      })
      .select()
      .single();

    if (matchErr || !match) {
      console.error('approve match insert error:', matchErr?.message);
      return res.status(500).json({ success: false, error: 'Failed to create match' });
    }

    // Mark request approved and link match_id
    await supabase
      .from('admin_challenge_requests')
      .update({ status: 'approved', match_id: match.id })
      .eq('id', request.id);

    return res.json({
      success: true,
      data: {
        match_id: match.id,
        request_id: request.id,
        player_id: request.player_id,
        game_type: match.game_type,
        stake: match.stake,
        payout: match.payout,
        status: match.status,
        started_at: match.started_at,
      },
    });
  } catch (err) {
    console.error('beat-the-admin/approve error:', err);
    return res.status(500).json({ success: false, error: 'Failed to approve request' });
  }
});

// ─── POST /:requestId/reject ──────────────────────────────────────────────────
/**
 * Reject a pending request and refund the stake.
 */
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

    // Mark rejected
    await supabase
      .from('admin_challenge_requests')
      .update({ status: 'rejected' })
      .eq('id', request.id);

    // Refund stake to real balance
    const { data: player } = await supabase
      .from('players')
      .select('balance')
      .eq('id', request.player_id)
      .single();

    const newBalance = Number(player?.balance || 0) + request.stake;
    await supabase.from('players').update({ balance: newBalance }).eq('id', request.player_id);

    await supabase.from('transactions').insert({
      player_id: request.player_id,
      type: 'admin_challenge_refund',
      amount: request.stake,
      description: 'Beat the Admin — request rejected by admin, stake refunded',
    });

    return res.json({
      success: true,
      data: { message: 'Request rejected and stake refunded', refunded: request.stake },
    });
  } catch (err) {
    console.error('beat-the-admin/reject error:', err);
    return res.status(500).json({ success: false, error: 'Failed to reject request' });
  }
});

// ─── POST /match/:matchId/move ────────────────────────────────────────────────
/**
 * Body: { move }
 * Admin submits their RPS move.
 * If player_move is already set, resolves the match immediately.
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
      .select('id, status, player_move, admin_move')
      .eq('id', matchId)
      .single();

    if (!match) return res.status(404).json({ success: false, error: 'Match not found' });
    if (match.status !== 'in_progress') {
      return res.status(409).json({ success: false, code: 'MATCH_ALREADY_COMPLETED', error: 'Match is already completed' });
    }
    if (match.admin_move !== null) {
      return res.status(409).json({ success: false, code: 'MOVE_ALREADY_SUBMITTED', error: 'Admin move already recorded' });
    }

    // Record admin move
    const { error: moveErr } = await supabase
      .from('admin_matches')
      .update({ admin_move: move })
      .eq('id', matchId)
      .is('admin_move', null); // guard against race

    if (moveErr) {
      console.error('admin move update error:', moveErr.message);
      return res.status(500).json({ success: false, error: 'Failed to record move' });
    }

    // If player already moved, resolve now
    if (match.player_move) {
      const resolved = await resolveMatch(matchId);
      return res.json({
        success: true,
        data: {
          move_recorded: true,
          match_resolved: true,
          winner: resolved.winner,
          player_move: match.player_move,
          admin_move: move,
        },
      });
    }

    return res.json({
      success: true,
      data: {
        move_recorded: true,
        match_resolved: false,
        message: 'Admin move recorded — waiting for player to play',
      },
    });
  } catch (err) {
    console.error('beat-the-admin/match/move error:', err);
    return res.status(500).json({ success: false, error: 'Failed to submit move' });
  }
});

// ─── GET /settings ────────────────────────────────────────────────────────────
/**
 * Returns current admin_challenge_settings row.
 */
router.get('/settings', async (req, res) => {
  try {
    const { data: settings, error } = await supabase
      .from('admin_challenge_settings')
      .select('*')
      .eq('id', 1)
      .single();

    if (error || !settings) {
      return res.status(500).json({ success: false, error: 'Settings not found' });
    }

    return res.json({ success: true, data: { settings } });
  } catch (err) {
    console.error('beat-the-admin/GET settings error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

// ─── PUT /settings ────────────────────────────────────────────────────────────
/**
 * Body: { max_stake?, min_stake?, is_available?, request_expiry_seconds? }
 * Updates admin_challenge_settings row (id=1).
 */
router.put('/settings', async (req, res) => {
  try {
    const { max_stake, min_stake, is_available, request_expiry_seconds } = req.body;

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

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    // Validate min <= max after applying updates
    if (updates.min_stake !== undefined || updates.max_stake !== undefined) {
      const { data: current } = await supabase
        .from('admin_challenge_settings')
        .select('min_stake, max_stake')
        .eq('id', 1)
        .single();
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

    return res.json({ success: true, data: { settings: updated } });
  } catch (err) {
    console.error('beat-the-admin/settings error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

module.exports = router;
