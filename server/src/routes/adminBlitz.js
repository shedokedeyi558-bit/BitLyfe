const { createNotifications } = require('./notifications');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

router.use(adminAuth);

// ─── PRIZE DISTRIBUTION HELPER ────────────────────────────────────────────────

function calcPrizeDistribution(prizePool, platformCutPercent, totalRegistered) {
  const remaining = Math.floor(prizePool * (1 - platformCutPercent / 100));

  if (totalRegistered < 100) {
    return {
      cash: [{ position: 1, amount: remaining }],
      freeTickets: [2, 3, 4, 5],
    };
  } else if (totalRegistered < 500) {
    return {
      cash: [
        { position: 1, amount: Math.floor(remaining * 0.60) },
        { position: 2, amount: Math.floor(remaining * 0.25) },
        { position: 3, amount: Math.floor(remaining * 0.15) },
      ],
      freeTickets: [4, 5],
    };
  } else {
    return {
      cash: [
        { position: 1, amount: Math.floor(remaining * 0.50) },
        { position: 2, amount: Math.floor(remaining * 0.30) },
        { position: 3, amount: Math.floor(remaining * 0.20) },
      ],
      freeTickets: [4, 5, 6, 7, 8, 9, 10],
    };
  }
}

function generateTicketCode() {
  return 'TKT-' + uuidv4().split('-')[0].toUpperCase() + '-' + uuidv4().split('-')[1].toUpperCase();
}

// ─── TOURNAMENT CRUD ──────────────────────────────────────────────────────────

/**
 * GET /api/admin/blitz
 * List all tournaments
 */
router.get('/', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabase
      .from('blitz_tournaments')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch tournaments' });

    return res.json({ success: true, data: { tournaments: data, total: count, page: Number(page), limit: Number(limit) } });
  } catch (err) {
    console.error('Admin get blitz error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch tournaments' });
  }
});

/**
 * POST /api/admin/blitz
 * Create a tournament
 */
router.post('/', async (req, res) => {
  try {
    const {
      title, description, entry_fee, question_count, time_limit_seconds,
      registration_start, tournament_start, tournament_end, platform_cut_percent,
    } = req.body;

    if (!title || entry_fee === undefined || !question_count || !time_limit_seconds ||
        !registration_start || !tournament_start || !tournament_end) {
      return res.status(400).json({
        success: false,
        error: 'title, entry_fee, question_count, time_limit_seconds, registration_start, tournament_start, tournament_end are required',
      });
    }

    const { data, error } = await supabase
      .from('blitz_tournaments')
      .insert({
        title,
        description: description || null,
        entry_fee: Number(entry_fee),
        question_count: Number(question_count),
        time_limit_seconds: Number(time_limit_seconds),
        registration_start: new Date(registration_start).toISOString(),
        tournament_start: new Date(tournament_start).toISOString(),
        tournament_end: new Date(tournament_end).toISOString(),
        platform_cut_percent: platform_cut_percent ?? 50,
        status: 'draft',
        total_registered: 0,
        prize_pool: 0,
        created_by: req.admin?.id || null,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: 'Failed to create tournament: ' + error.message });

    return res.status(201).json({ success: true, data: { tournament: data } });
  } catch (err) {
    console.error('Create blitz error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create tournament' });
  }
});

/**
 * PUT /api/admin/blitz/:id
 * Update tournament (only if draft)
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Prevent changing these
    delete updates.id;
    delete updates.created_by;
    delete updates.created_at;
    delete updates.total_registered;
    delete updates.prize_pool;
    delete updates.status;

    const { data, error } = await supabase
      .from('blitz_tournaments')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ success: false, error: 'Tournament not found or update failed' });

    return res.json({ success: true, data: { tournament: data } });
  } catch (err) {
    console.error('Update blitz error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update tournament' });
  }
});

// ─── QUESTION MANAGEMENT ──────────────────────────────────────────────────────

/**
 * POST /api/admin/blitz/:id/questions
 * Add a question to tournament
 */
