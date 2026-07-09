const express = require('express');
const { createNotification } = require('./notifications');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// ─── HELPER FUNCTIONS ─────────────────────────────────────────────────────

/**
 * Calculate prize pool for challenges: total_stake * 0.8 (20% app fee)
 */
function calculatePrizePool(maxParticipants, stakeAmount) {
  return Math.floor(maxParticipants * stakeAmount * 0.8);
}

/**
 * Format a pill for API response (never expose correct_answer to players)
 */
function formatPill(pill, { includeAnswer = true } = {}) {
  const base = {
    id: pill.id,
    game_type: 'pills',
    title: pill.question,
    question: pill.question,
    category: pill.category,
    status: pill.status,
    entry_fee: Number(pill.entry_fee),
    prize: Number(pill.prize),
    timer: pill.timer_seconds,
    format: pill.format,
    options: pill.options || null,
    created_at: pill.created_at,
    stats: {
      total_players: pill._play_count || 0,
      revenue: pill._revenue || 0,
    },
  };
  if (includeAnswer) base.correct_answer = pill.correct_answer;
  return base;
}

/**
 * Format a prediction for API response
 */
function formatPrediction(prediction) {
  const now = Date.now();
  const countdownEnd = new Date(prediction.countdown_end_time).getTime();
  return {
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
    answer_revealed_at: prediction.answer_revealed_at || null,
    correct_answer: prediction.correct_answer || null,
    event_date: prediction.event_date || null,
    created_at: prediction.created_at,
    stats: {
      total_players: prediction.current_participants,
      revenue: prediction.current_participants * Number(prediction.entry_fee),
    },
  };
}

/**
 * Format a door game for API response
 */
function formatDoorGame(door, question) {
  return {
    id: door.id,
    game_type: 'door_game',
    title: `Door ${door.id}`,
    description: `Answer the question to win ₦${door.prize}`,
    status: door.status,
    entry_fee: door.entry_fee,
    prize: door.prize,
    question_id: door.question_id,
    question: question
      ? {
          id: question.id,
          text: question.text,
          format: question.format,
          options: question.options,
        }
      : null,
    stats: {
      total_players: 0, // TODO: fetch from game_sessions
      revenue: 0, // TODO: calculate from game_sessions
    },
    created_at: new Date().toISOString(),
    created_by: 'system',
  };
}

/**
 * Format a challenge game for API response
 */
function formatChallengeGame(challenge) {
  return {
    id: challenge.id,
    game_type: 'challenge_game',
    title: challenge.title,
    description: challenge.description,
    category: challenge.category,
    status: challenge.status,
    stake_amount: challenge.stake_amount,
    prize_pool: challenge.prize_pool,
    max_participants: challenge.max_participants,
    current_participants: challenge.current_participants,
    countdown_duration: challenge.countdown_duration,
    starts_at: challenge.starts_at,
    ends_at: challenge.ends_at,
    answer_revealed_at: challenge.answer_reveal_at,
    created_at: challenge.created_at,
    created_by: challenge.created_by,
  };
}

// ─── UNIFIED GAMES LIST ────────────────────────────────────────────────────
/**
 * GET /api/admin/games
 * List all games (doors + challenges + pills + predictions) with filtering
 * Query: ?game_type=pills|predictions|door_game|challenge_game, ?status=active, ?page=1&limit=20
 */
