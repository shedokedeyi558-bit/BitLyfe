const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

/**
 * Calculate prize pool: total_stake * 0.8 (20% app fee)
 */
function calculatePrizePool(maxParticipants, stakeAmount) {
  return Math.floor(maxParticipants * stakeAmount * 0.8);
}

// ─── PLAYER ENDPOINTS ──────────────────────────────────────────────────────

/**
 * GET /api/challenges
 * Get active/upcoming challenges for the player
 */
router.get('/', auth, async (req, res) => {
  try {
    const player = req.player;
    const now = new Date().toISOString();

    // Fetch active and locked challenges that haven't ended
    const { data: challenges, error } = await supabase
      .from('challenges')
      .select('id, title, description, category, question_type, stake_amount, max_participants, current_participants, countdown_duration, ends_at, status, starts_at')
      .in('status', ['active', 'locked'])
      .gte('ends_at', now)
      .order('ends_at', { ascending: true });

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch challenges' });
    }

    // Check which challenges the player has joined
    const challengeIds = challenges.map((c) => c.id);
    let joinedMap = {};

    if (challengeIds.length > 0) {
      const { data: participations } = await supabase
        .from('challenge_participations')
        .select('challenge_id')
        .eq('player_id', player.id)
        .in('challenge_id', challengeIds);

      joinedMap = participations.reduce((acc, p) => {
        acc[p.challenge_id] = true;
        return acc;
      }, {});
    }

    const result = challenges.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      category: c.category,
      question_type: c.question_type,
      stake_amount: c.stake_amount,
      max_participants: c.max_participants,
      current_participants: c.current_participants,
      countdown_duration: c.countdown_duration,
      ends_at: c.ends_at,
      status: c.status,
      is_user_joined: !!joinedMap[c.id],
    }));

    return res.json({ success: true, data: { challenges: result } });
  } catch (err) {
    console.error('Get challenges error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch challenges' });
  }
});

/**
 * GET /api/challenges/:id
 * Get challenge details for player
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const player = req.player;

    const { data: challenge, error: challengeErr } = await supabase
      .from('challenges')
      .select('*')
      .eq('id', id)
      .single();

    if (challengeErr || !challenge) {
      return res.status(404).json({ success: false, error: 'Challenge not found' });
    }

    // Check if player has joined — may not have
    const { data: myParticipation } = await supabase
      .from('challenge_participations')
      .select('id, player_answer, is_correct, amount_won')
      .eq('challenge_id', id)
      .eq('player_id', player.id)
      .maybeSingle();

    // Check if answer should be revealed (only after admin reveals)
    const shouldRevealAnswer = challenge.status === 'closed' && challenge.correct_answer;

    const now = new Date();
    const hasEnded = new Date(challenge.ends_at) <= now || challenge.status === 'locked' || challenge.status === 'ended' || challenge.status === 'closed';

    return res.json({
      success: true,
      data: {
        challenge: {
          id: challenge.id,
          title: challenge.title,
          description: challenge.description,
          category: challenge.category,
          question_type: challenge.question_type,
          stake_amount: challenge.stake_amount,
          max_participants: challenge.max_participants,
          current_participants: challenge.current_participants,
          countdown_duration: challenge.countdown_duration,
          ends_at: challenge.ends_at,
          status: challenge.status,
          correct_answer: shouldRevealAnswer ? challenge.correct_answer : null,
        },
        my_participation: myParticipation || null,
        other_participants_count: challenge.current_participants - (myParticipation ? 1 : 0),
        has_ended: hasEnded,
      },
    });
  } catch (err) {
    console.error('Get challenge error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch challenge' });
  }
});

/**
 * POST /api/challenges/:id/join
 * Join a challenge and submit answer
 */
