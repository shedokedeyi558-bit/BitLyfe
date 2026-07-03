const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

/**
 * GET /api/predictions/active
 * Returns only active predictions with countdown remaining
 */
router.get('/active', auth, async (req, res) => {
  try {
    const now = new Date().toISOString();

    const { data: predictions, error } = await supabase
      .from('predictions')
      .select('id, question, category, entry_fee, prize_per_winner, max_participants, current_participants, countdown_end_time, status')
      .eq('status', 'active')
      .order('countdown_end_time', { ascending: true });

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
        fee: parseFloat(p.entry_fee),
        prize_per_winner: parseFloat(p.prize_per_winner),
        slots_filled: p.current_participants,
        max_slots: p.max_participants,
        countdown_end: p.countdown_end_time,
        countdown_remaining_seconds: remaining,
        status: p.status,
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
 * Body: { predictionId }
 */
router.post('/enter', auth, async (req, res) => {
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

    // Check balance
    if (player.balance < entryFee) {
      return res.status(402).json({ success: false, error: 'Insufficient balance' });
    }

    // Check if already participated
    const { data: existing } = await supabase
      .from('prediction_participations')
      .select('id')
      .eq('prediction_id', predictionId)
      .eq('player_id', player.id)
      .single();

    if (existing) {
      return res.status(409).json({ success: false, error: 'Already participated in this prediction' });
    }

    // Deduct entry fee
    const newBalance = player.balance - entryFee;
    await supabase.from('players').update({ balance: newBalance }).eq('id', player.id);

    // Create participation record
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

    // Record transaction
    await supabase.from('transactions').insert({
      player_id: player.id,
      type: 'prediction_enter',
      amount: -entryFee,
      description: `Entered prediction: ${prediction.question.substring(0, 50)}...`,
    });

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
        newBalance: newBalance,
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
      return res.status(409).json({ success: false, error: 'Already submitted' });
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
 * GET /api/predictions/result/:id
 * Get result of a prediction (only if answer is marked)
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
      return res.status(404).json({ success: false, error: 'Prediction not found' });
    }

    // Check if correct_answer is set
    if (!prediction.correct_answer) {
      return res.status(404).json({ success: false, error: 'Result not available yet' });
    }

    // Fetch player's participation
    const { data: participation, error: partErr } = await supabase
      .from('prediction_participations')
      .select('*')
      .eq('prediction_id', predictionId)
      .eq('player_id', player.id)
      .single();

    if (partErr || !participation) {
      return res.status(404).json({ success: false, error: 'Not participated in this prediction' });
    }

    const won = participation.is_correct === true;
    const amountWon = parseFloat(participation.amount_won) || 0;

    // Get fresh player balance
    const { data: freshPlayer } = await supabase
      .from('players')
      .select('balance')
      .eq('id', player.id)
      .single();

    return res.json({
      success: true,
      data: {
        won: won,
        correctAnswer: prediction.correct_answer,
        yourAnswer: participation.answer,
        prize: amountWon,
        newBalance: parseFloat(freshPlayer.balance),
      },
    });
  } catch (err) {
    console.error('Get prediction result error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch prediction result' });
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
