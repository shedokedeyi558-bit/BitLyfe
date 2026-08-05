/**
 * treasureBox.js — Player-facing Treasure Box gameplay routes
 * Mounted at /api/treasure-box
 *
 * Endpoints:
 *   GET  /api/treasure-box/available         — list claimable boxes
 *   GET  /api/treasure-box/history           — player's own past boxes
 *   POST /api/treasure-box/:boxId/claim      — atomic claim + stake deduction
 *   GET  /api/treasure-box/:boxId            — status check / resume
 *   POST /api/treasure-box/:boxId/pop        — sequential slot reveal
 */

const express = require('express');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');
const { deductEntryFee } = require('../services/billing');

const router = express.Router();

// ─── GET /api/treasure-box/available ─────────────────────────────────────────
/**
 * Lists boxes with status='available'.
 * Does NOT include treasure_slot_index.
 * Includes min_stake/max_stake from current settings for display.
 */
router.get('/available', auth, async (req, res) => {
  try {
    const [{ data: boxes }, { data: settings }] = await Promise.all([
      supabase
        .from('treasure_boxes')
        .select('id, total_slots, pop_limit, payout_multiplier, status, created_at')
        .eq('status', 'available')
        .order('created_at', { ascending: false }),
      supabase
        .from('treasure_box_settings')
        .select('min_stake, max_stake, is_available')
        .eq('id', 1)
        .single(),
    ]);

    if (!settings?.is_available) {
      return res.json({ success: true, data: { boxes: [], is_available: false } });
    }

    return res.json({
      success: true,
      data: {
        is_available: true,
        min_stake: settings.min_stake,
        max_stake: settings.max_stake,
        boxes: (boxes || []).map(b => ({
          id:                b.id,
          total_slots:       b.total_slots,
          pop_limit:         b.pop_limit,
          payout_multiplier: Number(b.payout_multiplier),
          status:            b.status,
          created_at:        b.created_at,
          // treasure_slot_index intentionally omitted
        })),
      },
    });
  } catch (err) {
    console.error('GET /treasure-box/available error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch boxes' });
  }
});

// ─── GET /api/treasure-box/history ───────────────────────────────────────────
/**
 * Player's own past boxes (claimed, completed), most recent first.
 * Query params: ?page=1&limit=20
 */
router.get('/history', auth, async (req, res) => {
  try {
    const player = req.player;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const { data: boxes, count, error } = await supabase
      .from('treasure_boxes')
      .select('id, total_slots, pop_limit, payout_multiplier, status, stake, payout, outcome, created_at, claimed_at, completed_at', { count: 'exact' })
      .eq('claimed_by', player.id)
      .order('claimed_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch history' });

    return res.json({
      success: true,
      data: {
        history: (boxes || []).map(b => ({
          id:                b.id,
          total_slots:       b.total_slots,
          pop_limit:         b.pop_limit,
          payout_multiplier: Number(b.payout_multiplier),
          status:            b.status,
          stake:             b.stake,
          payout:            b.payout,
          outcome:           b.outcome,
          created_at:        b.created_at,
          claimed_at:        b.claimed_at,
          completed_at:      b.completed_at,
          // treasure_slot_index and pops NOT included here — use GET /:boxId for detail
        })),
        total: count || 0,
        page,
        limit,
      },
    });
  } catch (err) {
    console.error('GET /treasure-box/history error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch history' });
  }
});

// ─── POST /api/treasure-box/:boxId/claim ─────────────────────────────────────
/**
 * Atomic single-claim: transitions status available → claimed only if currently available.
 * Validates stake, deducts via billing, sets claimed_by/stake/claimed_at.
 */