router.post('/:id/join', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { answer } = req.body;
    const player = req.player;

    if (!answer) {
      return res.status(400).json({ success: false, error: 'Answer is required' });
    }

    // Fetch challenge
    const { data: challenge, error: challengeErr } = await supabase
      .from('challenges')
      .select('*')
      .eq('id', id)
      .single();

    if (challengeErr || !challenge) {
      return res.status(404).json({ success: false, error: 'Challenge not found' });
    }

    // Validation: Challenge must be active
    if (challenge.status !== 'active') {
      return res.status(400).json({ success: false, error: `Challenge is ${challenge.status}. Cannot join.` });
    }

    // Validation: Check countdown hasn't expired
    const now = new Date();
    if (new Date(challenge.ends_at) <= now) {
      // Auto-lock if countdown expired
      await supabase.from('challenges').update({ status: 'ended' }).eq('id', id);
      return res.status(400).json({ success: false, error: 'Challenge countdown has expired' });
    }

    // Validation: User not already joined — may not have joined yet
    const { data: existingParticipation } = await supabase
      .from('challenge_participations')
      .select('id')
      .eq('challenge_id', id)
      .eq('player_id', player.id)
      .maybeSingle();

    if (existingParticipation) {
      return res.status(400).json({ success: false, error: 'You have already joined this challenge' });
    }

    // Validation: Max participants not reached
    if (challenge.current_participants >= challenge.max_participants) {
      return res.status(400).json({ success: false, error: 'Challenge is full. Maximum participants reached.' });
    }

    // Validation: Player has sufficient balance
    const { data: freshPlayer } = await supabase
      .from('players')
      .select('balance')
      .eq('id', player.id)
      .single();

    if (!freshPlayer || freshPlayer.balance < challenge.stake_amount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance to join challenge' });
    }

    // Deduct stake amount
    await supabase
      .from('players')
      .update({ balance: freshPlayer.balance - challenge.stake_amount })
      .eq('id', player.id);

    // Record transaction (loss)
    await supabase.from('transactions').insert({
      player_id: player.id,
      type: 'challenge_entry',
      amount: -challenge.stake_amount,
      description: `Joined challenge: ${challenge.title}`,
    });

    // Create participation record
    const { data: participation, error: participationErr } = await supabase
      .from('challenge_participations')
      .insert({
        challenge_id: id,
        player_id: player.id,
        player_answer: String(answer),
      })
      .select()
      .single();

    if (participationErr) {
      // Refund on failure
      await supabase
        .from('players')
        .update({ balance: freshPlayer.balance })
        .eq('id', player.id);
      return res.status(500).json({ success: false, error: 'Failed to join challenge' });
    }

    // Increment current_participants
    const newParticipantCount = challenge.current_participants + 1;
    let newStatus = challenge.status;

    // Auto-lock if max participants reached
    if (newParticipantCount >= challenge.max_participants) {
      newStatus = 'locked';
    }

    await supabase
      .from('challenges')
      .update({
        current_participants: newParticipantCount,
        status: newStatus,
      })
      .eq('id', id);

    return res.status(201).json({
      success: true,
      data: {
        participation: {
          id: participation.id,
          answer: participation.player_answer,
          status: 'submitted',
        },
        newBalance: freshPlayer.balance - challenge.stake_amount,
        challenge_status: newStatus,
      },
    });
  } catch (err) {
    console.error('Join challenge error:', err);
    return res.status(500).json({ success: false, error: 'Failed to join challenge' });
  }
});

/**
 * GET /api/challenges/:id/history
 * Get player's past challenge participations
 */
router.get('/:id/history', auth, async (req, res) => {
  try {
    const player = req.player;
    const { page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const { data, error, count } = await supabase
      .from('challenge_participations')
      .select(
        `
        id, player_answer, is_correct, amount_won, participated_at,
        challenges (id, title, category, stake_amount, status, correct_answer)
      `,
        { count: 'exact' }
      )
      .eq('player_id', player.id)
      .order('participated_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch history' });
    }

    return res.json({ success: true, data: { participations: data, total: count, page: Number(page), limit: Number(limit) } });
  } catch (err) {
    console.error('Get history error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch history' });
  }
});

// ─── ADMIN ENDPOINTS ───────────────────────────────────────────────────────

