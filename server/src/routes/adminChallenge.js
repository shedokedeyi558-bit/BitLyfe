/**
 * adminChallenge.js — Player-facing routes for "Beat the Admin"
 * Mounted at /api/admin-challenge
 *
 * Endpoints:
 *   GET  /api/admin-challenge/status       — feature availability + current lock state
 *   POST /api/admin-challenge/request      — submit a challenge request (deducts stake)
 *   GET  /api/admin-challenge/my-request   — poll own pending/approved request
 *   POST /api/admin-challenge/move         — submit RPS move once match is in_progress
 */

const express = require('express');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');
const { deductEntryFee } = require('../services/billing');
const { resolveMatch } = require('../services/adminChallengeLogic');

const router = express.Router();

// ─── GET /api/admin-challenge/status ─────────────────────────────────────────
/**
 * Returns:
 *   is_available: bool
 *   match_in_progress: bool (true if any admin_matches row has status='in_progress')
 *   min_stake: number
 *   max_stake: number
 */
router.get('/status', auth, async (req, res) => {
  try {
    const { data: settings } = await supabase
      .from('admin_challenge_settings')
      .select('is_available, min_stake, max_stake')
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
        is_available: settings.is_available,
        match_in_progress: (inProgressCount || 0) > 0,
        min_stake: settings.min_stake,
        max_stake: settings.max_stake,
      },
    });
  } catch (err) {
    console.error('admin-challenge/status error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch status' });
  }
});

// ─── POST /api/admin-challenge/request ───────────────────────────────────────
/**
 * Body: { game_type, stake }
 *
 * Rejects if:
 *   - is_available is false
 *   - stake outside min/max
 *   - any admin_matches row has status='in_progress' (MATCH_IN_PROGRESS)
 *   - player already has a pending/approved request (ALREADY_REQUESTED)
 *
 * On success: deducts stake, inserts admin_challenge_requests row.
 */
router.post('/request', auth, async (req, res) => {
  try {
    const { game_type, stake } = req.body;
    const player = req.player;

    // Validate inputs
    if (!game_type || game_type !== 'rps') {
      return res.status(400).json({ success: false, error: 'game_type must be "rps"' });
    }
    const stakeNum = Math.floor(Number(stake));
    if (!stake || isNaN(stakeNum) || stakeNum <= 0) {
      return res.status(400).json({ success: false, error: 'stake must be a positive integer' });
    }

    // Fetch settings
    const { data: settings } = await supabase
      .from('admin_challenge_settings')
      .select('is_available, min_stake, max_stake, request_expiry_seconds')
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

    // Check global match lock: only one match in_progress at a time
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

    // Check player has no existing pending/approved request
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

    // Deduct stake
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

    // Create request row
    const expiresAt = new Date(Date.now() + settings.request_expiry_seconds * 1000).toISOString();

    const { data: request, error: insertErr } = await supabase
      .from('admin_challenge_requests')
      .insert({
        player_id: player.id,
        game_type,
        stake: stakeNum,
        status: 'pending',
        expires_at: expiresAt,
      })
      .select()
      .single();

    if (insertErr || !request) {
      // Refund stake on insert failure
      const { data: freshPlayer } = await supabase.from('players').select('balance').eq('id', player.id).single();
      await supabase.from('players').update({ balance: (freshPlayer?.balance || 0) + stakeNum }).eq('id', player.id);
      await supabase.from('transactions').insert({
        player_id: player.id, type: 'admin_challenge_refund', amount: stakeNum,
        description: 'Beat the Admin — refund (request insert failed)',
      });
      console.error('admin-challenge/request insert error:', insertErr?.message);
      return res.status(500).json({ success: false, error: 'Failed to create request' });
    }

    return res.status(201).json({
      success: true,
      data: {
        request_id: request.id,
        game_type: request.game_type,
        stake: request.stake,
        status: request.status,
        expires_at: request.expires_at,
        new_balance: billing.newBalance,
        new_bonus_balance: billing.newBonusBalance,
      },
    });
  } catch (err) {
    console.error('admin-challenge/request error:', err);
    return res.status(500).json({ success: false, error: 'Failed to submit request' });
  }
});

// ─── GET /api/admin-challenge/my-request ─────────────────────────────────────
/**
 * Returns the player's most recent pending/approved request and its associated match,
 * or null if none.
 */
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

    if (!request) {
      return res.json({ success: true, data: { request: null } });
    }

    const now = new Date();
    const expiresAt = new Date(request.expires_at);
    const timeRemainingSeconds = Math.max(0, Math.floor((expiresAt - now) / 1000));

    // If approved, include match state (minus admin_move to avoid leaking)
    let match = null;
    if (request.match_id) {
      const { data: matchRow } = await supabase
        .from('admin_matches')
        .select('id, game_type, stake, payout, status, player_move, winner, started_at, completed_at')
        .eq('id', request.match_id)
        .single();
      match = matchRow || null;
    }

    return res.json({
      success: true,
      data: {
        request: {
          id: request.id,
          game_type: request.game_type,
          stake: request.stake,
          status: request.status,
          expires_at: request.expires_at,
          time_remaining_seconds: timeRemainingSeconds,
        },
        match,
      },
    });
  } catch (err) {
    console.error('admin-challenge/my-request error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch request' });
  }
});

// ─── POST /api/admin-challenge/move ──────────────────────────────────────────
/**
 * Body: { requestId, move }
 * Records player_move on the associated match.
 * If admin_move is already set, resolves the match immediately.
 */
router.post('/move', auth, async (req, res) => {
  try {
    const { requestId, move } = req.body;
    const player = req.player;

    if (!requestId) return res.status(400).json({ success: false, error: 'requestId is required' });
    if (!['rock', 'paper', 'scissors'].includes(move)) {
      return res.status(400).json({ success: false, error: 'move must be rock, paper, or scissors' });
    }

    // Fetch the request — must belong to this player and be approved
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

    // Fetch match
    const { data: match } = await supabase
      .from('admin_matches')
      .select('id, status, player_move, admin_move')
      .eq('id', request.match_id)
      .single();

    if (!match) return res.status(404).json({ success: false, error: 'Match not found' });
    if (match.status !== 'in_progress') {
      return res.status(409).json({ success: false, code: 'MATCH_ALREADY_COMPLETED', error: 'Match is already completed' });
    }
    if (match.player_move !== null) {
      return res.status(409).json({ success: false, code: 'MOVE_ALREADY_SUBMITTED', error: 'You have already submitted your move' });
    }

    // Record player move
    const { error: moveErr } = await supabase
      .from('admin_matches')
      .update({ player_move: move })
      .eq('id', match.id)
      .is('player_move', null); // guard against race

    if (moveErr) {
      console.error('admin-challenge/move update error:', moveErr.message);
      return res.status(500).json({ success: false, error: 'Failed to record move' });
    }

    // If admin already moved, resolve now
    if (match.admin_move) {
      const resolved = await resolveMatch(match.id);
      return res.json({
        success: true,
        data: {
          move_recorded: true,
          match_resolved: true,
          winner: resolved.winner,
          admin_move: match.admin_move,
          player_move: move,
        },
      });
    }

    return res.json({
      success: true,
      data: {
        move_recorded: true,
        match_resolved: false,
        message: 'Move recorded — waiting for admin to play',
      },
    });
  } catch (err) {
    console.error('admin-challenge/move error:', err);
    return res.status(500).json({ success: false, error: 'Failed to submit move' });
  }
});

module.exports = router;
