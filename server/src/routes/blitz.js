const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');

const router = express.Router();

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Calculate prize distribution based on total_registered
 */
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

/**
 * Score answers server-side against stored correct answers
 */
function scoreAnswers(questions, submittedAnswers) {
  const questionMap = {};
  for (const q of questions) questionMap[q.id] = q;

  let score = 0;
  const scored = submittedAnswers.map((sub) => {
    const question = questionMap[sub.question_id];
    if (!question) return { ...sub, is_correct: false };

    const playerAnswer = String(sub.answer).trim().toLowerCase();
    const correctAnswer = String(question.correct_answer).trim().toLowerCase();
    const is_correct = playerAnswer === correctAnswer;
    if (is_correct) score++;
    return { question_id: sub.question_id, answer: sub.answer, is_correct, time_taken_ms: sub.time_taken_ms || 0 };
  });

  return { scored, score };
}

// ─── PLAYER ENDPOINTS ─────────────────────────────────────────────────────────

/**
 * GET /api/blitz
 * List active and registration-open tournaments
 */
router.get('/', auth, async (req, res) => {
  try {
    const { data: tournaments, error } = await supabase
      .from('blitz_tournaments')
      .select('id, title, description, entry_fee, question_count, time_limit_seconds, registration_start, tournament_start, tournament_end, status, total_registered, prize_pool')
      .in('status', ['registration', 'active'])
      .order('tournament_start', { ascending: true });

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch tournaments' });

    return res.json({ success: true, data: { tournaments: tournaments || [] } });
  } catch (err) {
    console.error('Get blitz error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch tournaments' });
  }
});

/**
 * GET /api/blitz/:id
 * Tournament detail + player's registration status
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const playerId = req.player.id;

    const { data: tournament, error } = await supabase
      .from('blitz_tournaments')
      .select('id, title, description, entry_fee, question_count, time_limit_seconds, registration_start, tournament_start, tournament_end, status, total_registered, prize_pool, platform_cut_percent')
      .eq('id', id)
      .single();

    if (error || !tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });

    // Check player registration
    const { data: registration } = await supabase
      .from('blitz_registrations')
      .select('id, registered_at, entry_fee_paid')
      .eq('tournament_id', id)
      .eq('player_id', playerId)
      .single();

    // Check player attempt
    const { data: attempt } = await supabase
      .from('blitz_attempts')
      .select('id, score, status, completed_at')
      .eq('tournament_id', id)
      .eq('player_id', playerId)
      .single();

    return res.json({
      success: true,
      data: {
        tournament,
        player: {
          registered: !!registration,
          registration: registration || null,
          attempted: !!attempt,
          attempt: attempt ? { score: attempt.score, status: attempt.status, completed_at: attempt.completed_at } : null,
        },
      },
    });
  } catch (err) {
    console.error('Get blitz detail error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch tournament' });
  }
});

/**
/**
 * POST /api/blitz/:id/register
 * Register player for tournament. Deducts entry fee or validates free ticket from blitz_tickets.
 * Body: { ticket_code? }
 */
