const { createNotification } = require('./notifications');
const { checkReferralCompletion } = require('./referrals');
const express = require('express');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');
const idempotency = require('../middleware/idempotency');
const { checkAnswer } = require('../services/gameLogic');
const { deductEntryFee } = require('../services/billing');

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

    // Fetch active STANDARD packs only — exclude Specials (pack_type='special' or is_vip=true)
    // Use select with filter: pack_type = 'standard' OR (pack_type is null AND is_vip = false)
    // Simplest safe filter: exclude anything flagged as special or vip
    const { data: packs, error: packsErr } = await supabase
      .from('pill_packs')
      .select('id, name, category, status, entry_fee, prize, pack_type, is_vip, is_featured')
      .eq('status', 'active')
      .or('pack_type.eq.standard,pack_type.is.null')
      .eq('is_vip', false)
      .order('is_featured', { ascending: false })  // featured pack sorts first
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
        is_featured: pack.is_featured || false,
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
 * GET /api/pills/specials
 * Returns all active Special packs for the player-facing Specials section.
 * Includes packs where pack_type = 'special' OR is_vip = true (legacy flag).
 * Does NOT include pills — specials use the start endpoint, not individual pill selection.
 */
router.get('/specials', auth, async (req, res) => {
  try {
    const { data: packs, error } = await supabase
      .from('pill_packs')
      .select('id, name, category, status, entry_fee, prize, pack_type, is_vip, question_count, total_time_seconds, required_correct, entry_window_end')
      .eq('status', 'active')
      .or('pack_type.eq.special,is_vip.eq.true')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch specials' });
    }

    const now = new Date();
    const result = (packs || [])
      .filter((p) => !p.entry_window_end || new Date(p.entry_window_end) > now)
      .map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        status: p.status,
        is_vip: true,                    // always true for specials — frontend checks this
        pack_type: p.pack_type || 'special',
        entry_fee: p.entry_fee ? parseFloat(p.entry_fee) : null,
        prize: p.prize ? parseFloat(p.prize) : null,
        question_count: p.question_count || null,
        total_time_seconds: p.total_time_seconds || null,
        required_correct: p.required_correct || null,
        entry_window_end: p.entry_window_end || null,
      }));

    return res.json({ success: true, data: { specials: result } });
  } catch (err) {
    console.error('Get specials error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch specials' });
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
 * Body: { pillId, idempotency_key? }
 */