router.get('/', adminAuth, async (req, res) => {
  try {
    const { game_type, type, status, page = 1, limit = 20, search } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const filterType = game_type || type; // accept both param names

    let games = [];

    // Fetch pills
    if (!filterType || filterType === 'pills') {
      const { data: pills } = await supabase
        .from('pills')
        .select('*')
        .order('created_at', { ascending: false });

      if (pills) games = games.concat(pills.map((p) => formatPill(p)));
    }

    // Fetch predictions
    if (!filterType || filterType === 'predictions') {
      const { data: predictions } = await supabase
        .from('predictions')
        .select('*')
        .order('created_at', { ascending: false });

      if (predictions) games = games.concat(predictions.map(formatPrediction));
    }

    // Fetch doors
    if (!filterType || filterType === 'door_game') {
      const { data: doors } = await supabase.from('doors').select('*');

      if (doors) {
        for (const door of doors) {
          let question = null;
          if (door.question_id) {
            const { data: q } = await supabase
              .from('questions')
              .select('id, text, format, options')
              .eq('id', door.question_id)
              .single();
            question = q;
          }
          games.push(formatDoorGame(door, question));
        }
      }
    }

    // Fetch challenges
    if (!filterType || filterType === 'challenge_game') {
      const { data: challenges } = await supabase
        .from('challenges')
        .select('*')
        .order('created_at', { ascending: false });

      if (challenges) games = games.concat(challenges.map(formatChallengeGame));
    }

    // Filter by status
    if (status) {
      games = games.filter((g) => g.status === status);
    }

    // Filter by search
    if (search) {
      const lowerSearch = search.toLowerCase();
      games = games.filter(
        (g) =>
          g.title?.toLowerCase().includes(lowerSearch) ||
          g.question?.toLowerCase().includes(lowerSearch)
      );
    }

    // Sort all by created_at descending
    games.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const total = games.length;
    games = games.slice(offset, offset + Number(limit));

    return res.json({
      success: true,
      data: {
        games,
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    console.error('Get games error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch games' });
  }
});

// ─── CREATE GAME (MUST BE BEFORE /:id ROUTES) ─────────────────────────────
/**
 * POST /api/admin/games/create
 * Create a new game: pills | predictions | door_game | challenge_game
 */
router.post('/create', adminAuth, async (req, res) => {
  try {
    const { game_type, ...gameData } = req.body;

    if (!game_type || !['door_game', 'challenge_game', 'pills', 'predictions'].includes(game_type)) {
      return res.status(400).json({
        success: false,
        error: 'game_type must be "pills", "predictions", "door_game", or "challenge_game"',
      });
    }

    // ── PILLS ──────────────────────────────────────────────────────────────
    if (game_type === 'pills') {
      const { title, question, category, entry_fee, prize, timer, format, options, correct_answer } = gameData;

      const questionText = question || title;
      if (!questionText || !format || !correct_answer || entry_fee === undefined || prize === undefined) {
        return res.status(400).json({
          success: false,
          error: 'question, format, correct_answer, entry_fee, and prize are required for pills',
        });
      }

      if (!['multiple_choice', 'type_answer'].includes(format)) {
        return res.status(400).json({ success: false, error: 'format must be "multiple_choice" or "type_answer"' });
      }

      const { data: pill, error } = await supabase
        .from('pills')
        .insert({
          admin_id: req.admin?.id || null,
          question: questionText,
          category: category || 'General',
          entry_fee: Number(entry_fee),
          prize: Number(prize),
          format,
          options: options || null,
          correct_answer,
          timer_seconds: timer || 30,
          status: 'available',
        })
        .select()
        .single();

      if (error) {
        console.error('Pill creation error:', error);
        return res.status(500).json({ success: false, error: 'Failed to create pill', details: error.message });
      }

      return res.status(201).json({
        success: true,
        data: { game: formatPill(pill) },
      });
    }

    // ── PREDICTIONS ────────────────────────────────────────────────────────
    if (game_type === 'predictions') {
      const { title, question, category, entry_fee, prize_per_winner, max_slots, countdown_end, event_date } = gameData;

      const questionText = question || title;
      if (!questionText || entry_fee === undefined || prize_per_winner === undefined || !countdown_end) {
        return res.status(400).json({
          success: false,
          error: 'question, entry_fee, prize_per_winner, and countdown_end are required for predictions',
        });
      }

      const countdownEnd = new Date(countdown_end);
      if (isNaN(countdownEnd.getTime())) {
        return res.status(400).json({ success: false, error: 'countdown_end must be a valid ISO date string' });
      }

      const countdownSeconds = Math.max(0, Math.floor((countdownEnd.getTime() - Date.now()) / 1000));

      const { data: prediction, error } = await supabase
        .from('predictions')
        .insert({
          admin_id: req.admin?.id || null,
          question: questionText,
          category: category || 'General',
          entry_fee: Number(entry_fee),
          prize_per_winner: Number(prize_per_winner),
          max_participants: max_slots || 100,
          current_participants: 0,
          countdown_seconds: countdownSeconds,
          countdown_end_time: countdownEnd.toISOString(),
          event_date: event_date ? new Date(event_date).toISOString() : null,
          status: 'active',
        })
        .select()
        .single();

      if (error) {
        console.error('Prediction creation error:', error);
        return res.status(500).json({ success: false, error: 'Failed to create prediction', details: error.message });
      }

      return res.status(201).json({
        success: true,
        data: { game: formatPrediction(prediction) },
      });
    }

    // ── DOOR GAME ──────────────────────────────────────────────────────────
    if (game_type === 'door_game') {
      const { door_id, entry_fee, prize, question_id } = gameData;

      if (door_id === undefined) {
        return res.status(400).json({ success: false, error: 'door_id is required' });
      }

      const { data: door, error } = await supabase
        .from('doors')
        .update({
          entry_fee: entry_fee || 500,
          prize: prize || 1000,
          question_id: question_id || null,
          status: 'active',
        })
        .eq('id', door_id)
        .select()
        .single();

      if (error) {
        return res.status(400).json({ success: false, error: 'Door not found or update failed' });
      }

      let question = null;
      if (door.question_id) {
        const { data: q } = await supabase
          .from('questions')
          .select('id, text, format, options')
          .eq('id', door.question_id)
          .single();
        question = q;
      }

      return res.status(201).json({
        success: true,
        data: { game: formatDoorGame(door, question) },
      });
    }

    // ── CHALLENGE GAME ─────────────────────────────────────────────────────
    const { title, description, category, question_type, stake_amount, max_participants, countdown_duration, correct_answer } = gameData;

    if (!title || !stake_amount || !max_participants) {
      return res.status(400).json({
        success: false,
        error: 'title, stake_amount, and max_participants are required',
      });
    }

    const endsAt = new Date(Date.now() + (countdown_duration || 60) * 60 * 1000).toISOString();
    const prizePool = calculatePrizePool(max_participants, stake_amount);

    const { data: challenge, error } = await supabase
      .from('challenges')
      .insert({
        title,
        description,
        category,
        question_type: question_type || 'trivia',
        stake_amount,
        prize_pool: prizePool,
        max_participants,
        countdown_duration: countdown_duration || 60,
        ends_at: endsAt,
        correct_answer: correct_answer || null,
        created_by: req.admin?.id || null,
        status: 'draft',
      })
      .select()
      .single();

    if (error) {
      console.error('Challenge creation error:', error);
      return res.status(500).json({ success: false, error: 'Failed to create challenge', details: error.message });
    }

    return res.status(201).json({
      success: true,
      data: { game: formatChallengeGame(challenge) },
    });
  } catch (err) {
    console.error('Create game error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create game', details: err.message });
  }
});

// ─── GAME DETAIL ROUTES ────────────────────────────────────────────────────

/**
 * GET /api/admin/games/:id
 * Get game details — supports pills, predictions, challenges, doors
 */
router.get('/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Try pill first (UUID)
    const { data: pill } = await supabase.from('pills').select('*').eq('id', id).single();
    if (pill) {
      return res.json({ success: true, data: { game: formatPill(pill) } });
    }

    // Try prediction (UUID)
    const { data: prediction } = await supabase.from('predictions').select('*').eq('id', id).single();
    if (prediction) {
      return res.json({ success: true, data: { game: formatPrediction(prediction) } });
    }

    // Try challenge (UUID)
    const { data: challenge } = await supabase.from('challenges').select('*').eq('id', id).single();
    if (challenge) {
      return res.json({ success: true, data: { game: formatChallengeGame(challenge) } });
    }

    // Try door (integer ID)
    const doorId = parseInt(id);
    if (!isNaN(doorId)) {
      const { data: door } = await supabase.from('doors').select('*').eq('id', doorId).single();
      if (door) {
        let question = null;
        if (door.question_id) {
          const { data: q } = await supabase
            .from('questions')
            .select('id, text, format, options')
            .eq('id', door.question_id)
            .single();
          question = q;
        }
        return res.json({ success: true, data: { game: formatDoorGame(door, question) } });
      }
    }

    return res.status(404).json({ success: false, error: 'Game not found' });
  } catch (err) {
    console.error('Get game error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch game' });
  }
});

