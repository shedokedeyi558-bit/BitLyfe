const express = require('express');
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
 * List all games (doors + challenges unified) with filtering and pagination
 */
router.get('/', adminAuth, async (req, res) => {
  try {
    const { type, status, page = 1, limit = 20, search } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let games = [];

    // Fetch doors if type is not 'challenge_game'
    if (!type || type === 'door_game') {
      const { data: doors } = await supabase.from('doors').select('*');

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

    // Fetch challenges if type is not 'door_game'
    if (!type || type === 'challenge_game') {
      const { data: challenges } = await supabase
        .from('challenges')
        .select('*')
        .order('created_at', { ascending: false });

      games = games.concat(challenges.map(formatChallengeGame));
    }

    // Filter by status
    if (status) {
      games = games.filter((g) => g.status === status);
    }

    // Filter by search (title or description)
    if (search) {
      const lowerSearch = search.toLowerCase();
      games = games.filter(
        (g) =>
          g.title?.toLowerCase().includes(lowerSearch) ||
          g.description?.toLowerCase().includes(lowerSearch)
      );
    }

    // Apply pagination
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
 * Create a new door or challenge game
 */
router.post('/create', adminAuth, async (req, res) => {
  try {
    const { game_type, ...gameData } = req.body;

    if (!game_type || !['door_game', 'challenge_game'].includes(game_type)) {
      return res
        .status(400)
        .json({ success: false, error: 'game_type must be "door_game" or "challenge_game"' });
    }

    if (game_type === 'door_game') {
      // Create door game
      const { door_id, entry_fee, prize, question_id } = gameData;

      if (door_id === undefined) {
        return res.status(400).json({ success: false, error: 'door_id is required' });
      }

      // Update door
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
    } else {
      // Create challenge game
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
          created_by: req.admin.id,
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
    }
  } catch (err) {
    console.error('Create game error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create game', details: err.message });
  }
});

// ─── GAME DETAIL ROUTES ────────────────────────────────────────────────────

/**
 * GET /api/admin/games/:id
 * Get game details (door or challenge)
 */
router.get('/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Try to find as challenge first
    const { data: challenge } = await supabase
      .from('challenges')
      .select('*')
      .eq('id', id)
      .single();

    if (challenge) {
      return res.json({
        success: true,
        data: { game: formatChallengeGame(challenge) },
      });
    }

    // Try to find as door
    const doorId = parseInt(id);
    if (!isNaN(doorId)) {
      const { data: door } = await supabase
        .from('doors')
        .select('*')
        .eq('id', doorId)
        .single();

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
        return res.json({
          success: true,
          data: { game: formatDoorGame(door, question) },
        });
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
 * Transition: draft → active
 */
router.post('/:id/activate', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Only challenges support draft → active
    const { data: challenge } = await supabase
      .from('challenges')
      .select('status')
      .eq('id', id)
      .single();

    if (challenge) {
      if (challenge.status !== 'draft') {
        return res.status(400).json({
          success: false,
          error: `Challenge is ${challenge.status}. Can only activate from draft.`,
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

    // Doors are always active
    return res.status(400).json({ success: false, error: 'Door games cannot be activated' });
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
 * Get all participants for a game
 */
router.get('/:id/participants', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    // Try challenge first
    const { data: challenge } = await supabase.from('challenges').select('id').eq('id', id).single();

    if (challenge) {
      const { data, error, count } = await supabase
        .from('challenge_participations')
        .select(
          `
          id, player_id, player_answer, is_correct, amount_won, participated_at,
          players (id, phone, name, email)
        `,
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
          `
          id, player_id, status, player_answer, prize, played_at,
          players (id, phone, name, email)
        `,
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
 * Reveal challenge answer and process winner payouts
 */
router.post('/:id/reveal-answer', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { correct_answer } = req.body;

    if (!correct_answer) {
      return res.status(400).json({ success: false, error: 'correct_answer is required' });
    }

    // Fetch challenge
    const { data: challenge } = await supabase
      .from('challenges')
      .select('*')
      .eq('id', id)
      .single();

    if (!challenge) {
      return res.status(404).json({ success: false, error: 'Challenge not found' });
    }

    // Fetch all participations
    const { data: participations } = await supabase
      .from('challenge_participations')
      .select('id, player_id, player_answer')
      .eq('challenge_id', id);

    // Determine winners (case-insensitive, trimmed comparison)
    const normalizedCorrectAnswer = String(correct_answer).trim().toLowerCase();
    let totalCorrect = 0;
    let totalIncorrect = 0;
    const updates = [];

    for (const p of participations) {
      const normalizedPlayerAnswer = String(p.player_answer).trim().toLowerCase();
      const isCorrect = normalizedPlayerAnswer === normalizedCorrectAnswer;

      if (isCorrect) totalCorrect++;
      else totalIncorrect++;

      updates.push({
        id: p.id,
        is_correct: isCorrect,
        player_id: p.player_id,
      });
    }

    // Calculate payout per winner
    const totalStake = challenge.current_participants * challenge.stake_amount;
    const prizePool = Math.floor(totalStake * 0.8);
    const amountPerWinner = totalCorrect > 0 ? Math.floor(prizePool / totalCorrect) : 0;

    // Update participations and credit winners
    let totalPaid = 0;

    for (const update of updates) {
      if (update.is_correct && amountPerWinner > 0) {
        // Credit winner
        const { data: player } = await supabase
          .from('players')
          .select('balance')
          .eq('id', update.player_id)
          .single();

        await supabase
          .from('players')
          .update({ balance: (player?.balance || 0) + amountPerWinner })
          .eq('id', update.player_id);

        // Record win transaction
        await supabase.from('transactions').insert({
          player_id: update.player_id,
          type: 'challenge_win',
          amount: amountPerWinner,
          description: `Won challenge: ${challenge.title}`,
        });

        totalPaid += amountPerWinner;
      }

      // Update participation record
      await supabase
        .from('challenge_participations')
        .update({
          is_correct: update.is_correct,
          amount_won: update.is_correct ? amountPerWinner : 0,
        })
        .eq('id', update.id);
    }

    // Mark challenge as closed
    await supabase
      .from('challenges')
      .update({
        status: 'closed',
        correct_answer,
        answer_reveal_at: new Date().toISOString(),
      })
      .eq('id', id);

    return res.json({
      success: true,
      data: {
        message: 'Answer revealed and winners paid',
        total_participants: challenge.current_participants,
        total_correct: totalCorrect,
        total_incorrect: totalIncorrect,
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