router.post('/:boxId/claim', auth, async (req, res) => {
  try {
    const { boxId } = req.params;
    const player = req.player;
    const stakeNum = Math.floor(Number(req.body.stake));

    if (!req.body.stake || isNaN(stakeNum) || stakeNum <= 0) {
      return res.status(400).json({ success: false, error: 'stake must be a positive integer' });
    }

    // Fetch current stake limits
    const { data: settings } = await supabase
      .from('treasure_box_settings')
      .select('min_stake, max_stake, is_available')
      .eq('id', 1)
      .single();

    if (!settings?.is_available) {
      return res.status(503).json({ success: false, code: 'FEATURE_UNAVAILABLE', error: 'Treasure Box is not available right now' });
    }

    if (stakeNum < settings.min_stake || stakeNum > settings.max_stake) {
      return res.status(400).json({
        success: false,
        code: 'STAKE_OUT_OF_RANGE',
        error: `Stake must be between ₦${settings.min_stake} and ₦${settings.max_stake}`,
      });
    }

    // Atomic claim: UPDATE WHERE status='available' — prevents race conditions
    const now = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .from('treasure_boxes')
      .update({
        status:     'claimed',
        claimed_by: player.id,
        stake:      stakeNum,
        claimed_at: now,
      })
      .eq('id', boxId)
      .eq('status', 'available')       // ← atomic guard: only succeeds if still available
      .select('id, total_slots, pop_limit, payout_multiplier, status, stake, claimed_at')
      .single();

    if (claimErr || !claimed) {
      // Either box doesn't exist or was already claimed between check and update
      const { data: existing } = await supabase
        .from('treasure_boxes')
        .select('status')
        .eq('id', boxId)
        .single();

      if (!existing) return res.status(404).json({ success: false, error: 'Box not found' });
      return res.status(409).json({
        success: false,
        code: 'BOX_ALREADY_CLAIMED',
        error: `This box has already been ${existing.status}`,
      });
    }

    // Deduct stake
    let billing;
    try {
      billing = await deductEntryFee(player.id, stakeNum, {
        type: 'treasure_box_entry',
        description: `Treasure Box claim — stake ₦${stakeNum}`,
      });
    } catch (billingErr) {
      // Rollback claim — set back to available
      await supabase
        .from('treasure_boxes')
        .update({ status: 'available', claimed_by: null, stake: null, claimed_at: null })
        .eq('id', boxId);

      if (billingErr.insufficientFunds) {
        return res.status(402).json({ success: false, error: billingErr.message });
      }
      throw billingErr;
    }

    return res.status(201).json({
      success: true,
      data: {
        box_id:            claimed.id,
        total_slots:       claimed.total_slots,
        pop_limit:         claimed.pop_limit,
        payout_multiplier: Number(claimed.payout_multiplier),
        status:            claimed.status,
        stake:             claimed.stake,
        claimed_at:        claimed.claimed_at,
        pops_used:         0,
        pops_remaining:    claimed.pop_limit,
        new_balance:       billing.newBalance,
        new_bonus_balance: billing.newBonusBalance,
        // treasure_slot_index NOT included
      },
    });
  } catch (err) {
    console.error('POST /treasure-box/:boxId/claim error:', err);
    return res.status(500).json({ success: false, error: 'Failed to claim box' });
  }
});

// ─── GET /api/treasure-box/:boxId ────────────────────────────────────────────
/**
 * Status check / resume for a box the player has claimed.
 * Returns box state + already-popped slots.
 * Does NOT reveal treasure_slot_index unless game_over is true.
 */
router.get('/:boxId', auth, async (req, res) => {
  try {
    const { boxId } = req.params;
    const player = req.player;

    const { data: box } = await supabase
      .from('treasure_boxes')
      .select('id, total_slots, pop_limit, payout_multiplier, treasure_slot_index, treasure_slot_indexes, status, stake, payout, outcome, claimed_by, claimed_at, completed_at')
      .eq('id', boxId)
      .single();

    if (!box) return res.status(404).json({ success: false, error: 'Box not found' });
    if (box.claimed_by !== player.id) {
      return res.status(403).json({ success: false, error: 'This box does not belong to you' });
    }

    // Fetch pops already made
    const { data: pops } = await supabase
      .from('treasure_box_pops')
      .select('pop_number, slot_index, was_treasure, popped_at')
      .eq('box_id', boxId)
      .order('pop_number', { ascending: true });

    const popsUsed = (pops || []).length;
    const gameOver = box.status === 'completed';

    // Resolve treasure indexes array
    const treasureIndexes = box.treasure_slot_indexes
      ? (Array.isArray(box.treasure_slot_indexes) ? box.treasure_slot_indexes : JSON.parse(box.treasure_slot_indexes))
      : (box.treasure_slot_index !== null ? [box.treasure_slot_index] : []);

    return res.json({
      success: true,
      data: {
        box_id:            box.id,
        total_slots:       box.total_slots,
        pop_limit:         box.pop_limit,
        payout_multiplier: Number(box.payout_multiplier),
        status:            box.status,
        stake:             box.stake,
        payout:            box.payout,
        outcome:           box.outcome,
        claimed_at:        box.claimed_at,
        completed_at:      box.completed_at,
        pops_used:         popsUsed,
        pops_remaining:    Math.max(0, box.pop_limit - popsUsed),
        game_over:         gameOver,
        // Only reveal treasure positions once game is decided
        treasure_slot_indexes: gameOver ? treasureIndexes : undefined,
        pops: (pops || []).map(p => ({
          pop_number:   p.pop_number,
          slot_index:   p.slot_index,
          was_treasure: p.was_treasure,
          popped_at:    p.popped_at,
        })),
      },
    });
  } catch (err) {
    console.error('GET /treasure-box/:boxId error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch box' });
  }
});

// ─── POST /api/treasure-box/:boxId/pop ───────────────────────────────────────
/**
 * Sequential slot reveal.
 * Body: { slot_index }
 *
 * On treasure hit → completed, outcome='won', payout credited, treasure_slot_index revealed.
 * On final pop miss → completed, outcome='lost', treasure_slot_index revealed.
 * On non-final miss → game continues, pops_remaining decremented.
 */
