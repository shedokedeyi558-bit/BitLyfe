const express = require('express');
const supabase = require('../db/supabase');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// Apply admin auth to all routes in this file
router.use(adminAuth);

/**
 * GET /api/admin/predictions
 * List all predictions (paginated)
 */
router.get('/', async (req, res) => {
  try {
    const { status, category, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabase
      .from('predictions')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status) query = query.eq('status', status);
    if (category) query = query.eq('category', category);

    const { data, error, count } = await query;

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch predictions' });

    return res.json({
      success: true,
      data: {
        predictions: data,
        total: count,
        page: Number(page),
        limit: Number(limit),
      },
    });
  } catch (err) {
    console.error('Get predictions error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch predictions' });
  }
});

/**
 * POST /api/admin/predictions
 * Create a new prediction
 */
router.post('/', async (req, res) => {
  try {
    const { question, category, entry_fee, prize_per_winner, max_participants, countdown_seconds } = req.body;

    if (!question || entry_fee === undefined || prize_per_winner === undefined || !countdown_seconds) {
      return res.status(400).json({
        success: false,
        error: 'question, entry_fee, prize_per_winner, and countdown_seconds are required',
      });
    }

    // Calculate countdown end time
    const countdownEndTime = new Date(Date.now() + countdown_seconds * 1000).toISOString();

    const { data, error } = await supabase
      .from('predictions')
      .insert({
        admin_id: req.admin.id,
        question,
        category: category || 'General',
        entry_fee: Number(entry_fee),
        prize_per_winner: Number(prize_per_winner),
        max_participants: max_participants || 10,
        countdown_seconds: Number(countdown_seconds),
        countdown_end_time: countdownEndTime,
        status: 'active',
      })
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: 'Failed to create prediction' });

    return res.status(201).json({ success: true, data: { prediction: data } });
  } catch (err) {
    console.error('Create prediction error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create prediction' });
  }
});

/**
 * GET /api/admin/predictions/:id
 * Single prediction detail — same shape as entries in GET /api/admin/games,
 * plus participants_summary: { total, submitted, pending_submission }
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: prediction, error } = await supabase
      .from('predictions')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !prediction) {
      return res.status(404).json({ success: false, error: 'Prediction not found' });
    }

    // participants_summary — count directly, no need to fetch all rows
    const [totalRes, submittedRes] = await Promise.all([
      supabase
        .from('prediction_participations')
        .select('id', { count: 'exact', head: true })
        .eq('prediction_id', id),
      supabase
        .from('prediction_participations')
        .select('id', { count: 'exact', head: true })
        .eq('prediction_id', id)
        .not('answer', 'is', null),
    ]);

    const total     = totalRes.count     || 0;
    const submitted = submittedRes.count || 0;

    // Match the formatPrediction shape from GET /api/admin/games
    const now = Date.now();
    const countdownEnd = new Date(prediction.countdown_end_time).getTime();

    return res.json({
      success: true,
      data: {
        prediction: {
          id: prediction.id,
          game_type: 'predictions',
          title: prediction.question,
          question: prediction.question,
          category: prediction.category,
          status: prediction.status,
          entry_fee: Number(prediction.entry_fee),
          fee: Number(prediction.entry_fee),
          prize_per_winner: Number(prediction.prize_per_winner),
          max_slots: prediction.max_participants,
          slots_filled: prediction.current_participants,
          countdown_end: prediction.countdown_end_time,
          countdown_remaining_seconds: Math.max(0, Math.floor((countdownEnd - now) / 1000)),
          correct_answer: prediction.correct_answer || null,
          event_date: prediction.event_date || null,
          created_at: prediction.created_at,
          stats: {
            total_players: prediction.current_participants,
            revenue: prediction.current_participants * Number(prediction.entry_fee),
          },
          participants_summary: {
            total,
            submitted,
            pending_submission: total - submitted,
          },
        },
      },
    });
  } catch (err) {
    console.error('Get single prediction error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch prediction' });
  }
});

/**
 * PUT /api/admin/predictions/:id
 * Update a prediction (question, prize, etc.)
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Prevent updating these fields
    delete updates.id;
    delete updates.admin_id;
    delete updates.created_at;
    delete updates.correct_answer; // Use mark-answer endpoint instead

    const { data, error } = await supabase
      .from('predictions')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ success: false, error: 'Prediction not found or update failed' });

    return res.json({ success: true, data: { prediction: data } });
  } catch (err) {
    console.error('Update prediction error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update prediction' });
  }
});

/**
 * POST /api/admin/predictions/:id/mark-answer
 * Mark correct answer and credit winners
 */