router.post('/:id/questions', async (req, res) => {
  try {
    const { id } = req.params;
    const { question, format, options, correct_answer, order_index } = req.body;

    if (!question || !format || !correct_answer) {
      return res.status(400).json({ success: false, error: 'question, format, and correct_answer are required' });
    }

    if (!['multiple_choice', 'type_answer'].includes(format)) {
      return res.status(400).json({ success: false, error: 'format must be multiple_choice or type_answer' });
    }

    // Get current question count for auto order_index
    const { count } = await supabase
      .from('blitz_questions')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', id);

    const { data, error } = await supabase
      .from('blitz_questions')
      .insert({
        tournament_id: id,
        question,
        format,
        options: options || null,
        correct_answer,
        order_index: order_index ?? (count || 0) + 1,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: 'Failed to add question: ' + error.message });

    return res.status(201).json({ success: true, data: { question: data } });
  } catch (err) {
    console.error('Add blitz question error:', err);
    return res.status(500).json({ success: false, error: 'Failed to add question' });
  }
});

/**
 * DELETE /api/admin/blitz/:id/questions/:qid
 * Remove a question from tournament
 */
router.delete('/:id/questions/:qid', async (req, res) => {
  try {
    const { id, qid } = req.params;

    const { error } = await supabase
      .from('blitz_questions')
      .delete()
      .eq('id', qid)
      .eq('tournament_id', id);

    if (error) return res.status(500).json({ success: false, error: 'Failed to remove question' });

    return res.json({ success: true, data: { message: 'Question removed' } });
  } catch (err) {
    console.error('Remove blitz question error:', err);
    return res.status(500).json({ success: false, error: 'Failed to remove question' });
  }
});

// ─── STATUS TRANSITIONS ───────────────────────────────────────────────────────

/**
 * POST /api/admin/blitz/:id/publish
 * draft → registration
 */
router.post('/:id/publish', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: tournament } = await supabase.from('blitz_tournaments').select('status, question_count').eq('id', id).single();
    if (!tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });
    if (tournament.status !== 'draft') return res.status(400).json({ success: false, error: `Cannot publish: status is ${tournament.status}` });

    // Verify questions match question_count
    const { count } = await supabase.from('blitz_questions').select('id', { count: 'exact', head: true }).eq('tournament_id', id);
    if ((count || 0) < tournament.question_count) {
      return res.status(400).json({
        success: false,
        error: `Tournament needs ${tournament.question_count} questions but only has ${count || 0}`,
      });
    }

    const { data } = await supabase.from('blitz_tournaments').update({ status: 'registration' }).eq('id', id).select().single();

    // Notify all players about new tournament
    const { data: allPlayers } = await supabase.from('players').select('id');
    if (allPlayers && allPlayers.length > 0) {
      await createNotifications(allPlayers.map((p) => ({
        player_id: p.id,
        type: 'new_event',
        title: 'New Blitz Tournament! ⚡',
        message: `${data.title} — Register now`,
      })));
    }

    return res.json({ success: true, data: { tournament: data } });
  } catch (err) {
    console.error('Publish blitz error:', err);
    return res.status(500).json({ success: false, error: 'Failed to publish tournament' });
  }
});

/**
 * POST /api/admin/blitz/:id/activate
 * registration → active
 */
router.post('/:id/activate', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: tournament } = await supabase.from('blitz_tournaments').select('status').eq('id', id).single();
    if (!tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });
    if (tournament.status !== 'registration') return res.status(400).json({ success: false, error: `Cannot activate: status is ${tournament.status}` });

    const { data } = await supabase.from('blitz_tournaments').update({ status: 'active' }).eq('id', id).select().single();
    return res.json({ success: true, data: { tournament: data } });
  } catch (err) {
    console.error('Activate blitz error:', err);
    return res.status(500).json({ success: false, error: 'Failed to activate tournament' });
  }
});

/**
 * POST /api/admin/blitz/:id/score
 * active/scoring → completed
 * Ranks all players, distributes prizes, sets status to completed
 */