router.post('/:boxId/pop', auth, async (req, res) => {
  try {
    const { boxId } = req.params;
    const player = req.player;
    const slotIndex = Math.floor(Number(req.body.slot_index));

    if (isNaN(slotIndex) || slotIndex < 0) {
      return res.status(400).json({ success: false, error: 'slot_index must be a non-negative integer' });
    }

    // Fetch box — include both treasure fields for multi-slot support
    const { data: box } = await supabase
      .from('treasure_boxes')
      .select('id, total_slots, pop_limit, payout_multiplier, treasure_slot_index, treasure_slot_indexes, status, stake, claimed_by')
      .eq('id', boxId)
      .single();

    if (!box) return res.status(404).json({ success: false, error: 'Box not found' });
    if (box.claimed_by !== player.id) {
      return res.status(403).json({ success: false, error: 'This box does not belong to you' });
    }
    if (box.status !== 'claimed') {
      const code = box.status === 'completed' ? 'GAME_ALREADY_OVER' : 'BOX_NOT_CLAIMED';
      return res.status(409).json({ success: false, code, error: `Box status is "${box.status}"` });
    }
    if (slotIndex >= box.total_slots) {
      return res.status(400).json({ success: false, error: `slot_index must be between 0 and ${box.total_slots - 1}` });
    }

    // Resolve treasure slot indexes — support both legacy single int and new array
    const treasureIndexes = box.treasure_slot_indexes
      ? (Array.isArray(box.treasure_slot_indexes) ? box.treasure_slot_indexes : JSON.parse(box.treasure_slot_indexes))
      : (box.treasure_slot_index !== null ? [box.treasure_slot_index] : []);

    // Fetch existing pops
    const { data: existingPops } = await supabase
      .from('treasure_box_pops')
      .select('pop_number, slot_index')
      .eq('box_id', boxId)
      .order('pop_number', { ascending: true });

    const popsUsed = (existingPops || []).length;

    // Guard: pop limit not exceeded
    if (popsUsed >= box.pop_limit) {
      return res.status(409).json({ success: false, code: 'POP_LIMIT_REACHED', error: 'No pops remaining' });
    }

    // Guard: slot not already popped
    const alreadyPopped = (existingPops || []).some(p => p.slot_index === slotIndex);
    if (alreadyPopped) {
      return res.status(409).json({ success: false, code: 'SLOT_ALREADY_POPPED', error: 'This slot has already been revealed' });
    }

    const popNumber = popsUsed + 1;
    const wasTreasure = treasureIndexes.includes(slotIndex);
    const now = new Date().toISOString();

    // Insert pop record
    const { error: popErr } = await supabase.from('treasure_box_pops').insert({
      box_id:       boxId,
      pop_number:   popNumber,
      slot_index:   slotIndex,
      was_treasure: wasTreasure,
      popped_at:    now,
    });

    if (popErr) {
      console.error('Insert pop error:', popErr.message);
      return res.status(500).json({ success: false, error: 'Failed to record pop' });
    }

    const isFinalPop = popNumber >= box.pop_limit;

    // ── Win ──────────────────────────────────────────────────────────────────
    if (wasTreasure) {
      const payout = Math.floor(box.stake * Number(box.payout_multiplier));

      // Credit payout to real balance
      const { data: freshPlayer } = await supabase
        .from('players')
        .select('balance')
        .eq('id', player.id)
        .single();

      const newBalance = Number(freshPlayer?.balance || 0) + payout;
      await supabase.from('players').update({ balance: newBalance }).eq('id', player.id);

      await supabase.from('transactions').insert({
        player_id: player.id,
        type: 'treasure_box_win',
        amount: payout,
        description: `Treasure Box win — ₦${payout} (${box.payout_multiplier}× stake)`,
      });

      await supabase.from('treasure_boxes').update({
        status:       'completed',
        outcome:      'won',
        payout,
        completed_at: now,
      }).eq('id', boxId);

      return res.json({
        success: true,
        data: {
          pop_number:           popNumber,
          slot_index:           slotIndex,
          was_treasure:         true,
          game_over:            true,
          outcome:              'won',
          payout,
          new_balance:          newBalance,
          treasure_slot_indexes: treasureIndexes,  // all revealed — game decided
        },
      });
    }

    // ── Final pop miss — game over (lost) ─────────────────────────────────────
    if (isFinalPop) {
      await supabase.from('treasure_boxes').update({
        status:       'completed',
        outcome:      'lost',
        completed_at: now,
      }).eq('id', boxId);

      return res.json({
        success: true,
        data: {
          pop_number:           popNumber,
          slot_index:           slotIndex,
          was_treasure:         false,
          game_over:            true,
          outcome:              'lost',
          payout:               0,
          treasure_slot_indexes: treasureIndexes,  // revealed — game decided
        },
      });
    }

    // ── Non-final miss — game continues ───────────────────────────────────────
    return res.json({
      success: true,
      data: {
        pop_number:    popNumber,
        slot_index:    slotIndex,
        was_treasure:  false,
        game_over:     false,
        pops_remaining: box.pop_limit - popNumber,
        // treasure_slot_index NOT revealed
      },
    });
  } catch (err) {
    console.error('POST /treasure-box/:boxId/pop error:', err);
    return res.status(500).json({ success: false, error: 'Failed to process pop' });
  }
});

module.exports = router;
