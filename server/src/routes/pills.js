const { createNotification } = require('./notifications');
const express = require('express');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');
const { checkAnswer } = require('../services/gameLogic');

const router = express.Router();

// ─── HELPER FUNCTIONS ─────────────────────────────────────────────────────────

/**
 * Check if player's spend limits would be exceeded by a new charge
 * Returns { allowed: boolean, reason?: string }
 */
async function checkSpendLimit(playerId, chargeAmount) {
  const now = new Date();

  // Calculate date ranges
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const startOfDayISO = startOfDay.toISOString();
  const startOfWeekISO = startOfWeek.toISOString();
  const nowISO = now.toISOString();

  // Get player limits
  const { data: limits } = await supabase
    .from('player_limits')
    .select('daily_limit, weekly_limit')
    .eq('player_id', playerId)
    .single();

  if (!limits) {
    return { allowed: true }; // No limits set
  }

  // Get today's spending
  const { data: todayTxns } = await supabase
    .from('transactions')
    .select('amount')
    .eq('player_id', playerId)
    .in('type', ['prediction_enter', 'pill_open', 'blitz_entry', 'entry_fee'])
    .gte('created_at', startOfDayISO)
    .lte('created_at', nowISO);

  const spentToday = (todayTxns || []).reduce((sum, t) => sum + Math.abs(t.amount), 0);

  // Check daily limit
  if (limits.daily_limit && spentToday + chargeAmount > limits.daily_limit) {
    return {
      allowed: false,
      reason: `Daily limit exceeded. Spent today: ₦${spentToday}, Limit: ₦${limits.daily_limit}`,
    };
  }

  // Get this week's spending
  const { data: weekTxns } = await supabase
    .from('transactions')
    .select('amount')
    .eq('player_id', playerId)
    .in('type', ['prediction_enter', 'pill_open', 'blitz_entry', 'entry_fee'])
    .gte('created_at', startOfWeekISO)
    .lte('created_at', nowISO);

  const spentThisWeek = (weekTxns || []).reduce((sum, t) => sum + Math.abs(t.amount), 0);

  // Check weekly limit
  if (limits.weekly_limit && spentThisWeek + chargeAmount > limits.weekly_limit) {
    return {
      allowed: false,
      reason: `Weekly limit exceeded. Spent this week: ₦${spentThisWeek}, Limit: ₦${limits.weekly_limit}`,
    };
  }

  return { allowed: true };
}

/**
 * GET /api/pills/packs
 * Returns active packs that have at least one available pill.
 * Each pill shows status "played" if this player already played it.
 * Does NOT expose question, options, or correct_answer.
 */
router.get('/packs', auth, async (req, res) => {
  try {
    const playerId = req.player.id;

    // Fetch active packs including pack-level fee/prize
    const { data: packs, error: packsErr } = await supabase
      .from('pill_packs')
      .select('id, name, category, status, entry_fee, prize')
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (packsErr) {
      return res.status(500).json({ success: false, error: 'Failed to fetch packs' });
    }

    if (!packs || packs.length === 0) {
      return res.json({ success: true, data: { packs: [] } });
    }

    // Fetch only available pills for these packs
    const packIds = packs.map((p) => p.id);
    const { data: pills, error: pillsErr } = await supabase
      .from('pills')
      .select('id, pack_id, color, entry_fee, prize, status')
      .in('pack_id', packIds)
      .eq('status', 'available');

    if (pillsErr) {
      return res.status(500).json({ success: false, error: 'Failed to fetch pills' });
    }

    // Fetch this player's played pills
    const pillIds = (pills || []).map((p) => p.id);
    let playedSet = new Set();

    if (pillIds.length > 0) {
      const { data: plays } = await supabase
        .from('pill_plays')
        .select('pill_id')
        .eq('player_id', playerId)
        .in('pill_id', pillIds);

      playedSet = new Set((plays || []).map((p) => p.pill_id));
    }

    // Group pills by pack, mark per-player status
    // Use pack-level entry_fee/prize when set, fall back to per-pill values
    const packMap = {};
    for (const pack of packs) packMap[pack.id] = pack;

    const pillsByPack = {};
    for (const pill of pills || []) {
      if (!pillsByPack[pill.pack_id]) pillsByPack[pill.pack_id] = [];
      const pack = packMap[pill.pack_id];
      const effectiveFee   = pack?.entry_fee !== null && pack?.entry_fee !== undefined ? parseFloat(pack.entry_fee)  : parseFloat(pill.entry_fee);
      const effectivePrize = pack?.prize     !== null && pack?.prize     !== undefined ? parseFloat(pack.prize)      : parseFloat(pill.prize);
      pillsByPack[pill.pack_id].push({
        id: pill.id,
        color: pill.color || '#00FF66',
        price: effectiveFee,
        prize: effectivePrize,
        status: playedSet.has(pill.id) ? 'played' : 'available',
      });
    }

    // Only return packs where at least one pill hasn't been played by this player
    const result = packs
      .map((pack) => ({
        id: pack.id,
        name: pack.name,
        category: pack.category,
        status: pack.status,
        entry_fee: pack.entry_fee !== null && pack.entry_fee !== undefined ? parseFloat(pack.entry_fee) : null,
        prize: pack.prize !== null && pack.prize !== undefined ? parseFloat(pack.prize) : null,
        pills: pillsByPack[pack.id] || [],
      }))
      .filter((pack) => pack.pills.some((pill) => pill.status === 'available'));

    return res.json({ success: true, data: { packs: result } });
  } catch (err) {
    console.error('Get packs error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch pill packs' });
  }
});