router.post('/:id/mark-answer', async (req, res) => {
  try {
    const { id } = req.params;
    const { correctAnswer } = req.body;

    if (!correctAnswer) {
      return res.status(400).json({ success: false, error: 'correctAnswer is required' });
    }

    // Fetch prediction
    const { data: prediction, error: predErr } = await supabase
      .from('predictions')
      .select('*')
      .eq('id', id)
      .single();

    if (predErr || !prediction) {
      return res.status(404).json({ success: false, error: 'Prediction not found' });
    }

    // Fetch all participations
    const { data: participations } = await supabase
      .from('prediction_participations')
      .select('*')
      .eq('prediction_id', id);

    const prizePerWinner = parseFloat(prediction.prize_per_winner);
    let winnersCount = 0;

    // Update each participation
    for (const part of participations) {
      const isCorrect = String(part.answer).toLowerCase().trim() === String(correctAnswer).toLowerCase().trim();

      await supabase
        .from('prediction_participations')
        .update({
          is_correct: isCorrect,
          amount_won: isCorrect ? prizePerWinner : 0,
        })
        .eq('id', part.id);

      // Credit winners
      if (isCorrect) {
        winnersCount++;
        const { data: player } = await supabase
          .from('players')
          .select('balance')
          .eq('id', part.player_id)
          .single();

        const newBalance = (player.balance || 0) + prizePerWinner;

        await supabase.from('players').update({ balance: newBalance }).eq('id', part.player_id);

        await supabase.from('transactions').insert({
          player_id: part.player_id,
          type: 'prediction_win',
          amount: prizePerWinner,
          description: `Won prediction: ${prediction.question.substring(0, 50)}...`,
        });
      }
    }

    // Update prediction status
    await supabase
      .from('predictions')
      .update({
        correct_answer: correctAnswer,
        status: 'completed',
      })
      .eq('id', id);

    return res.json({
      success: true,
      data: {
        message: 'Prediction marked and winners credited',
        prediction: {
          id: prediction.id,
          question: prediction.question,
          correctAnswer: correctAnswer,
          status: 'completed',
          totalParticipants: participations?.length || 0,
          winnersCount: winnersCount,
          totalPrizeDistributed: winnersCount * prizePerWinner,
        },
      },
    });
  } catch (err) {
    console.error('Mark prediction answer error:', err);
    return res.status(500).json({ success: false, error: 'Failed to mark prediction answer' });
  }
});

/**
 * POST /api/admin/predictions/:id/cancel
 * Cancel a prediction (refund all participants)
 */
router.post('/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch prediction
    const { data: prediction, error: predErr } = await supabase
      .from('predictions')
      .select('*')
      .eq('id', id)
      .single();

    if (predErr || !prediction) {
      return res.status(404).json({ success: false, error: 'Prediction not found' });
    }

    // Fetch all participations
    const { data: participations } = await supabase
      .from('prediction_participations')
      .select('*')
      .eq('prediction_id', id);

    const entryFee = parseFloat(prediction.entry_fee);

    // Refund each participant
    for (const part of participations) {
      const { data: player } = await supabase
        .from('players')
        .select('balance')
        .eq('id', part.player_id)
        .single();

      const newBalance = (player.balance || 0) + entryFee;

      await supabase.from('players').update({ balance: newBalance }).eq('id', part.player_id);

      await supabase.from('transactions').insert({
        player_id: part.player_id,
        type: 'prediction_refund',
        amount: entryFee,
        description: `Refunded from cancelled prediction: ${prediction.question.substring(0, 50)}...`,
      });
    }

    // Update prediction status
    await supabase.from('predictions').update({ status: 'cancelled' }).eq('id', id);

    return res.json({
      success: true,
      data: {
        message: `Prediction cancelled. ${participations?.length || 0} participants refunded.`,
        prediction: {
          id: prediction.id,
          status: 'cancelled',
          refundedCount: participations?.length || 0,
          totalRefunded: (participations?.length || 0) * entryFee,
        },
      },
    });
  } catch (err) {
    console.error('Cancel prediction error:', err);
    return res.status(500).json({ success: false, error: 'Failed to cancel prediction' });
  }
});