/**
 * PUT /api/admin/games/:id
 * Update game (only if draft status)
 */
router.put('/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Check if it's a challenge
    const { data: challenge } = await supabase
      .from('challenges')
      .select('status')
      .eq('id', id)
      .single();

    if (challenge) {
      if (challenge.status !== 'draft') {
        return res.status(400).json({
          success: false,
          error: 'Can only update challenges in draft status',
        });
      }

      const allowedFields = ['title', 'description', 'category', 'stake_amount', 'max_participants', 'countdown_duration'];
      const cleanUpdates = Object.fromEntries(
        Object.entries(updates).filter(([k]) => allowedFields.includes(k))
      );
      cleanUpdates.updated_at = new Date().toISOString();

      const { data: updated, error } = await supabase
        .from('challenges')
        .update(cleanUpdates)
        .eq('id', id)
        .select()
        .single();

      if (error || !updated) {
        return res.status(404).json({ success: false, error: 'Challenge not found' });
      }

      return res.json({
        success: true,
        data: { game: formatChallengeGame(updated) },
      });
    }

    // Try as door
    const doorId = parseInt(id);
    if (!isNaN(doorId)) {
      const allowedFields = ['entry_fee', 'prize', 'question_id'];
      const cleanUpdates = Object.fromEntries(
        Object.entries(updates).filter(([k]) => allowedFields.includes(k))
      );

      const { data: updated, error } = await supabase
        .from('doors')
        .update(cleanUpdates)
        .eq('id', doorId)
        .select()
        .single();

      if (error || !updated) {
        return res.status(404).json({ success: false, error: 'Door not found' });
      }

      let question = null;
      if (updated.question_id) {
        const { data: q } = await supabase
          .from('questions')
          .select('id, text, format, options')
          .eq('id', updated.question_id)
          .single();
        question = q;
      }

      return res.json({
        success: true,
        data: { game: formatDoorGame(updated, question) },
      });
    }

    return res.status(404).json({ success: false, error: 'Game not found' });
  } catch (err) {
    console.error('Update game error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update game' });
  }
});

