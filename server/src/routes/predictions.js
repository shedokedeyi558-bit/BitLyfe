const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const idempotency = require('../middleware/idempotency');
const { checkReferralCompletion } = require('./referrals');
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
 * GET /api/predictions/active
 * Returns all predictions visible to players: active, locked, completed
 */
router.get('/active', auth, async (req, res) => {
  try {
    const now = new Date().toISOString();

    const { data: predictions, error } = await supabase
      .from('predictions')
      .select('id, question, category, entry_fee, prize_per_winner, max_participants, current_participants, countdown_end_time, status, event_date')
      .in('status', ['active', 'locked', 'completed'])
      .order('countdown_end_time', { ascending: false });

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch predictions' });
    }

    const result = predictions.map((p) => {
      const countdownEnd = new Date(p.countdown_end_time).getTime();
      const nowTime = new Date(now).getTime();
      const remaining = Math.max(0, Math.floor((countdownEnd - nowTime) / 1000));

      return {
        id: p.id,
        question: p.question,
        category: p.category,
        fee: parseFloat(p.entry_fee),          // always "fee" not "entry_fee"
        prize_per_winner: parseFloat(p.prize_per_winner),
        slots_filled: p.current_participants,
        max_slots: p.max_participants,
        countdown_end: p.countdown_end_time,
        countdown_remaining_seconds: remaining,
        status: p.status,
        event_date: p.event_date || null,
      };
    });

    return res.json({ success: true, data: { predictions: result } });
  } catch (err) {
    console.error('Get active predictions error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch predictions' });
  }
});

/**
 * POST /api/predictions/enter
 * Join a prediction by deducting entry fee
 * Body: { predictionId, idempotency_key? }
 */
router.post('/enter', idempotency(), auth, async (req, res) => {
  try {
    const { predictionId } = req.body;
    const player = req.player;

    if (!predictionId) {
      return res.status(400).json({ success: false, error: 'predictionId is required' });
    }

    // Fetch prediction
    const { data: prediction, error: predErr } = await supabase
      .from('predictions')
      .select('*')
      .eq('id', predictionId)
      .single();

    if (predErr || !prediction) {
      return res.status(404).json({ success: false, error: 'Prediction not found' });
    }

    // Check if active
    if (prediction.status !== 'active') {
      return res.status(409).json({ success: false, error: 'Prediction is not active' });
    }

    // Check if slots full
    if (prediction.current_participants >= prediction.max_participants) {
      return res.status(409).json({ success: false, error: 'Prediction full' });
    }

    const entryFee = parseFloat(prediction.entry_fee);

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
        type: 'prediction_enter',
        description: `Entered prediction: ${prediction.question.substring(0, 50)}...`,
      });
    } catch (billingErr) {
      if (billingErr.insufficientFunds) return res.status(402).json({ success: false, error: billingErr.message });
      throw billingErr;
    }

    // Check if already participated — idempotency: return existing state, never double-charge
    const { data: existing } = await supabase
      .from('prediction_participations')
      .select('id, answer, submitted_at')
      .eq('prediction_id', predictionId)
      .eq('player_id', player.id)
      .maybeSingle();

    if (existing) {
      // Already paid — route frontend to the correct step based on answer state
      return res.json({
        success: true,
        already_entered: true,
        data: {
          prediction: {
            id: prediction.id,
            question: prediction.question,
            category: prediction.category,
            fee: parseFloat(prediction.entry_fee),
            prize_per_winner: parseFloat(prediction.prize_per_winner),
            slots_filled: prediction.current_participants,
            max_slots: prediction.max_participants,
            countdown_end: prediction.countdown_end_time,
            status: prediction.status,
          },
          participation_state: existing.answer !== null ? 'submitted_waiting' : 'entered_not_submitted',
          has_submitted: existing.answer !== null,
          newBalance: player.balance, // balance unchanged — already charged
        },
      });
    }

    // Create participation record (answer is null until /submit is called)
    await supabase.from('prediction_participations').insert({
      prediction_id: predictionId,
      player_id: player.id,
      answer: null,
      submitted_at: null,
    });

    // Increment current_participants
    const newParticipantCount = prediction.current_participants + 1;
    let newStatus = prediction.status;

    if (newParticipantCount >= prediction.max_participants) {
      newStatus = 'locked';
    }

    await supabase
      .from('predictions')
      .update({
        current_participants: newParticipantCount,
        status: newStatus,
      })
      .eq('id', predictionId);

    // Trigger referral first-game check (fire-and-forget)
    checkReferralCompletion(player.id, 'game').catch(() => {});

    return res.json({
      success: true,
      data: {
        prediction: {
          id: prediction.id,
          question: prediction.question,
          category: prediction.category,
          fee: parseFloat(prediction.entry_fee),
          prize_per_winner: parseFloat(prediction.prize_per_winner),
          slots_filled: newParticipantCount,
          max_slots: prediction.max_participants,
          countdown_end: prediction.countdown_end_time,
          status: newStatus,
        },
        newBalance: billing.newBalance,
        newBonusBalance: billing.newBonusBalance,
        bonusUsed: billing.bonusUsed,
      },
    });
  } catch (err) {
    console.error('Enter prediction error:', err);
    return res.status(500).json({ success: false, error: 'Failed to enter prediction' });
  }
});