router.use(adminAuth);

/**
 * POST /api/admin/challenges
 * Create a new challenge
 */
router.post('/', async (req, res) => {
  try {
    const {
      title,
      description,
      category,
      question_type,
      stake_amount,
      max_participants,
      countdown_duration,
      correct_answer,
    } = req.body;

    if (!title || !question_type || !stake_amount || !max_participants) {
      return res.status(400).json({
        success: false,
        error: 'title, question_type, stake_amount, and max_participants are required',
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
        question_type,
        stake_amount,
        prize_pool: prizePool,
        max_participants,
        countdown_duration: countdown_duration || 60,
        ends_at: endsAt,
        correct_answer: correct_answer || null,
        created_by: req.admin.id,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: 'Failed to create challenge' });

    return res.status(201).json({ success: true, data: { challenge } });
  } catch (err) {
    console.error('Create challenge error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create challenge' });
  }
});

/**
 * GET /api/admin/challenges
 */
router.get('/', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabase
      .from('challenges')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch challenges' });

    return res.json({ success: true, data: { challenges: data, total: count, page: Number(page), limit: Number(limit) } });
  } catch (err) {
    console.error('Get challenges error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch challenges' });
  }
});

/**
 * PUT /api/admin/challenges/:id
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Only allow updates to certain fields
    const allowedFields = [
      'title',
      'description',
      'category',
      'stake_amount',
      'max_participants',
      'countdown_duration',
    ];
    const cleanUpdates = Object.fromEntries(
      Object.entries(updates).filter(([k]) => allowedFields.includes(k))
    );

    cleanUpdates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('challenges')
      .update(cleanUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ success: false, error: 'Challenge not found or update failed' });

    return res.json({ success: true, data: { challenge: data } });
  } catch (err) {
    console.error('Update challenge error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update challenge' });
  }
});

/**
 * DELETE /api/admin/challenges/:id
 * Soft delete (only if not started)
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: challenge } = await supabase.from('challenges').select('status').eq('id', id).single();

    if (!challenge) return res.status(404).json({ success: false, error: 'Challenge not found' });

    if (challenge.status !== 'active') {
      return res.status(400).json({ success: false, error: 'Can only delete active challenges' });
    }

    await supabase.from('challenges').update({ status: 'closed' }).eq('id', id);

    return res.json({ success: true, data: { message: 'Challenge deleted' } });
  } catch (err) {
    console.error('Delete challenge error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete challenge' });
  }
});

/**
 * POST /api/admin/challenges/:id/reveal-answer
 * Reveal correct answer and validate all participations
 */
router.post('/:id/reveal-answer', async (req, res) => {
  try {
    const { id } = req.params;
    const { correct_answer } = req.body;

    if (!correct_answer) {
      return res.status(400).json({ success: false, error: 'correct_answer is required' });
    }

    // Fetch challenge
    const { data: challenge } = await supabase.from('challenges').select('*').eq('id', id).single();

    if (!challenge) return res.status(404).json({ success: false, error: 'Challenge not found' });

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
        const { data: player } = await supabase.from('players').select('balance').eq('id', update.player_id).single();

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
        amount_per_winner: amountPerWinner,
        total_paid: totalPaid,
      },
    });
  } catch (err) {
    console.error('Reveal answer error:', err);
    return res.status(500).json({ success: false, error: 'Failed to reveal answer' });
  }
});

/**
 * GET /api/admin/challenges/:id/participants
 */
router.get('/:id/participants', async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const { data, error, count } = await supabase
      .from('challenge_participations')
      .select(
        `
        id, player_id, player_answer, is_correct, amount_won, participated_at,
        players (phone, name)
      `,
        { count: 'exact' }
      )
      .eq('challenge_id', id)
      .order('participated_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch participants' });

    return res.json({ success: true, data: { participations: data, total: count, page: Number(page), limit: Number(limit) } });
  } catch (err) {
    console.error('Get participants error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch participants' });
  }
});

module.exports = router;