/**
 * DELETE /api/admin/games/:id
 * Delete game (only if draft status)
 */
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if it's a challenge
    const { data: challenge } = await supabase
      .from('challenges')
      .select('status')
      .eq('id', id)
      .single();

    if (challenge) {
      if (challenge.status !== 'draft') {
        return res.status(400).json({
          success: false,
          error: 'Can only delete challenges in draft status',
        });
      }

      await supabase.from('challenges').delete().eq('id', id);

      return res.json({ success: true, data: { message: 'Challenge deleted' } });
    }

    // Try as door (cannot delete doors, but can disable)
    const doorId = parseInt(id);
    if (!isNaN(doorId)) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete doors. Use PUT to update status to inactive.',
      });
    }

    return res.status(404).json({ success: false, error: 'Game not found' });
  } catch (err) {
    console.error('Delete game error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete game' });
  }
});

// ─── STATUS TRANSITION ENDPOINTS ───────────────────────────────────────────

/**
 * POST /api/admin/games/:id/activate
 * Transition: draft/available → active
 */
router.post('/:id/activate', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Pill
    const { data: pill } = await supabase.from('pills').select('status').eq('id', id).single();
    if (pill) {
      await supabase.from('pills').update({ status: 'available' }).eq('id', id);
      return res.json({ success: true, data: { message: 'Pill activated', status: 'available' } });
    }

    // Prediction
    const { data: prediction } = await supabase.from('predictions').select('status').eq('id', id).single();
    if (prediction) {
      await supabase.from('predictions').update({ status: 'active' }).eq('id', id);
      return res.json({ success: true, data: { message: 'Prediction activated', status: 'active' } });
    }

    // Challenge
    const { data: challenge } = await supabase.from('challenges').select('status').eq('id', id).single();
    if (challenge) {
      if (challenge.status !== 'draft') {
        return res.status(400).json({ success: false, error: `Challenge is ${challenge.status}. Can only activate from draft.` });
      }
      const { data: updated } = await supabase.from('challenges').update({ status: 'active' }).eq('id', id).select().single();
      return res.json({ success: true, data: { game: formatChallengeGame(updated) } });
    }

    return res.status(404).json({ success: false, error: 'Game not found' });
  } catch (err) {
    console.error('Activate game error:', err);
    return res.status(500).json({ success: false, error: 'Failed to activate game' });
  }
});

/**
 * POST /api/admin/games/:id/pause
 * Transition: active → paused
 */