/**
 * POST /api/predictions/submit
 * Submit answer to a prediction
 * Body: { predictionId, answer }
 */
router.post('/submit', auth, async (req, res) => {
  try {
    const { predictionId, answer } = req.body;
    const player = req.player;

    if (!predictionId || answer === undefined || answer === null) {
      return res.status(400).json({ success: false, error: 'predictionId and answer are required' });
    }

    // Fetch participation record
    const { data: participation, error: partErr } = await supabase
      .from('prediction_participations')
      .select('*')
      .eq('prediction_id', predictionId)
      .eq('player_id', player.id)
      .single();

    if (partErr || !participation) {
      return res.status(404).json({ success: false, error: 'Not participated in this prediction' });
    }

    // Check if already submitted
    if (participation.answer !== null) {
      return res.status(409).json({ success: false, error: 'Already submitted your prediction' });
    }

    // Update participation with answer
    await supabase
      .from('prediction_participations')
      .update({
        answer: String(answer),
        submitted_at: new Date().toISOString(),
      })
      .eq('id', participation.id);

    return res.json({
      success: true,
      data: { message: 'Prediction submitted' },
    });
  } catch (err) {
    console.error('Submit prediction error:', err);
    return res.status(500).json({ success: false, error: 'Failed to submit prediction' });
  }
});

/**
 * GET /api/predictions/:id/my-participation
 * Single source of truth for a player's state in a prediction.
 * States: never_entered | entered_not_submitted | submitted_waiting | result_available
 */
router.get('/:id/my-participation', auth, async (req, res) => {
  try {
    const { id: predictionId } = req.params;
    const player = req.player;

    const { data: prediction, error: predErr } = await supabase
      .from('predictions')
      .select('id, question, category, entry_fee, prize_per_winner, max_participants, current_participants, countdown_end_time, status, correct_answer, event_date')
      .eq('id', predictionId)
      .single();

    if (predErr || !prediction) {
      return res.status(404).json({ success: false, error: 'Prediction not found' });
    }

    const { data: participation } = await supabase
      .from('prediction_participations')
      .select('id, answer, submitted_at, is_correct, amount_won')
      .eq('prediction_id', predictionId)
      .eq('player_id', player.id)
      .maybeSingle();

    // Determine state
    let state;
    if (!participation) {
      state = 'never_entered';
    } else if (participation.answer === null) {
      state = 'entered_not_submitted';
    } else if (prediction.status !== 'completed' || !prediction.correct_answer) {
      state = 'submitted_waiting';
    } else {
      state = 'result_available';
    }

    return res.json({
      success: true,
      data: {
        state,
        prediction: {
          id: prediction.id,
          question: prediction.question,
          category: prediction.category,
          fee: parseFloat(prediction.entry_fee),
          prize_per_winner: parseFloat(prediction.prize_per_winner),
          slots_filled: prediction.current_participants,
          max_slots: prediction.max_participants,
          countdown_end: prediction.countdown_end_time,
          status: prediction.status,
          event_date: prediction.event_date || null,
        },
        participation: participation ? {
          answer: participation.answer,
          submitted_at: participation.submitted_at,
          is_correct: participation.is_correct,
          amount_won: parseFloat(participation.amount_won || 0),
        } : null,
      },
    });
  } catch (err) {
    console.error('My-participation error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch participation state' });
  }
});

/**
 * POST /api/predictions/refund-expired
 * Auto-refund entry fees for participations with no submitted answer
 * on predictions that have passed their countdown deadline.
 * Called by admin or a scheduled task — idempotent (checks for existing refund transaction).
 */