router.post('/open', idempotency(), auth, async (req, res) => {
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

    // Check balance (bonus + real combined)
    if ((player.balance || 0) + (player.bonus_balance || 0) < entryFee) {
      return res.status(402).json({ success: false, error: 'Insufficient balance' });
    }

    // Check spend limits
    const limitCheck = await checkSpendLimit(player.id, entryFee);
    if (!limitCheck.allowed) {
      return res.status(429).json({ success: false, code: 'LIMIT_REACHED', error: limitCheck.reason });
    }

    // Deduct entry fee — bonus first, real balance for remainder. Transaction recorded inside.
    let billing;
    try {
      billing = await deductEntryFee(player.id, entryFee, {
        type: 'pill_open',
        description: `Opened pill: ${pill.question.substring(0, 50)}`,
      });
    } catch (billingErr) {
      if (billingErr.insufficientFunds) return res.status(402).json({ success: false, error: billingErr.message });
      throw billingErr;
    }

    // Create pill_play record (marks this player as having opened this pill)
    await supabase.from('pill_plays').insert({
      pill_id: pillId,
      player_id: player.id,
      won: false,
    });

    // Trigger referral first-game check (fire-and-forget — never blocks the response)
    checkReferralCompletion(player.id, 'game').catch(() => {});

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
        newBalance: billing.newBalance,
        newBonusBalance: billing.newBonusBalance,
        bonusUsed: billing.bonusUsed,
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

/**
 * POST /api/pills/redeem-ticket
 * Validate and redeem a pill_tickets code — waives entry fee for one pill open.
 * Blocked on VIP packs (is_vip = true). Ticket must be unused and not expired.
 * Body: { ticket_code, pillId }
 */
router.post('/redeem-ticket', auth, async (req, res) => {
  try {
    const { ticket_code, pillId } = req.body;
    const player = req.player;

    if (!ticket_code || !pillId) {
      return res.status(400).json({ success: false, error: 'ticket_code and pillId are required' });
    }

    // Fetch and validate ticket
    const { data: ticket } = await supabase
      .from('pill_tickets')
      .select('id, player_id, expires_at, status')
      .eq('ticket_code', ticket_code.trim().toUpperCase())
      .maybeSingle();

    if (!ticket) {
      return res.status(404).json({ success: false, code: 'TICKET_NOT_FOUND', error: 'Ticket not found' });
    }

    if (ticket.player_id !== player.id) {
      return res.status(403).json({ success: false, code: 'TICKET_NOT_OWNER', error: 'This ticket does not belong to you' });
    }

    const now = new Date();

    // Lazy-expire check
    if (new Date(ticket.expires_at) < now && ticket.status === 'unused') {
      await supabase.from('pill_tickets').update({ status: 'expired' }).eq('id', ticket.id);
      return res.status(410).json({ success: false, code: 'TICKET_EXPIRED', error: 'Ticket has expired' });
    }

    if (ticket.status === 'used') {
      return res.status(409).json({ success: false, code: 'TICKET_ALREADY_USED', error: 'Ticket has already been used' });
    }

    if (ticket.status === 'expired') {
      return res.status(410).json({ success: false, code: 'TICKET_EXPIRED', error: 'Ticket has expired' });
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

    // Block VIP packs — pill tickets are only valid on standard packs
    if (pill.pack_id) {
      const { data: pack } = await supabase
        .from('pill_packs')
        .select('is_vip')
        .eq('id', pill.pack_id)
        .single();
      if (pack?.is_vip) {
        return res.status(403).json({
          success: false,
          code: 'VIP_PACK_NOT_ALLOWED',
          error: 'Pill tickets cannot be used on VIP packs',
        });
      }
    }

    // Check if this player already played this pill
    const { data: existingPlay } = await supabase
      .from('pill_plays')
      .select('id')
      .eq('pill_id', pillId)
      .eq('player_id', player.id)
      .maybeSingle();

    if (existingPlay) {
      return res.status(409).json({ success: false, error: 'Pill already played' });
    }

    // Resolve prize (pack-level or pill-level)
    let responsePrize = parseFloat(pill.prize);
    if (pill.pack_id) {
      const { data: pack } = await supabase.from('pill_packs').select('prize').eq('id', pill.pack_id).single();
      if (pack?.prize != null) responsePrize = parseFloat(pack.prize);
    }

    // Mark ticket as used
    await supabase
      .from('pill_tickets')
      .update({ status: 'used', used_on_pack_id: pill.pack_id || null })
      .eq('id', ticket.id);

    // Create pill_play record (entry fee waived — no balance deduction)
    await supabase.from('pill_plays').insert({
      pill_id: pillId,
      player_id: player.id,
      won: false,
    });

    // Record zero-cost transaction for audit trail
    await supabase.from('transactions').insert({
      player_id: player.id,
      type: 'pill_ticket_redeem',
      amount: 0,
      description: `Pill opened with ticket ${ticket_code} (entry fee waived)`,
    });

    // Trigger referral first-game check
    checkReferralCompletion(player.id, 'game').catch(() => {});

    return res.json({
      success: true,
      data: {
        question: pill.question,
        category: pill.category,
        format: pill.format,
        options: pill.options,
        timer: pill.timer_seconds,
        prize: responsePrize,
        entryFee: 0,
        ticketUsed: ticket_code,
        newBalance: player.balance, // unchanged — ticket waived the fee
      },
    });
  } catch (err) {
    console.error('Redeem pill ticket error:', err);
    return res.status(500).json({ success: false, error: 'Failed to redeem ticket' });
  }
});

module.exports = router;