/**
 * GET /api/admin/predictions/:id/participations
 * View all participations for a prediction (raw, paginated)
 */
router.get('/:id/participations', async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const { data, error, count } = await supabase
      .from('prediction_participations')
      .select('*, players(phone, name)', { count: 'exact' })
      .eq('prediction_id', id)
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch participations' });

    return res.json({
      success: true,
      data: {
        participations: data,
        total: count,
        page: Number(page),
        limit: Number(limit),
      },
    });
  } catch (err) {
    console.error('Get participations error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch participations' });
  }
});

/**
 * GET /api/admin/predictions/:id/participants
 * Review all participants before revealing an answer.
 * Returns masked phone, submitted answer, and submission timestamp.
 * Participants who entered but haven't submitted yet are included (answer will be null).
 */
router.get('/:id/participants', async (req, res) => {
  try {
    const { id } = req.params;

    // Verify prediction exists
    const { data: prediction, error: predErr } = await supabase
      .from('predictions')
      .select('id, question, status, current_participants')
      .eq('id', id)
      .single();

    if (predErr || !prediction) {
      return res.status(404).json({ success: false, error: 'Prediction not found' });
    }

    const { data: participations, error } = await supabase
      .from('prediction_participations')
      .select('id, answer, submitted_at, created_at, players(phone, name)')
      .eq('prediction_id', id)
      .order('submitted_at', { ascending: true, nullsFirst: false });

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch participants' });
    }

    const participants = (participations || []).map((p) => {
      const phone = p.players?.phone || '';
      // Mask: keep first 4 and last 2 digits, replace middle with ***
      const masked = phone.length >= 6
        ? `${phone.slice(0, 4)}***${phone.slice(-2)}`
        : '***';

      return {
        id: p.id,
        phone: masked,
        name: p.players?.name || null,
        answer: p.answer || null,
        submitted_at: p.submitted_at || null,
        has_submitted: p.answer !== null,
        entered_at: p.created_at,
      };
    });

    const submittedCount = participants.filter((p) => p.has_submitted).length;
    const pendingCount = participants.length - submittedCount;

    return res.json({
      success: true,
      data: {
        prediction: {
          id: prediction.id,
          question: prediction.question,
          status: prediction.status,
        },
        summary: {
          total: participants.length,
          submitted: submittedCount,
          pending_submission: pendingCount,
        },
        participants,
      },
    });
  } catch (err) {
    console.error('Get prediction participants error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch participants' });
  }
});

/**
 * GET /api/admin/predictions/stats
 * Prediction statistics and analytics
 */
router.get('/stats', async (req, res) => {
  try {
    const { data: allPredictions } = await supabase.from('predictions').select('*');
    const { data: allParticipations } = await supabase.from('prediction_participations').select('*');

    const stats = {
      total: allPredictions?.length || 0,
      active: allPredictions?.filter((p) => p.status === 'active').length || 0,
      locked: allPredictions?.filter((p) => p.status === 'locked').length || 0,
      completed: allPredictions?.filter((p) => p.status === 'completed').length || 0,
      cancelled: allPredictions?.filter((p) => p.status === 'cancelled').length || 0,
      totalParticipations: allParticipations?.length || 0,
      totalRevenueGenerated: allPredictions?.reduce((sum, p) => sum + (parseFloat(p.entry_fee) * p.current_participants || 0), 0) || 0,
      totalPrizeDistributed: allParticipations?.reduce((sum, p) => sum + (parseFloat(p.amount_won) || 0), 0) || 0,
    };

    return res.json({ success: true, data: { stats } });
  } catch (err) {
    console.error('Predictions stats error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch prediction stats' });
  }
});

module.exports = router;