router.post('/:id/pause', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: challenge } = await supabase
      .from('challenges')
      .select('*')
      .eq('id', id)
      .single();

    if (challenge) {
      if (challenge.status !== 'active') {
        return res.status(400).json({
          success: false,
          error: `Challenge is ${challenge.status}. Can only pause active challenges.`,
        });
      }

      const { data: updated } = await supabase
        .from('challenges')
        .update({ status: 'paused' })
        .eq('id', id)
        .select()
        .single();

      return res.json({
        success: true,
        data: { game: formatChallengeGame(updated) },
      });
    }

    return res.status(400).json({ success: false, error: 'Game not found' });
  } catch (err) {
    console.error('Pause game error:', err);
    return res.status(500).json({ success: false, error: 'Failed to pause game' });
  }
});

/**
 * POST /api/admin/games/:id/resume
 * Transition: paused → active
 */
router.post('/:id/resume', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: challenge } = await supabase
      .from('challenges')
      .select('*')
      .eq('id', id)
      .single();

    if (challenge) {
      if (challenge.status !== 'paused') {
        return res.status(400).json({
          success: false,
          error: `Challenge is ${challenge.status}. Can only resume paused challenges.`,
        });
      }

      const { data: updated } = await supabase
        .from('challenges')
        .update({ status: 'active' })
        .eq('id', id)
        .select()
        .single();

      return res.json({
        success: true,
        data: { game: formatChallengeGame(updated) },
      });
    }

    return res.status(400).json({ success: false, error: 'Game not found' });
  } catch (err) {
    console.error('Resume game error:', err);
    return res.status(500).json({ success: false, error: 'Failed to resume game' });
  }
});

/**
 * POST /api/admin/games/:id/end
 * Transition: active/paused/locked → ended
 */
router.post('/:id/end', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: challenge } = await supabase
      .from('challenges')
      .select('*')
      .eq('id', id)
      .single();

    if (challenge) {
      const { data: updated } = await supabase
        .from('challenges')
        .update({ status: 'ended' })
        .eq('id', id)
        .select()
        .single();

      return res.json({
        success: true,
        data: { game: formatChallengeGame(updated) },
      });
    }

    return res.status(400).json({ success: false, error: 'Game not found' });
  } catch (err) {
    console.error('End game error:', err);
    return res.status(500).json({ success: false, error: 'Failed to end game' });
  }
});

// ─── PARTICIPANTS AND STATS ────────────────────────────────────────────────

/**
 * GET /api/admin/games/:id/participants
 * Get all participants for a game (challenges, doors, predictions)
 */
router.get('/:id/participants', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    // Try prediction first
    const { data: prediction } = await supabase.from('predictions').select('id').eq('id', id).single();

    if (prediction) {
      const { data, error, count } = await supabase
        .from('prediction_participations')
        .select(
          `id, player_id, answer, is_correct, amount_won, submitted_at, created_at,
           players (id, phone, name, email)`,
          { count: 'exact' }
        )
        .eq('prediction_id', id)
        .order('created_at', { ascending: false })
        .range(offset, offset + Number(limit) - 1);

      if (error) {
        return res.status(500).json({ success: false, error: 'Failed to fetch participants' });
      }

      const participations = (data || []).map((p) => ({
        id: p.id,
        player_id: p.player_id,
        player_phone: p.players?.phone || null,
        player_name: p.players?.name || null,
        answer: p.answer,
        is_correct: p.is_correct,
        amount_won: parseFloat(p.amount_won) || 0,
        participated_at: p.created_at,
        submitted_at: p.submitted_at,
      }));

      return res.json({
        success: true,
        data: {
          participations,
          total: count,
          page: Number(page),
          limit: Number(limit),
        },
      });
    }

    // Try challenge
    const { data: challenge } = await supabase.from('challenges').select('id').eq('id', id).single();

    if (challenge) {
      const { data, error, count } = await supabase
        .from('challenge_participations')
        .select(
          `id, player_id, player_answer, is_correct, amount_won, participated_at,
           players (id, phone, name, email)`,
          { count: 'exact' }
        )
        .eq('challenge_id', id)
        .order('participated_at', { ascending: false })
        .range(offset, offset + Number(limit) - 1);

      if (error) {
        return res.status(500).json({ success: false, error: 'Failed to fetch participants' });
      }

      return res.json({
        success: true,
        data: {
          participants: data,
          total: count,
          page: Number(page),
          limit: Number(limit),
        },
      });
    }

    // Try door
    const doorId = parseInt(id);
    if (!isNaN(doorId)) {
      const { data, error, count } = await supabase
        .from('game_sessions')
        .select(
          `id, player_id, status, player_answer, prize, played_at,
           players (id, phone, name, email)`,
          { count: 'exact' }
        )
        .eq('door_id', doorId)
        .order('played_at', { ascending: false })
        .range(offset, offset + Number(limit) - 1);

      if (error) {
        return res.status(500).json({ success: false, error: 'Failed to fetch participants' });
      }

      return res.json({
        success: true,
        data: {
          participants: data,
          total: count,
          page: Number(page),
          limit: Number(limit),
        },
      });
    }

    return res.status(404).json({ success: false, error: 'Game not found' });
  } catch (err) {
    console.error('Get participants error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch participants' });
  }
});