router.post('/refund-expired', adminAuth, async (req, res) => {
  try {
    const now = new Date().toISOString();

    // Find predictions that are locked/completed with unsubmitted participations
    const { data: stuckParticipations } = await supabase
      .from('prediction_participations')
      .select('id, player_id, prediction_id, predictions(entry_fee, question, countdown_end_time, status)')
      .is('answer', null)
      .is('submitted_at', null);

    if (!stuckParticipations || stuckParticipations.length === 0) {
      return res.json({ success: true, data: { refunded: 0, message: 'No stuck participations found' } });
    }

    let refundCount = 0;

    for (const part of stuckParticipations) {
      const pred = part.predictions;
      if (!pred) continue;

      // Only refund if deadline has passed
      const deadlinePassed = new Date(pred.countdown_end_time) < new Date(now);
      if (!deadlinePassed) continue;

      // Idempotency: skip if already refunded
      const { data: existingRefund } = await supabase
        .from('transactions')
        .select('id')
        .eq('player_id', part.player_id)
        .eq('type', 'prediction_refund')
        .like('description', `%${part.prediction_id}%`)
        .maybeSingle();

      if (existingRefund) continue;

      const entryFee = parseFloat(pred.entry_fee);

      // Credit refund
      const { data: freshPlayer } = await supabase.from('players').select('balance').eq('id', part.player_id).single();
      await supabase.from('players').update({ balance: (freshPlayer?.balance || 0) + entryFee }).eq('id', part.player_id);
      await supabase.from('transactions').insert({
        player_id: part.player_id,
        type: 'prediction_refund',
        amount: entryFee,
        description: `Auto-refund: prediction ${part.prediction_id} expired without answer submission`,
      });

      refundCount++;
    }

    return res.json({ success: true, data: { refunded: refundCount } });
  } catch (err) {
    console.error('Refund expired predictions error:', err);
    return res.status(500).json({ success: false, error: 'Failed to process refunds' });
  }
});

/**
 * GET /api/predictions/my-predictions?status=active|settled
 * Returns all predictions the authenticated player has entered, split by status.
 *
 * active  — prediction outcome not yet revealed; player entered (with or without an answer)
 *           Fields: id, question, category, entry_fee, prize_per_winner, my_answer,
 *                   state (entered_not_submitted | submitted_waiting), countdown_end, needs_submission
 *           Order: soonest countdown_end first
 *
 * settled — prediction is completed and correct_answer is set; player participated
 *           Fields: id, question, category, my_answer, correct_answer, won, amount_won, completed_at
 *           Order: most recently completed first
 */
router.get('/my-predictions', auth, async (req, res) => {
  try {
    const { status } = req.query;
    const player = req.player;

    if (!status || !['active', 'settled'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Query param status must be "active" or "settled"' });
    }

    // Fetch all participations for this player, joining the prediction
    const { data: participations, error } = await supabase
      .from('prediction_participations')
      .select(`
        id,
        answer,
        submitted_at,
        is_correct,
        amount_won,
        created_at,
        predictions (
          id,
          question,
          category,
          entry_fee,
          prize_per_winner,
          countdown_end_time,
          status,
          correct_answer,
          updated_at
        )
      `)
      .eq('player_id', player.id);

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch predictions' });
    }

    let predictions;

    if (status === 'active') {
      // Active: prediction hasn't been revealed yet (no correct_answer, or status not completed)
      const active = (participations || []).filter((p) => {
        const pred = p.predictions;
        return pred && (pred.status !== 'completed' || !pred.correct_answer);
      });

      // Order by soonest countdown_end first
      active.sort((a, b) =>
        new Date(a.predictions.countdown_end_time) - new Date(b.predictions.countdown_end_time)
      );

      predictions = active.map((p) => {
        const pred = p.predictions;
        const hasSubmitted = p.answer !== null;
        const state = hasSubmitted ? 'submitted_waiting' : 'entered_not_submitted';

        return {
          id: pred.id,
          question: pred.question,
          category: pred.category,
          entry_fee: parseFloat(pred.entry_fee),
          prize_per_winner: parseFloat(pred.prize_per_winner),
          my_answer: p.answer || null,
          state,
          countdown_end: pred.countdown_end_time,
          needs_submission: !hasSubmitted,
        };
      });
    } else {
      // Settled: prediction completed with correct_answer revealed
      const settled = (participations || []).filter((p) => {
        const pred = p.predictions;
        return pred && pred.status === 'completed' && pred.correct_answer;
      });

      // Order by most recently completed (use updated_at as proxy for completed_at)
      settled.sort((a, b) =>
        new Date(b.predictions.updated_at) - new Date(a.predictions.updated_at)
      );

      predictions = settled.map((p) => {
        const pred = p.predictions;

        return {
          id: pred.id,
          question: pred.question,
          category: pred.category,
          my_answer: p.answer || null,
          correct_answer: pred.correct_answer,
          won: p.is_correct === true,
          amount_won: parseFloat(p.amount_won || 0),
          completed_at: pred.updated_at,
        };
      });
    }

    return res.json({ success: true, data: { predictions } });
  } catch (err) {
    console.error('My-predictions error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch my predictions' });
  }
});