router.post('/:id/score', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: tournament } = await supabase.from('blitz_tournaments').select('*').eq('id', id).single();
    if (!tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });
    if (!['active', 'scoring'].includes(tournament.status)) {
      return res.status(400).json({ success: false, error: `Cannot score: status is ${tournament.status}` });
    }

    // Set to scoring first
    await supabase.from('blitz_tournaments').update({ status: 'scoring' }).eq('id', id);

    // Get ranked leaderboard: score desc, time asc
    const { data: attempts } = await supabase
      .from('blitz_attempts')
      .select('id, player_id, score, total_time_ms')
      .eq('tournament_id', id)
      .eq('status', 'completed')
      .order('score', { ascending: false })
      .order('total_time_ms', { ascending: true });

    const distribution = calcPrizeDistribution(tournament.prize_pool, tournament.platform_cut_percent, tournament.total_registered);

    const prizeRecords = [];
    let totalCashPaid = 0;

    for (let i = 0; i < (attempts || []).length; i++) {
      const attempt = attempts[i];
      const position = i + 1;

      // Check cash prize
      const cashPrize = distribution.cash.find((c) => c.position === position);
      if (cashPrize && cashPrize.amount > 0) {
        // Credit player
        const { data: player } = await supabase.from('players').select('balance').eq('id', attempt.player_id).single();
        await supabase.from('players').update({ balance: (player?.balance || 0) + cashPrize.amount }).eq('id', attempt.player_id);
        await supabase.from('transactions').insert({
          player_id: attempt.player_id,
          type: 'blitz_prize',
          amount: cashPrize.amount,
          description: `Blitz tournament prize - Position ${position}: ${tournament.title}`,
        });
        prizeRecords.push({
          tournament_id: id,
          player_id: attempt.player_id,
          position,
          prize_type: 'cash',
          amount: cashPrize.amount,
          ticket_code: null,
        });
        totalCashPaid += cashPrize.amount;
      }

      // Check free ticket prize
      if (distribution.freeTickets.includes(position)) {
        const ticketCode = generateTicketCode();
        prizeRecords.push({
          tournament_id: id,
          player_id: attempt.player_id,
          position,
          prize_type: 'free_ticket',
          amount: 0,
          ticket_code: ticketCode,
        });
      }
    }

    // Insert all prize records
    if (prizeRecords.length > 0) {
      await supabase.from('blitz_prizes').insert(prizeRecords);
    }

    // Mark as completed
    await supabase.from('blitz_tournaments').update({ status: 'completed' }).eq('id', id);

    return res.json({
      success: true,
      data: {
        message: 'Tournament scored and prizes distributed',
        total_participants: attempts?.length || 0,
        total_cash_distributed: totalCashPaid,
        total_free_tickets: prizeRecords.filter((p) => p.prize_type === 'free_ticket').length,
      },
    });
  } catch (err) {
    console.error('Score blitz error:', err);
    return res.status(500).json({ success: false, error: 'Failed to score tournament' });
  }
});

// ─── ADMIN VIEWS ──────────────────────────────────────────────────────────────

/**
 * GET /api/admin/blitz/:id/leaderboard
 * Full ranked leaderboard
 */
router.get('/:id/leaderboard', async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const { data: attempts, count } = await supabase
      .from('blitz_attempts')
      .select('player_id, score, total_time_ms, completed_at, players(id, phone, name)', { count: 'exact' })
      .eq('tournament_id', id)
      .eq('status', 'completed')
      .order('score', { ascending: false })
      .order('total_time_ms', { ascending: true })
      .range(offset, offset + Number(limit) - 1);

    const leaderboard = (attempts || []).map((a, i) => ({
      position: offset + i + 1,
      player_id: a.player_id,
      name: a.players?.name || null,
      phone: a.players?.phone || null,
      score: a.score,
      total_time_ms: a.total_time_ms,
      completed_at: a.completed_at,
    }));

    return res.json({ success: true, data: { leaderboard, total: count, page: Number(page), limit: Number(limit) } });
  } catch (err) {
    console.error('Admin blitz leaderboard error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch leaderboard' });
  }
});

module.exports = router;
