const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');
const { checkAnswer, maskPhone, sanitizeQuestion } = require('../services/gameLogic');
const { createNotification } = require('./notifications');

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
      .select('id, status, prize, entry_fee, question_id')
      .eq('status', 'active')
      .order('id');

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch doors' });
    }

    // Fetch questions individually — embedded join silently returns null for UUID FK columns
    const activeDoors = [];
    for (const door of doors || []) {
      if (!door.question_id) continue;

      const { data: question } = await supabase
        .from('questions')
        .select('id, text, format, difficulty, prize, time_limit, options, status')
        .eq('id', door.question_id)
        .single();

      // Only include doors whose question exists and is active
      if (!question || question.status !== 'active') continue;

      activeDoors.push({
        id: door.id,
        status: door.status,
        prize: question.prize,
        entry_fee: door.entry_fee,
        question: {
          id: question.id,
          text: question.text,
          format: question.format,
          difficulty: question.difficulty,
          prize: question.prize,
          time_limit: question.time_limit,
          options: question.options,
        },
      });
    }

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

      // Notify player of win
      await createNotification(
        player.id,
        'win',
        'You won! 🎉',
        `Correct answer! ₦${prize.toLocaleString()} has been credited to your wallet.`
      ).catch(() => {});

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
 * Last 20 winners across all game types: doors, pills, predictions, blitz.
 * Phone numbers masked. Live data — no mock.
 */
router.get('/recent-winners', async (req, res) => {
  try {
    // Query all winning transaction types in parallel
    const [doorRes, pillRes, predRes, blitzRes] = await Promise.all([
      // Legacy door wins
      supabase
        .from('game_sessions')
        .select('id, phone, door_id, prize, played_at')
        .eq('status', 'won')
        .order('played_at', { ascending: false })
        .limit(20),
      // Pill wins
      supabase
        .from('transactions')
        .select('id, player_id, amount, created_at, players(phone)')
        .eq('type', 'pill_win')
        .order('created_at', { ascending: false })
        .limit(20),
      // Prediction wins
      supabase
        .from('transactions')
        .select('id, player_id, amount, created_at, players(phone)')
        .eq('type', 'prediction_win')
        .order('created_at', { ascending: false })
        .limit(20),
      // Blitz prizes
      supabase
        .from('transactions')
        .select('id, player_id, amount, created_at, players(phone)')
        .eq('type', 'blitz_prize')
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    const winners = [];

    for (const session of doorRes.data || []) {
      winners.push({
        id: session.id,
        phone: maskPhone(session.phone),
        game_type: 'door',
        prize: session.prize,
        played_at: session.played_at,
      });
    }

    for (const txn of pillRes.data || []) {
      winners.push({
        id: txn.id,
        phone: maskPhone(txn.players?.phone),
        game_type: 'pill',
        prize: txn.amount,
        played_at: txn.created_at,
      });
    }

    for (const txn of predRes.data || []) {
      winners.push({
        id: txn.id,
        phone: maskPhone(txn.players?.phone),
        game_type: 'prediction',
        prize: txn.amount,
        played_at: txn.created_at,
      });
    }

    for (const txn of blitzRes.data || []) {
      winners.push({
        id: txn.id,
        phone: maskPhone(txn.players?.phone),
        game_type: 'blitz',
        prize: txn.amount,
        played_at: txn.created_at,
      });
    }

    // Sort all by most recent, return top 20
    winners.sort((a, b) => new Date(b.played_at) - new Date(a.played_at));
    const top20 = winners.slice(0, 20);

    return res.json({ success: true, data: top20 });
  } catch (err) {
    console.error('Recent winners error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch recent winners' });
  }
});

module.exports = router;
