const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');
const { checkAnswer, sanitizeQuestion } = require('../services/gameLogic');

const router = express.Router();

/**
 * GET /api/pills/available
 * Returns all unopened pills
 */
router.get('/available', auth, async (req, res) => {
  try {
    const { data: pills, error } = await supabase
      .from('pills')
      .select('id, question, category, entry_fee, prize, status, format, timer_seconds')
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
 * Deduct entry fee and open a pill (reveal question)
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

    // Check if already played
    if (pill.status === 'played') {
      return res.status(409).json({ success: false, error: 'Pill already played' });
    }

    if (pill.status === 'expired') {
      return res.status(409).json({ success: false, error: 'Pill has expired' });
    }

    const entryFee = parseFloat(pill.entry_fee);

    // Check balance
    if (player.balance < entryFee) {
      return res.status(402).json({ success: false, error: 'Insufficient balance' });
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
      description: `Opened pill: ${pill.question.substring(0, 50)}...`,
    });

    // Return question without correct answer
    const sanitizedQuestion = {
      question: pill.question,
      category: pill.category,
      format: pill.format,
      options: pill.options,
      timer: pill.timer_seconds,
      prize: parseFloat(pill.prize),
      entryFee: entryFee,
      newBalance: player.balance - entryFee,
    };

    return res.json({
      success: true,
      data: sanitizedQuestion,
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

    if (pill.status !== 'played') {
      return res.status(409).json({ success: false, error: 'Pill must be opened first' });
    }

    // Check answer
    const correct = checkAnswer(pill, String(answer));
    const prize = parseFloat(pill.prize);

    if (correct) {
      // Fetch fresh player balance
      const { data: freshPlayer } = await supabase
        .from('players')
        .select('balance')
        .eq('id', player.id)
        .single();

      const newBalance = (freshPlayer.balance || 0) + prize;

      // Credit prize
      await supabase
        .from('players')
        .update({ balance: newBalance })
        .eq('id', player.id);

      // Record transaction
      await supabase.from('transactions').insert({
        player_id: player.id,
        type: 'pill_win',
        amount: prize,
        description: `Won pill: ${pill.question.substring(0, 50)}...`,
      });

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

    // Wrong answer
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
