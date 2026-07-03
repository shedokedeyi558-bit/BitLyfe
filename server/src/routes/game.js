const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');
const { checkAnswer, maskPhone, sanitizeQuestion } = require('../services/gameLogic');

const router = express.Router();

/**
 * Helper: fetch app_settings and check kill switch.
 */
async function getSettings() {
  const { data } = await supabase.from('app_settings').select('*').eq('id', 1).single();
  return data;
}

/**
 * GET /api/game/doors
 * Return all 3 active doors with their current active questions.
 */
router.get('/doors', async (req, res) => {
  try {
    const settings = await getSettings();

    if (settings?.game_kill_switch) {
      return res.status(503).json({ success: false, error: 'Game is currently unavailable' });
    }

    const { data: doors, error } = await supabase
      .from('doors')
      .select(`
        id,
        status,
        prize,
        entry_fee,
        question_id,
        questions (
          id,
          text,
          format,
          difficulty,
          prize,
          time_limit,
          options,
          status
        )
      `)
      .eq('status', 'active')
      .order('id');

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch doors' });
    }

    // Only return doors with active questions
    const activeDoors = doors
      .filter((d) => d.questions && d.questions.status === 'active')
      .map((d) => ({
        id: d.id,
        status: d.status,
        prize: d.questions.prize,
        entry_fee: d.entry_fee,
        question: {
          id: d.questions.id,
          text: d.questions.text,
          format: d.questions.format,
          difficulty: d.questions.difficulty,
          prize: d.questions.prize,
          time_limit: d.questions.time_limit,
          options: d.questions.options,
        },
      }));

    return res.json({ success: true, data: activeDoors });
  } catch (err) {
    console.error('Doors error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch doors' });
  }
});

/**
 * POST /api/game/play
 * Deduct entry fee, create game_session, return question (no correct_answer).
 */
router.post('/play', auth, async (req, res) => {
  try {
    const settings = await getSettings();

    if (settings?.game_kill_switch) {
      return res.status(503).json({ success: false, error: 'Game is currently unavailable' });
    }

    const { doorId } = req.body;
    const player = req.player;

    if (!doorId) {
      return res.status(400).json({ success: false, error: 'doorId is required' });
    }

    // Fetch door
    const { data: door, error: doorErr } = await supabase
      .from('doors')
      .select('id, status, entry_fee, prize, question_id')
      .eq('id', doorId)
      .single();

    if (doorErr || !door) {
      return res.status(404).json({ success: false, error: 'Door not found' });
    }

    if (door.status !== 'active') {
      return res.status(400).json({ success: false, error: 'This door is not active' });
    }

    if (!door.question_id) {
      return res.status(400).json({ success: false, error: 'No question assigned to this door' });
    }

    // Fetch question
    const { data: question, error: qErr } = await supabase
      .from('questions')
      .select('*')
      .eq('id', door.question_id)
      .eq('status', 'active')
      .single();

    if (qErr || !question) {
      return res.status(400).json({ success: false, error: 'No active question for this door' });
    }

    const entryFee = door.entry_fee ?? settings?.entry_fee ?? 500;

    // Check balance
    if (player.balance < entryFee) {
      return res.status(400).json({ success: false, error: 'Insufficient balance to play' });
    }

    // Check daily play limit
    if (settings?.max_daily_plays) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      const { count } = await supabase
        .from('game_sessions')
        .select('id', { count: 'exact', head: true })
        .eq('player_id', player.id)
        .gte('played_at', startOfDay.toISOString());

      if (count >= settings.max_daily_plays) {
        return res.status(400).json({
          success: false,
          error: `Daily play limit of ${settings.max_daily_plays} reached`,
        });
      }
    }

    // Deduct entry fee
    const { error: balErr } = await supabase
      .from('players')
      .update({ balance: player.balance - entryFee })
      .eq('id', player.id);

    if (balErr) {
      return res.status(500).json({ success: false, error: 'Failed to deduct entry fee' });
    }

    // Record transaction
    await supabase.from('transactions').insert({
      player_id: player.id,
      type: 'entry_fee',
      amount: -entryFee,
      description: `Entry fee for door ${doorId}`,
    });

    // Create game session
    const sessionId = uuidv4();
    const { error: sessionErr } = await supabase.from('game_sessions').insert({
      id: sessionId,
      player_id: player.id,
      phone: player.phone,
      door_id: doorId,
      question_id: question.id,
      status: 'pending',
      correct_answer: question.correct_answer,
      prize: question.prize,
      entry_fee: entryFee,
    });

    if (sessionErr) {
      // Attempt to refund entry fee on failure
      await supabase
        .from('players')
        .update({ balance: player.balance })
        .eq('id', player.id);
      return res.status(500).json({ success: false, error: 'Failed to create game session' });
    }

    // Increment games_played
    await supabase
      .from('players')
      .update({ games_played: (player.games_played || 0) + 1 })
      .eq('id', player.id);

    return res.json({
      success: true,
      data: {
        sessionId,
        question: sanitizeQuestion(question),
        entryFee,
        newBalance: player.balance - entryFee,
      },
    });
  } catch (err) {
    console.error('Play error:', err);
    return res.status(500).json({ success: false, error: 'Failed to start game' });
  }
});