/**
 * GET /api/admin/games/:id/stats
 * Get game statistics
 */
router.get('/:id/stats', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Try challenge first
    const { data: challenge } = await supabase.from('challenges').select('*').eq('id', id).single();

    if (challenge) {
      const { data: participations } = await supabase
        .from('challenge_participations')
        .select('is_correct, amount_won')
        .eq('challenge_id', id);

      const totalParticipants = challenge.current_participants;
      const totalCorrect = participations.filter((p) => p.is_correct).length;
      const totalWon = participations.reduce((sum, p) => sum + (p.amount_won || 0), 0);

      return res.json({
        success: true,
        data: {
          game_id: id,
          game_type: 'challenge_game',
          total_participants: totalParticipants,
          total_correct: totalCorrect,
          total_incorrect: totalParticipants - totalCorrect,
          total_stake_collected: totalParticipants * challenge.stake_amount,
          total_prize_paid: totalWon,
          app_fee: totalParticipants * challenge.stake_amount - totalWon,
        },
      });
    }

    // Try door
    const doorId = parseInt(id);
    if (!isNaN(doorId)) {
      const { data: sessions } = await supabase
        .from('game_sessions')
        .select('status, entry_fee, prize')
        .eq('door_id', doorId);

      const totalPlayers = sessions.length;
      const totalWon = sessions.filter((s) => s.status === 'won').length;
      const totalLost = sessions.filter((s) => s.status === 'lost').length;
      const totalRevenue = sessions.reduce((sum, s) => sum + (s.entry_fee || 0), 0);
      const totalPrizesPaid = sessions.reduce((sum, s) => sum + (s.status === 'won' ? s.prize : 0), 0);

      return res.json({
        success: true,
        data: {
          game_id: doorId,
          game_type: 'door_game',
          total_players: totalPlayers,
          total_won: totalWon,
          total_lost: totalLost,
          total_revenue: totalRevenue,
          total_prizes_paid: totalPrizesPaid,
          app_profit: totalRevenue - totalPrizesPaid,
        },
      });
    }

    return res.status(404).json({ success: false, error: 'Game not found' });
  } catch (err) {
    console.error('Get stats error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// ─── CHALLENGE-SPECIFIC ENDPOINTS ──────────────────────────────────────────

/**
 * POST /api/admin/games/:id/reveal-answer
 * Reveal correct answer for pills, predictions, or challenges
 */
router.post('/:id/reveal-answer', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { correct_answer } = req.body;

    if (!correct_answer) {
      return res.status(400).json({ success: false, error: 'correct_answer is required' });
    }

    // ── PILL reveal ────────────────────────────────────────────────────────
    const { data: pill } = await supabase.from('pills').select('*').eq('id', id).single();
    if (pill) {
      // Pill answers are instant — correct_answer is already stored at creation.
      // Just mark correct_answer visible (it's already stored; this is a no-op for pills)
      return res.json({
        success: true,
        data: {
          message: 'Pill answer is already stored at creation time. Players see results immediately.',
          game_type: 'pills',
          correct_answer: pill.correct_answer,
        },
      });
    }

    // ── PREDICTION reveal ──────────────────────────────────────────────────
    const { data: prediction } = await supabase.from('predictions').select('*').eq('id', id).single();
    if (prediction) {
      const { data: participations } = await supabase
        .from('prediction_participations')
        .select('*')
        .eq('prediction_id', id);

      const prizePerWinner = Number(prediction.prize_per_winner);
      let winnersCount = 0;

      for (const part of participations || []) {
        // Idempotency check: skip if already processed (is_correct is not null)
        if (part.is_correct !== null) {
          continue;
        }

        const isCorrect = String(part.answer).toLowerCase().trim() === String(correct_answer).toLowerCase().trim();

        await supabase
          .from('prediction_participations')
          .update({ is_correct: isCorrect, amount_won: isCorrect ? prizePerWinner : 0 })
          .eq('id', part.id);

        if (isCorrect) {
          winnersCount++;
          const { data: player } = await supabase.from('players').select('balance').eq('id', part.player_id).single();
          await supabase.from('players').update({ balance: (player?.balance || 0) + prizePerWinner }).eq('id', part.player_id);
          await supabase.from('transactions').insert({
            player_id: part.player_id,
            type: 'prediction_win',
            amount: prizePerWinner,
            description: `Won prediction: ${prediction.question.substring(0, 50)}`,
          });
          // Notify winner
          await createNotification(
            part.player_id,
            'win',
            'Prediction correct! 🎉',
            `₦${prizePerWinner.toLocaleString()} has been added to your wallet`
          );
        } else {
          // Notify loser with result
          await createNotification(
            part.player_id,
            'prediction_result',
            'Result revealed',
            `Correct answer was: ${correct_answer}`
          );
        }
      }

      await supabase.from('predictions').update({
        correct_answer,
        status: 'completed',
        updated_at: new Date().toISOString(),
      }).eq('id', id);

      return res.json({
        success: true,
        data: {
          message: 'Answer revealed and winners credited',
          game_type: 'predictions',
          correct_answer,
          total_participants: participations?.length || 0,
          total_correct: winnersCount,
          total_paid: winnersCount * prizePerWinner,
        },
      });
    }

    // ── CHALLENGE reveal ───────────────────────────────────────────────────
    const { data: challenge } = await supabase.from('challenges').select('*').eq('id', id).single();
    if (!challenge) {
      return res.status(404).json({ success: false, error: 'Game not found' });
    }

    const { data: participations } = await supabase
      .from('challenge_participations')
      .select('id, player_id, player_answer')
      .eq('challenge_id', id);

    const normalizedCorrectAnswer = String(correct_answer).trim().toLowerCase();
    let totalCorrect = 0;
    const updates = [];

    for (const p of participations) {
      const isCorrect = String(p.player_answer).trim().toLowerCase() === normalizedCorrectAnswer;
      if (isCorrect) totalCorrect++;
      updates.push({ id: p.id, is_correct: isCorrect, player_id: p.player_id });
    }

    const totalStake = challenge.current_participants * challenge.stake_amount;
    const prizePool = Math.floor(totalStake * 0.8);
    const amountPerWinner = totalCorrect > 0 ? Math.floor(prizePool / totalCorrect) : 0;
    let totalPaid = 0;

    for (const update of updates) {
      if (update.is_correct && amountPerWinner > 0) {
        const { data: player } = await supabase.from('players').select('balance').eq('id', update.player_id).single();
        await supabase.from('players').update({ balance: (player?.balance || 0) + amountPerWinner }).eq('id', update.player_id);
        await supabase.from('transactions').insert({
          player_id: update.player_id,
          type: 'challenge_win',
          amount: amountPerWinner,
          description: `Won challenge: ${challenge.title}`,
        });
        totalPaid += amountPerWinner;
      }
      await supabase.from('challenge_participations')
        .update({ is_correct: update.is_correct, amount_won: update.is_correct ? amountPerWinner : 0 })
        .eq('id', update.id);
    }

    await supabase.from('challenges').update({
      status: 'closed',
      correct_answer,
      answer_reveal_at: new Date().toISOString(),
    }).eq('id', id);

    return res.json({
      success: true,
      data: {
        message: 'Answer revealed and winners paid',
        game_type: 'challenge_game',
        total_participants: challenge.current_participants,
        total_correct: totalCorrect,
        prize_per_winner: amountPerWinner,
        total_paid: totalPaid,
      },
    });
  } catch (err) {
    console.error('Reveal answer error:', err);
    return res.status(500).json({ success: false, error: 'Failed to reveal answer' });
  }
});

module.exports = router;