/**
 * GET /api/pills/available
 * Returns all available pills (legacy endpoint, kept for compatibility)
 */
router.get('/available', auth, async (req, res) => {
  try {
    const { data: pills, error } = await supabase
      .from('pills')
      .select('id, question, category, entry_fee, prize, status, format, timer_seconds, color')
      .eq('status', 'available')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch pills' });
    }

    return res.json({
      success: true,
      data: {
        pills: pills.map((p) => ({
          id: p.id,
          question: p.question,
          category: p.category,
          price: parseFloat(p.entry_fee),
          prize: parseFloat(p.prize),
          status: p.status,
          format: p.format,
          timer: p.timer_seconds,
          color: p.color || '#00FF66',
        })),
      },
    });
  } catch (err) {
    console.error('Get pills error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch pills' });
  }
});

/**
 * POST /api/pills/open
 * Deduct entry fee and open a pill (reveal question).
 * Uses pill_plays table for per-player tracking so the global pill
 * status stays "available" for other players.
 * Body: { pillId }
 */
router.post('/open', auth, async (req, res) => {
  try {
    const { pillId } = req.body;
    const player = req.player;

    if (!pillId) {
      return res.status(400).json({ success: false, error: 'pillId is required' });
    }

    // Fetch pill
    const { data: pill, error: pillErr } = await supabase
      .from('pills')
      .select('*')
      .eq('id', pillId)
      .single();

    if (pillErr || !pill) {
      return res.status(404).json({ success: false, error: 'Pill not found' });
    }

    if (pill.status === 'expired') {
      return res.status(409).json({ success: false, error: 'Pill has expired' });
    }

    // Check if this player already played this pill
    const { data: existingPlay } = await supabase
      .from('pill_plays')
      .select('id')
      .eq('pill_id', pillId)
      .eq('player_id', player.id)
      .single();

    if (existingPlay) {
      return res.status(409).json({ success: false, error: 'Pill already played' });
    }

    // Resolve entry_fee: use pack-level if pill belongs to a pack with one set
    let entryFee = parseFloat(pill.entry_fee);
    if (pill.pack_id) {
      const { data: pack } = await supabase
        .from('pill_packs')
        .select('entry_fee, prize')
        .eq('id', pill.pack_id)
        .single();
      if (pack?.entry_fee !== null && pack?.entry_fee !== undefined) {
        entryFee = parseFloat(pack.entry_fee);
      }
    }

    // Check balance
    if (player.balance < entryFee) {
      return res.status(402).json({ success: false, error: 'Insufficient balance' });
    }

    // Check spend limits
    const limitCheck = await checkSpendLimit(player.id, entryFee);
    if (!limitCheck.allowed) {
      return res.status(429).json({ success: false, code: 'LIMIT_REACHED', error: limitCheck.reason });
    }

    // Deduct entry fee
    await supabase
      .from('players')
      .update({ balance: player.balance - entryFee })
      .eq('id', player.id);

    // Record transaction
    await supabase.from('transactions').insert({
      player_id: player.id,
      type: 'pill_open',
      amount: -entryFee,
      description: `Opened pill: ${pill.question.substring(0, 50)}`,
    });

    // Create pill_play record (marks this player as having opened this pill)
    await supabase.from('pill_plays').insert({
      pill_id: pillId,
      player_id: player.id,
      won: false,
    });

    // Resolve prize for response (same pack-level logic)
    let responsePrize = parseFloat(pill.prize);
    if (pill.pack_id) {
      const { data: pack } = await supabase
        .from('pill_packs')
        .select('prize')
        .eq('id', pill.pack_id)
        .single();
      if (pack?.prize !== null && pack?.prize !== undefined) {
        responsePrize = parseFloat(pack.prize);
      }
    }

    return res.json({
      success: true,
      data: {
        question: pill.question,
        category: pill.category,
        format: pill.format,
        options: pill.options,
        timer: pill.timer_seconds,
        prize: responsePrize,
        entryFee: entryFee,
        newBalance: player.balance - entryFee,
      },
    });
  } catch (err) {
    console.error('Open pill error:', err);
    return res.status(500).json({ success: false, error: 'Failed to open pill' });
  }
});