/**
 * POST /api/game/submit
 * Check answer and update wallet if correct.
 */
router.post('/submit', auth, async (req, res) => {
  try {
    const settings = await getSettings();

    if (settings?.game_kill_switch) {
      return res.status(503).json({ success: false, error: 'Game is currently unavailable' });
    }

    const { sessionId, answer } = req.body;
    const player = req.player;

    if (!sessionId || answer === undefined || answer === null) {
      return res.status(400).json({ success: false, error: 'sessionId and answer are required' });
    }

    // Fetch session
    const { data: session, error: sessErr } = await supabase
      .from('game_sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('player_id', player.id)
      .single();

    if (sessErr || !session) {
      return res.status(404).json({ success: false, error: 'Game session not found' });
    }

    if (session.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'This session has already been submitted' });
    }

    // Fetch full question for answer checking logic
    const { data: question, error: qErr } = await supabase
      .from('questions')
      .select('*')
      .eq('id', session.question_id)
      .single();

    if (qErr || !question) {
      return res.status(500).json({ success: false, error: 'Question not found' });
    }

    const correct = checkAnswer(question, String(answer));
    const prize = session.prize;

    // Update session
    await supabase
      .from('game_sessions')
      .update({
        status: correct ? 'won' : 'lost',
        player_answer: String(answer),
      })
      .eq('id', sessionId);

    if (correct) {
      // Credit prize to wallet
      const { data: freshPlayer } = await supabase
        .from('players')
        .select('balance, games_won, total_won')
        .eq('id', player.id)
        .single();

      await supabase
        .from('players')
        .update({
          balance: (freshPlayer.balance || 0) + prize,
          games_won: (freshPlayer.games_won || 0) + 1,
          total_won: (freshPlayer.total_won || 0) + prize,
        })
        .eq('id', player.id);

      await supabase.from('transactions').insert({
        player_id: player.id,
        type: 'prize',
        amount: prize,
        description: `Won door ${session.door_id}`,
      });

      return res.json({
        success: true,
        data: {
          correct: true,
          prize,
          correctAnswer: question.correct_answer,
          message: `Correct! You won ₦${prize}`,
        },
      });
    }

    return res.json({
      success: true,
      data: {
        correct: false,
        prize: 0,
        correctAnswer: question.correct_answer,
        message: 'Wrong answer. Better luck next time!',
      },
    });
  } catch (err) {
    console.error('Submit error:', err);
    return res.status(500).json({ success: false, error: 'Failed to submit answer' });
  }
});

/**
 * GET /api/game/recent-winners
 * Last 10 won sessions with masked phone numbers.
 */
router.get('/recent-winners', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('game_sessions')
      .select('id, phone, door_id, prize, played_at')
      .eq('status', 'won')
      .order('played_at', { ascending: false })
      .limit(10);

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch recent winners' });
    }

    const winners = data.map((w) => ({
      id: w.id,
      phone: maskPhone(w.phone),
      doorId: w.door_id,
      prize: w.prize,
      playedAt: w.played_at,
    }));

    return res.json({ success: true, data: winners });
  } catch (err) {
    console.error('Recent winners error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch recent winners' });
  }
});

module.exports = router;
