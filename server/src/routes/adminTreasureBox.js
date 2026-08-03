/**
 * adminTreasureBox.js — Admin settings for the Treasure Box game mode
 * Mounted at /api/admin/treasure-box
 * All routes require adminAuth.
 *
 * Endpoints:
 *   GET /api/admin/treasure-box/settings — current settings + computed rtp
 *   PUT /api/admin/treasure-box/settings — update settings with RTP safety guard
 *
 * RTP formula: (pop_limit / total_slots) * payout_multiplier
 * Example defaults: (3 / 25) * 6 = 0.72 = 72%
 */

const express = require('express');
const supabase = require('../db/supabase');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();
router.use(adminAuth);

const RTP_SAFETY_THRESHOLD = 0.90; // block above 90% by default

/**
 * Compute RTP from the three economic parameters.
 * Returns a number between 0 and 1 (e.g. 0.72 = 72%).
 */
function computeRTP(totalSlots, popLimit, payoutMultiplier) {
  if (!totalSlots || totalSlots <= 0) return 0;
  return (popLimit / totalSlots) * payoutMultiplier;
}

// ─── GET /api/admin/treasure-box/settings ────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const { data: settings, error } = await supabase
      .from('treasure_box_settings')
      .select('*')
      .eq('id', 1)
      .single();

    if (error || !settings) {
      return res.status(500).json({ success: false, error: 'Treasure Box settings not found' });
    }

    const rtp = computeRTP(settings.total_slots, settings.pop_limit, Number(settings.payout_multiplier));

    return res.json({
      success: true,
      data: {
        settings: {
          total_slots:       settings.total_slots,
          pop_limit:         settings.pop_limit,
          payout_multiplier: Number(settings.payout_multiplier),
          min_stake:         settings.min_stake,
          max_stake:         settings.max_stake,
          is_available:      settings.is_available,
        },
        rtp: parseFloat(rtp.toFixed(4)),         // e.g. 0.72
        rtp_percent: parseFloat((rtp * 100).toFixed(2)), // e.g. 72.00
      },
    });
  } catch (err) {
    console.error('treasure-box GET settings error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

// ─── PUT /api/admin/treasure-box/settings ────────────────────────────────────
/**
 * Body: {
 *   total_slots?,       integer >= 2
 *   pop_limit?,         integer >= 1, must be < total_slots
 *   payout_multiplier?, number > 0
 *   min_stake?,         integer >= 1
 *   max_stake?,         integer >= min_stake
 *   is_available?,      boolean
 *   force?              boolean — bypass RTP safety check
 * }
 *
 * Computes rtp after applying updates. If rtp > 0.90 and force !== true,
 * returns 400 UNSAFE_RTP. If force = true, saves anyway.
 */
router.put('/settings', async (req, res) => {
  try {
    const {
      total_slots, pop_limit, payout_multiplier,
      min_stake, max_stake, is_available,
      force = false,
    } = req.body;

    // Fetch current values so we can merge and validate the full picture
    const { data: current, error: fetchErr } = await supabase
      .from('treasure_box_settings')
      .select('*')
      .eq('id', 1)
      .single();

    if (fetchErr || !current) {
      return res.status(500).json({ success: false, error: 'Failed to fetch current settings' });
    }

    // Build the updates object — only include fields that were explicitly sent
    const updates = {};

    if (total_slots !== undefined) {
      const v = Math.floor(Number(total_slots));
      if (isNaN(v) || v < 2) {
        return res.status(400).json({ success: false, error: 'total_slots must be an integer >= 2' });
      }
      updates.total_slots = v;
    }

    if (pop_limit !== undefined) {
      const v = Math.floor(Number(pop_limit));
      if (isNaN(v) || v < 1) {
        return res.status(400).json({ success: false, error: 'pop_limit must be an integer >= 1' });
      }
      updates.pop_limit = v;
    }

    if (payout_multiplier !== undefined) {
      const v = Number(payout_multiplier);
      if (isNaN(v) || v <= 0) {
        return res.status(400).json({ success: false, error: 'payout_multiplier must be a positive number' });
      }
      updates.payout_multiplier = v;
    }

    if (min_stake !== undefined) {
      const v = Math.floor(Number(min_stake));
      if (isNaN(v) || v < 1) {
        return res.status(400).json({ success: false, error: 'min_stake must be a positive integer' });
      }
      updates.min_stake = v;
    }

    if (max_stake !== undefined) {
      const v = Math.floor(Number(max_stake));
      if (isNaN(v) || v < 1) {
        return res.status(400).json({ success: false, error: 'max_stake must be a positive integer' });
      }
      updates.max_stake = v;
    }

    if (is_available !== undefined) {
      updates.is_available = is_available === true || is_available === 'true';
    }

    if (Object.keys(updates).filter(k => k !== 'is_available').length === 0 && updates.is_available === undefined) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }

    // Merge updates onto current values for cross-field validation
    const effective = {
      total_slots:       updates.total_slots       ?? current.total_slots,
      pop_limit:         updates.pop_limit         ?? current.pop_limit,
      payout_multiplier: updates.payout_multiplier ?? Number(current.payout_multiplier),
      min_stake:         updates.min_stake         ?? current.min_stake,
      max_stake:         updates.max_stake         ?? current.max_stake,
    };

    // pop_limit must be strictly less than total_slots (at least 1 safe slot must exist)
    if (effective.pop_limit >= effective.total_slots) {
      return res.status(400).json({
        success: false,
        error: `pop_limit (${effective.pop_limit}) must be less than total_slots (${effective.total_slots}) — at least one safe slot must remain`,
      });
    }

    // min_stake must not exceed max_stake
    if (effective.min_stake > effective.max_stake) {
      return res.status(400).json({
        success: false,
        error: `min_stake (${effective.min_stake}) cannot exceed max_stake (${effective.max_stake})`,
      });
    }

    // ── RTP safety check ──────────────────────────────────────────────────────
    const rtp = computeRTP(effective.total_slots, effective.pop_limit, effective.payout_multiplier);
    const rtpPercent = parseFloat((rtp * 100).toFixed(2));

    if (rtp > RTP_SAFETY_THRESHOLD && force !== true) {
      return res.status(400).json({
        success: false,
        code: 'UNSAFE_RTP',
        error: `This configuration has an RTP of ${rtpPercent}% — you would lose money on average at this setting. Reduce the payout or increase slots/reduce pops.`,
        rtp: parseFloat(rtp.toFixed(4)),
        rtp_percent: rtpPercent,
        hint: 'To override this check and save anyway, include { "force": true } in the request body.',
      });
    }

    // ── Apply update ──────────────────────────────────────────────────────────
    const { data: saved, error: updateErr } = await supabase
      .from('treasure_box_settings')
      .update(updates)
      .eq('id', 1)
      .select()
      .single();

    if (updateErr || !saved) {
      console.error('treasure-box settings update error:', updateErr?.message);
      return res.status(500).json({ success: false, error: 'Failed to save settings' });
    }

    const savedRTP = computeRTP(saved.total_slots, saved.pop_limit, Number(saved.payout_multiplier));

    return res.json({
      success: true,
      data: {
        settings: {
          total_slots:       saved.total_slots,
          pop_limit:         saved.pop_limit,
          payout_multiplier: Number(saved.payout_multiplier),
          min_stake:         saved.min_stake,
          max_stake:         saved.max_stake,
          is_available:      saved.is_available,
        },
        rtp:         parseFloat(savedRTP.toFixed(4)),
        rtp_percent: parseFloat((savedRTP * 100).toFixed(2)),
        forced:      rtp > RTP_SAFETY_THRESHOLD && force === true,
      },
    });
  } catch (err) {
    console.error('treasure-box PUT settings error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

module.exports = router;