/**
 * POST /api/pills/submit
 * Submit answer to a pill
 * Body: { pillId, answer }
 */
router.post('/submit', auth, async (req, res) => {
  try {
    const { pillId, answer } = req.body;
    const player = req.player;

    if (!pillId || answer === undefined || answer === null) {
      return res.status(400).json({ success: false, error: 'pillId and answer are required' });
    }

    // Fetch pill
    const { data: pill, error: pillErr } = await supabase
      .from('pills')
      .select('*')
      .eq('id', pillId)
      .single();

    if (pillErr || !pill) {
      return res.status(404).json({ success: false, error: 'Pill not found' });
    }

    // Verify this player opened this pill
    const { data: play } = await supabase
      .from('pill_plays')
      .select('id, won')
      .eq('pill_id', pillId)
      .eq('player_id', player.id)
      .single();

    if (!play) {
      return res.status(409).json({ success: false, error: 'You must open this pill first' });
    }

    // Check answer
    const correct = checkAnswer(pill, String(answer));

    // Resolve prize: use pack-level if pill belongs to a pack with one set
    let prize = parseFloat(pill.prize);
    if (pill.pack_id) {
      const { data: pack } = await supabase
        .from('pill_packs')
        .select('prize')
        .eq('id', pill.pack_id)
        .single();
      if (pack?.prize !== null && pack?.prize !== undefined) {
        prize = parseFloat(pack.prize);
      }
    }

    // Mark pill as played in the pills table immediately
    await supabase
      .from('pills')
      .update({ status: 'played' })
      .eq('id', pillId);

    if (correct) {
      // Fetch fresh player balance
      const { data: freshPlayer } = await supabase
        .from('players')
        .select('balance')
        .eq('id', player.id)
        .single();

      const newBalance = (freshPlayer.balance || 0) + prize;

      await supabase.from('players').update({ balance: newBalance }).eq('id', player.id);

      await supabase.from('transactions').insert({
        player_id: player.id,
        type: 'pill_win',
        amount: prize,
        description: `Won pill: ${pill.question.substring(0, 50)}`,
      });

      // Mark play as won
      await supabase.from('pill_plays').update({ won: true }).eq('id', play.id);

      // Notify player
      await createNotification(player.id, 'win', 'You won! 🎉', `₦${prize.toLocaleString()} has been credited to your wallet`);

      // Auto-deactivate pack if all pills in it are now played
      if (pill.pack_id) {
        const { count: totalCount } = await supabase
          .from('pills')
          .select('id', { count: 'exact', head: true })
          .eq('pack_id', pill.pack_id)
          .neq('status', 'expired');

        const { count: playedCount } = await supabase
          .from('pills')
          .select('id', { count: 'exact', head: true })
          .eq('pack_id', pill.pack_id)
          .eq('status', 'played');

        if (totalCount > 0 && playedCount >= totalCount) {
          await supabase
            .from('pill_packs')
            .update({ status: 'inactive' })
            .eq('id', pill.pack_id);
        }
      }

      return res.json({
        success: true,
        data: {
          won: true,
          correctAnswer: pill.correct_answer,
          prize: prize,
          newBalance: newBalance,
        },
      });
    }

    // Wrong answer — still check if pack should be deactivated
    if (pill.pack_id) {
      const { count: totalCount } = await supabase
        .from('pills')
        .select('id', { count: 'exact', head: true })
        .eq('pack_id', pill.pack_id)
        .neq('status', 'expired');

      const { count: playedCount } = await supabase
        .from('pills')
        .select('id', { count: 'exact', head: true })
        .eq('pack_id', pill.pack_id)
        .eq('status', 'played');

      if (totalCount > 0 && playedCount >= totalCount) {
        await supabase
          .from('pill_packs')
          .update({ status: 'inactive' })
          .eq('id', pill.pack_id);
      }
    }

    return res.json({
      success: true,
      data: {
        won: false,
        correctAnswer: pill.correct_answer,
        prize: 0,
      },
    });
  } catch (err) {
    console.error('Submit pill error:', err);
    return res.status(500).json({ success: false, error: 'Failed to submit pill answer' });
  }
});

module.exports = router;