router.post('/:id/register', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { ticket_code } = req.body;
    const player = req.player;

    const { data: tournament, error: tErr } = await supabase
      .from('blitz_tournaments')
      .select('*')
      .eq('id', id)
      .single();

    if (tErr || !tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });

    if (!['registration', 'active'].includes(tournament.status)) {
      return res.status(400).json({ success: false, error: 'Tournament registration is not open' });
    }

    // Check already registered
    const { data: existing } = await supabase
      .from('blitz_registrations')
      .select('id')
      .eq('tournament_id', id)
      .eq('player_id', player.id)
      .single();

    if (existing) return res.status(409).json({ success: false, error: 'Already registered for this tournament' });

    let entryFeePaid = tournament.entry_fee;
    let usedTicketId = null;

    if (ticket_code) {
      // Validate free ticket from blitz_tickets table
      const { data: ticket } = await supabase
        .from('blitz_tickets')
        .select('id, expires_at, status, player_id')
        .eq('ticket_code', ticket_code)
        .single();

      if (!ticket) {
        return res.status(404).json({ success: false, code: 'TICKET_NOT_FOUND', error: 'Ticket not found' });
      }

      // Check ticket ownership
      if (ticket.player_id !== player.id) {
        return res.status(403).json({ success: false, code: 'TICKET_NOT_OWNER', error: 'This ticket does not belong to you' });
      }

      // Check expiration and update if needed (lazy-check)
      const now = new Date();
      if (new Date(ticket.expires_at) < now && ticket.status === 'unused') {
        await supabase.from('blitz_tickets').update({ status: 'expired' }).eq('id', ticket.id);
        return res.status(410).json({ success: false, code: 'TICKET_EXPIRED', error: 'Ticket has expired' });
      }

      // Check if already used
      if (ticket.status === 'used') {
        return res.status(409).json({ success: false, code: 'TICKET_ALREADY_USED', error: 'Ticket has already been used' });
      }

      // Check if expired
      if (ticket.status === 'expired') {
        return res.status(410).json({ success: false, code: 'TICKET_EXPIRED', error: 'Ticket has expired' });
      }

      entryFeePaid = 0;
      usedTicketId = ticket.id;
    } else {
      // Deduct entry fee from balance
      if (player.balance < tournament.entry_fee) {
        return res.status(402).json({ success: false, error: 'Insufficient balance' });
      }

      await supabase
        .from('players')
        .update({ balance: player.balance - tournament.entry_fee })
        .eq('id', player.id);

      await supabase.from('transactions').insert({
        player_id: player.id,
        type: 'blitz_entry',
        amount: -tournament.entry_fee,
        description: `Blitz tournament entry: ${tournament.title}`,
      });
    }

    // Create registration
    await supabase.from('blitz_registrations').insert({
      tournament_id: id,
      player_id: player.id,
      entry_fee_paid: entryFeePaid,
      ticket: ticket_code || null,
    });

    // Mark ticket as used if one was provided
    if (usedTicketId) {
      await supabase
        .from('blitz_tickets')
        .update({ status: 'used', used_on_tournament_id: id })
        .eq('id', usedTicketId);
    }

    // Update total_registered and prize_pool
    const newTotal = (tournament.total_registered || 0) + 1;
    const newPrizePool = newTotal * tournament.entry_fee;

    await supabase
      .from('blitz_tournaments')
      .update({ total_registered: newTotal, prize_pool: newPrizePool })
      .eq('id', id);

    return res.status(201).json({
      success: true,
      data: {
        message: 'Successfully registered',
        tournament: { id, title: tournament.title, tournament_start: tournament.tournament_start },
        entryFeePaid,
        newBalance: ticket_code ? player.balance : player.balance - tournament.entry_fee,
      },
    });
  } catch (err) {
    console.error('Register blitz error:', err);
    return res.status(500).json({ success: false, error: 'Failed to register' });
  }
});

/**
 * POST /api/blitz/:id/attempt/start
 * Start player's attempt. Returns all questions WITHOUT correct_answer.
 */
router.post('/:id/attempt/start', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const player = req.player;
    const now = new Date();

    const { data: tournament, error: tErr } = await supabase
      .from('blitz_tournaments')
      .select('*')
      .eq('id', id)
      .single();

    if (tErr || !tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });

    // Must be active
    if (tournament.status !== 'active') {
      return res.status(403).json({ success: false, error: 'Tournament is not active yet' });
    }

    // Must be within tournament window
    if (now < new Date(tournament.tournament_start) || now > new Date(tournament.tournament_end)) {
      return res.status(403).json({ success: false, error: 'Tournament playing window is not open' });
    }

    // Must be registered
    const { data: registration } = await supabase
      .from('blitz_registrations')
      .select('id')
      .eq('tournament_id', id)
      .eq('player_id', player.id)
      .single();

    if (!registration) return res.status(403).json({ success: false, error: 'You are not registered for this tournament' });

    // One attempt per player
    const { data: existingAttempt } = await supabase
      .from('blitz_attempts')
      .select('id, status')
      .eq('tournament_id', id)
      .eq('player_id', player.id)
      .single();

    if (existingAttempt) {
      if (existingAttempt.status === 'completed') {
        return res.status(409).json({ success: false, error: 'You have already completed this tournament' });
      }
      // Return existing in-progress attempt questions
    }

    // Fetch questions (no correct_answer)
    const { data: questions, error: qErr } = await supabase
      .from('blitz_questions')
      .select('id, question, format, options, order_index')
      .eq('tournament_id', id)
      .order('order_index', { ascending: true });

    if (qErr) return res.status(500).json({ success: false, error: 'Failed to fetch questions' });

    // Create attempt if not already exists
    if (!existingAttempt) {
      await supabase.from('blitz_attempts').insert({
        tournament_id: id,
        player_id: player.id,
        answers: [],
        score: 0,
        total_time_ms: 0,
        started_at: now.toISOString(),
        status: 'in_progress',
      });
    }

    return res.json({
      success: true,
      data: {
        questions,
        time_limit_seconds: tournament.time_limit_seconds,
        started_at: existingAttempt?.started_at || now.toISOString(),
      },
    });
  } catch (err) {
    console.error('Start attempt error:', err);
    return res.status(500).json({ success: false, error: 'Failed to start attempt' });
  }
});