/**
 * GET /api/predictions/my-answer/:id
 * Returns the authenticated player's submitted answer for a prediction
 */
router.get('/my-answer/:id', auth, async (req, res) => {
  try {
    const { id: predictionId } = req.params;
    const player = req.player;

    const { data: participation, error } = await supabase
      .from('prediction_participations')
      .select('answer, submitted_at')
      .eq('prediction_id', predictionId)
      .eq('player_id', player.id)
      .single();

    if (error || !participation) {
      return res.status(404).json({ success: false, error: 'Not participated' });
    }

    return res.json({
      success: true,
      data: {
        answer: participation.answer,
        submitted_at: participation.submitted_at,
      },
    });
  } catch (err) {
    console.error('Get my-answer error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch answer' });
  }
});

/**
 * GET /api/predictions/result/:id
 * Get result of a prediction (only if admin has marked the answer)
 * Returns distinct 404 codes so frontend can distinguish between "not revealed yet" vs "didn't participate"
 */
router.get('/result/:id', auth, async (req, res) => {
  try {
    const { id: predictionId } = req.params;
    const player = req.player;

    // Fetch prediction
    const { data: prediction, error: predErr } = await supabase
      .from('predictions')
      .select('*')
      .eq('id', predictionId)
      .single();

    if (predErr || !prediction) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'Prediction not found' });
    }

    // Check participation first (before checking if answer revealed)
    const { data: participation } = await supabase
      .from('prediction_participations')
      .select('*')
      .eq('prediction_id', predictionId)
      .eq('player_id', player.id)
      .single();

    if (!participation) {
      return res.status(404).json({ success: false, code: 'NOT_PARTICIPANT', error: 'You did not participate in this prediction' });
    }

    // Now check if admin has revealed the answer
    if (!prediction.correct_answer || prediction.status !== 'completed') {
      return res.status(404).json({ success: false, code: 'NOT_REVEALED', error: 'Result not available yet' });
    }

    const won = participation.is_correct === true;
    const amountWon = parseFloat(participation.amount_won) || 0;

    return res.json({
      success: true,
      data: {
        won,
        correctAnswer: prediction.correct_answer,
        yourAnswer: participation.answer,
        prize: amountWon,
      },
    });
  } catch (err) {
    console.error('Get prediction result error:', err);
    return res.status(500).json({ success: false, code: 'ERROR', error: 'Failed to fetch prediction result' });
  }
});

/**
 * PUT /api/admin/predictions/:id/mark-answer
 * Mark correct answer and update all participants
 * Body: { correctAnswer }
 */
router.put('/:id/mark-answer', adminAuth, async (req, res) => {
  try {
    const { id: predictionId } = req.params;
    const { correctAnswer } = req.body;

    if (!correctAnswer) {
      return res.status(400).json({ success: false, error: 'correctAnswer is required' });
    }

    // Fetch prediction
    const { data: prediction, error: predErr } = await supabase
      .from('predictions')
      .select('*')
      .eq('id', predictionId)
      .single();

    if (predErr || !prediction) {
      return res.status(404).json({ success: false, error: 'Prediction not found' });
    }

    // Fetch all participations
    const { data: participations } = await supabase
      .from('prediction_participations')
      .select('*')
      .eq('prediction_id', predictionId);

    const prizePerWinner = parseFloat(prediction.prize_per_winner);

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
      .eq('id', predictionId);

    return res.json({
      success: true,
      data: {
        message: 'Prediction marked and winners credited',
        prediction: {
          id: prediction.id,
          question: prediction.question,
          correctAnswer: correctAnswer,
          status: 'completed',
          totalParticipants: participations.length,
          winners: participations.filter((p) => String(p.answer).toLowerCase().trim() === String(correctAnswer).toLowerCase().trim()).length,
        },
      },
    });
  } catch (err) {
    console.error('Mark prediction answer error:', err);
    return res.status(500).json({ success: false, error: 'Failed to mark prediction answer' });
  }
});

module.exports = router;