/**
 * POST /api/blitz/:id/attempt/submit
 * Submit all answers. Scored server-side.
 * Body: { answers: [{question_id, answer, time_taken_ms?}] }
 */
router.post('/:id/attempt/submit', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { answers } = req.body;
    const player = req.player;
    const now = new Date();

    if (!answers || !Array.isArray(answers)) {
      return res.status(400).json({ success: false, error: 'answers array is required' });
    }

    const { data: tournament, error: tErr } = await supabase
      .from('blitz_tournaments')
      .select('*')
      .eq('id', id)
      .single();

    if (tErr || !tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });

    // Fetch player's attempt
    const { data: attempt } = await supabase
      .from('blitz_attempts')
      .select('*')
      .eq('tournament_id', id)
      .eq('player_id', player.id)
      .single();

    if (!attempt) return res.status(403).json({ success: false, error: 'No active attempt found. Start attempt first.' });
    if (attempt.status === 'completed') return res.status(409).json({ success: false, error: 'Attempt already submitted' });

    // Fetch correct answers for scoring
    const { data: questions } = await supabase
      .from('blitz_questions')
      .select('id, correct_answer, format')
      .eq('tournament_id', id);

    // Score server-side
    const { scored, score } = scoreAnswers(questions, answers);

    const totalTimeMs = scored.reduce((sum, a) => sum + (a.time_taken_ms || 0), 0);
    const completedAt = now.toISOString();

    // Update attempt
    await supabase.from('blitz_attempts').update({
      answers: scored,
      score,
      total_time_ms: totalTimeMs,
      completed_at: completedAt,
      status: 'completed',
    }).eq('id', attempt.id);

    // Estimate rank (count players with higher score or same score + less time)
    const { count: betterCount } = await supabase
      .from('blitz_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', id)
      .eq('status', 'completed')
      .or(`score.gt.${score},and(score.eq.${score},total_time_ms.lt.${totalTimeMs})`);

    const rankEstimate = (betterCount || 0) + 1;

    return res.json({
      success: true,
      data: {
        score,
        total_questions: questions.length,
        rank_estimate: rankEstimate,
        total_time_ms: totalTimeMs,
        message: `You scored ${score}/${questions.length}`,
      },
    });
  } catch (err) {
    console.error('Submit attempt error:', err);
    return res.status(500).json({ success: false, error: 'Failed to submit attempt' });
  }
});

/**
 * GET /api/blitz/:id/results
 * Leaderboard (top 20) + player's own position.
 * Only available after status = "completed"
 */
router.get('/:id/results', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const playerId = req.player.id;

    const { data: tournament } = await supabase
      .from('blitz_tournaments')
      .select('id, title, status, prize_pool, platform_cut_percent, total_registered')
      .eq('id', id)
      .single();

    if (!tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });

    if (tournament.status !== 'completed') {
      return res.status(400).json({ success: false, error: 'Results not available yet' });
    }

    // Leaderboard: top 20, sorted by score desc, time asc
    const { data: attempts } = await supabase
      .from('blitz_attempts')
      .select('player_id, score, total_time_ms, completed_at, players(phone, name)')
      .eq('tournament_id', id)
      .eq('status', 'completed')
      .order('score', { ascending: false })
      .order('total_time_ms', { ascending: true })
      .limit(20);

    const leaderboard = (attempts || []).map((a, i) => ({
      position: i + 1,
      player_id: a.player_id,
      name: a.players?.name || null,
      phone: a.players?.phone ? '****' + a.players.phone.slice(-4) : null,
      score: a.score,
      total_time_ms: a.total_time_ms,
    }));

    // Player's own position
    const { count: betterCount } = await supabase
      .from('blitz_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', id)
      .eq('status', 'completed')
      .neq('player_id', playerId);

    const { data: myAttempt } = await supabase
      .from('blitz_attempts')
      .select('score, total_time_ms')
      .eq('tournament_id', id)
      .eq('player_id', playerId)
      .single();

    // Fetch player's prize if any
    const { data: myPrize } = await supabase
      .from('blitz_prizes')
      .select('position, prize_type, amount, ticket_code')
      .eq('tournament_id', id)
      .eq('player_id', playerId)
      .single();

    return res.json({
      success: true,
      data: {
        tournament: { id, title: tournament.title, prize_pool: tournament.prize_pool, total_registered: tournament.total_registered },
        leaderboard,
        player: {
          attempt: myAttempt || null,
          prize: myPrize || null,
        },
      },
    });
  } catch (err) {
    console.error('Get blitz results error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch results' });
  }
});

module.exports = router;
