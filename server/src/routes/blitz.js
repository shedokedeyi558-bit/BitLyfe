const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');
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

  // Get player limits — player may not have any set (returns null cleanly with maybeSingle)
  const { data: limits } = await supabase
    .from('player_limits')
    .select('daily_limit, weekly_limit')
    .eq('player_id', playerId)
    .maybeSingle();

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
 * Score answers server-side against stored correct answers.
 * options_order (per-player shuffle map) is used to reverse-map
 * submitted answers back to canonical correct_answer values.
 *
 * For multiple_choice: exact match (case-insensitive) — options are fixed values.
 * For type_answer: fuzzy match — handles articles ("a cat" = "cat"),
 *   extra qualifiers ("lagos state" = "lagos"), and minor extra words.
 */
function scoreAnswers(questions, submittedAnswers, optionsOrder) {
  const questionMap = {};
  for (const q of questions) questionMap[q.id] = q;

  let score = 0;
  const scored = submittedAnswers.map((sub) => {
    const question = questionMap[sub.question_id];
    if (!question) return { ...sub, is_correct: false };

    const correct = String(question.correct_answer).trim().toLowerCase();
    const player = String(sub.answer).trim().toLowerCase();

    let is_correct = false;

    if (question.format === 'type_answer') {
      is_correct = fuzzyMatch(player, correct);
    } else {
      // multiple_choice: exact match — options are predefined, no ambiguity
      is_correct = player === correct;
    }

    if (is_correct) score++;
    return { question_id: sub.question_id, answer: sub.answer, is_correct, time_taken_ms: sub.time_taken_ms || 0 };
  });

  return { scored, score };
}

/**
 * Fuzzy match for type_answer questions.
 *
 * Rules (all case-insensitive, punctuation-stripped):
 * 1. Exact match after normalisation — "Cat" = "cat" ✓
 * 2. Player answer contains the correct answer as a whole word — "a cat" contains "cat" ✓
 * 3. Correct answer contains the player answer as a whole word — "amazon river" contains "amazon" ✓
 * 4. Player answer is the correct answer with common articles stripped — "the nile" = "nile" ✓
 *
 * Does NOT pass: "dog" when answer is "cat". "port harcourt" when answer is "lagos".
 * Keeps it fair — only handles genuine grammatical variations, not wrong answers.
 */
function fuzzyMatch(playerRaw, correctRaw) {
  // Normalise: lowercase, strip punctuation, collapse whitespace
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

  const player = norm(playerRaw);
  const correct = norm(correctRaw);

  // 1. Exact after normalisation
  if (player === correct) return true;

  // Strip leading articles from both before further checks
  const stripArticles = (s) => s.replace(/^(a |an |the )/, '').trim();
  const playerStripped = stripArticles(player);
  const correctStripped = stripArticles(correct);

  // 2. Exact after stripping articles — "a cat" = "cat", "the nile" = "nile"
  if (playerStripped === correctStripped) return true;

  // 3. Word-boundary containment — correct answer is a whole word within player answer
  //    "lagos state" contains "lagos" → correct
  //    "amazon river" as player when answer is "amazon" → correct
  const wordBoundaryContains = (haystack, needle) => {
    // escape regex special chars in needle
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|\\s)${escaped}(\\s|$)`);
    return re.test(haystack);
  };

  if (wordBoundaryContains(playerStripped, correctStripped)) return true;
  if (wordBoundaryContains(correctStripped, playerStripped)) return true;

  return false;
}

/**
 * Fisher-Yates shuffle — returns a new shuffled array, original unmodified.
 */
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
      .select('id, title, description, entry_fee, question_count, time_limit_seconds, registration_start, tournament_start, tournament_end, status, total_registered, max_participants, prize_pool, total_payout_percent, position_prizes')
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
      .select('id, title, description, entry_fee, question_count, time_limit_seconds, per_question_time_seconds, registration_start, tournament_start, tournament_end, status, total_registered, max_participants, prize_pool, total_payout_percent, position_prizes')
      .eq('id', id)
      .single();

    if (error || !tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });

    // Check player registration — may not exist, use maybeSingle
    const { data: registration } = await supabase
      .from('blitz_registrations')
      .select('id, registered_at, entry_fee_paid')
      .eq('tournament_id', id)
      .eq('player_id', playerId)
      .maybeSingle();

    // Check player attempt — may not exist, use maybeSingle
    const { data: attempt } = await supabase
      .from('blitz_attempts')
      .select('id, score, status, completed_at')
      .eq('tournament_id', id)
      .eq('player_id', playerId)
      .maybeSingle();

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
 * GET /api/blitz/:id/prize-estimate
 * Live prize pool estimate based on current/max registration.
 * Also returns position_prizes so the frontend can show exactly what 2nd/3rd win.
 */
router.get('/:id/prize-estimate', auth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: tournament } = await supabase
      .from('blitz_tournaments')
      .select('id, entry_fee, max_participants, total_registered, cash_winner_count, total_payout_percent, ticket_tier_percent, position_prizes')
      .eq('id', id)
      .single();

    if (!tournament) return res.status(404).json({ success: false, error: 'Tournament not found' });

    const entryFee = Number(tournament.entry_fee || 0);
    const maxParticipants = Number(tournament.max_participants || 20);
    const currentRegistered = Number(tournament.total_registered || 0);
    const cashWinnerCount = Number(tournament.cash_winner_count || 1);
    const totalPayoutPercent = Number(tournament.total_payout_percent || 80);

    // Prize pool = total_payout_percent of total entry revenue (platform keeps the rest)
    const maxPrizePool = Math.floor(maxParticipants * entryFee * (totalPayoutPercent / 100));
    const currentEstimate = Math.floor(currentRegistered * entryFee * (totalPayoutPercent / 100));
    const platformCutPercent = 100 - totalPayoutPercent;

    return res.json({
      success: true,
      data: {
        max_prize_pool: maxPrizePool,
        current_estimate: currentEstimate,
        current_registered: currentRegistered,
        max_participants: maxParticipants,
        cash_winner_count: cashWinnerCount,
        total_payout_percent: totalPayoutPercent,
        platform_cut_percent: platformCutPercent,
        // Explicit per-position non-cash prizes (2nd, 3rd, etc.)
        position_prizes: tournament.position_prizes || [],
      },
    });
  } catch (err) {
    console.error('Get prize estimate error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch prize estimate' });
  }
});

/**
/**
 * POST /api/blitz/:id/register
 * Register player for tournament. Deducts entry fee or validates free ticket from blitz_tickets.
 * Body: { ticket_code?, idempotency_key? }
 */
router.post('/:id/register', idempotency(), auth, async (req, res) => {
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

    // Check already registered — player may not be registered yet
    const { data: existing } = await supabase
      .from('blitz_registrations')
      .select('id')
      .eq('tournament_id', id)
      .eq('player_id', player.id)
      .maybeSingle();

    if (existing) return res.status(409).json({ success: false, error: 'Already registered for this tournament' });

    let entryFeePaid = tournament.entry_fee;
    let usedTicketId = null;

    if (ticket_code) {
      // Validate ticket from blitz_tickets table (free entry or discounted entry)
      const { data: ticket } = await supabase
        .from('blitz_tickets')
        .select('id, expires_at, status, player_id, discount_percent')
        .eq('ticket_code', ticket_code)
        .single();

      if (!ticket) {
        return res.status(404).json({ success: false, code: 'TICKET_NOT_FOUND', error: 'Ticket not found' });
      }

      if (ticket.player_id !== player.id) {
        return res.status(403).json({ success: false, code: 'TICKET_NOT_OWNER', error: 'This ticket does not belong to you' });
      }

      const now = new Date();
      if (new Date(ticket.expires_at) < now && ticket.status === 'unused') {
        await supabase.from('blitz_tickets').update({ status: 'expired' }).eq('id', ticket.id);
        return res.status(410).json({ success: false, code: 'TICKET_EXPIRED', error: 'Ticket has expired' });
      }

      if (ticket.status === 'used') {
        return res.status(409).json({ success: false, code: 'TICKET_ALREADY_USED', error: 'Ticket has already been used' });
      }

      if (ticket.status === 'expired') {
        return res.status(410).json({ success: false, code: 'TICKET_EXPIRED', error: 'Ticket has expired' });
      }

      // discount_percent null/0 = free entry; otherwise deduct discounted amount
      if (ticket.discount_percent && ticket.discount_percent > 0) {
        // Discounted entry — player pays entry_fee * (discount_percent / 100) less
        const discount = Math.floor(tournament.entry_fee * (ticket.discount_percent / 100));
        entryFeePaid = tournament.entry_fee - discount;

        if ((player.balance || 0) + (player.bonus_balance || 0) < entryFeePaid) {
          return res.status(402).json({
            success: false,
            code: 'INSUFFICIENT_BALANCE',
            error: `Insufficient balance. Discounted entry costs ₦${entryFeePaid} (${ticket.discount_percent}% off ₦${tournament.entry_fee})`,
          });
        }

        const limitCheck = await checkSpendLimit(player.id, entryFeePaid);
        if (!limitCheck.allowed) {
          return res.status(429).json({ success: false, code: 'LIMIT_REACHED', error: limitCheck.reason });
        }

        let billing;
        try {
          billing = await deductEntryFee(player.id, entryFeePaid, {
            type: 'blitz_entry',
            description: `Blitz entry (${ticket.discount_percent}% discount): ${tournament.title}`,
          });
        } catch (billingErr) {
          if (billingErr.insufficientFunds) return res.status(402).json({ success: false, error: billingErr.message });
          throw billingErr;
        }
        req._blitzBilling = billing;
      } else {
        // Fully free entry
        entryFeePaid = 0;
      }

      usedTicketId = ticket.id;
    } else {
      // Deduct entry fee — bonus first, real balance for remainder
      if ((player.balance || 0) + (player.bonus_balance || 0) < tournament.entry_fee) {
        return res.status(402).json({ success: false, error: 'Insufficient balance' });
      }

      // Check spend limits
      const limitCheck = await checkSpendLimit(player.id, tournament.entry_fee);
      if (!limitCheck.allowed) {
        return res.status(429).json({ success: false, code: 'LIMIT_REACHED', error: limitCheck.reason });
      }

      let billing;
      try {
        billing = await deductEntryFee(player.id, tournament.entry_fee, {
          type: 'blitz_entry',
          description: `Blitz tournament entry: ${tournament.title}`,
        });
      } catch (billingErr) {
        if (billingErr.insufficientFunds) return res.status(402).json({ success: false, error: billingErr.message });
        throw billingErr;
      }

      // Store billing on outer scope for response
      req._blitzBilling = billing;
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

    // Trigger referral first-game check (fire-and-forget)
    checkReferralCompletion(player.id, 'game').catch(() => {});

    return res.status(201).json({
      success: true,
      data: {
        message: 'Successfully registered',
        tournament: { id, title: tournament.title, tournament_start: tournament.tournament_start },
        entryFeePaid,
        newBalance: req._blitzBilling ? req._blitzBilling.newBalance : player.balance,
        newBonusBalance: req._blitzBilling ? req._blitzBilling.newBonusBalance : player.bonus_balance,
        bonusUsed: req._blitzBilling ? req._blitzBilling.bonusUsed : 0,
      },
    });
  } catch (err) {
    console.error('Register blitz error:', err);
    return res.status(500).json({ success: false, error: 'Failed to register' });
  }
});

/**
 * POST /api/blitz/:id/attempt/start
 * Start player's attempt.
 * - Returns questions WITHOUT correct_answer
 * - Shuffles multiple_choice options per player (anti answer-sharing)
 * - Stores the shuffled options_order on the attempt row
 * - Returns per_question_time_seconds for the client countdown
 * - Returns image_url on questions that have one
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

    if (tournament.status !== 'active') {
      return res.status(403).json({ success: false, error: 'Tournament is not active yet' });
    }

    if (now < new Date(tournament.tournament_start) || now > new Date(tournament.tournament_end)) {
      return res.status(403).json({ success: false, error: 'Tournament playing window is not open' });
    }

    const { data: registration } = await supabase
      .from('blitz_registrations')
      .select('id')
      .eq('tournament_id', id)
      .eq('player_id', player.id)
      .maybeSingle();

    if (!registration) return res.status(403).json({ success: false, error: 'You are not registered for this tournament' });

    const { data: existingAttempt } = await supabase
      .from('blitz_attempts')
      .select('id, status, options_order, started_at')
      .eq('tournament_id', id)
      .eq('player_id', player.id)
      .maybeSingle();

    if (existingAttempt?.status === 'completed') {
      return res.status(409).json({ success: false, error: 'You have already completed this tournament' });
    }

    // Fetch questions — include image_url, exclude correct_answer
    const { data: rawQuestions, error: qErr } = await supabase
      .from('blitz_questions')
      .select('id, question, format, options, order_index, image_url')
      .eq('tournament_id', id)
      .order('order_index', { ascending: true });

    if (qErr) return res.status(500).json({ success: false, error: 'Failed to fetch questions' });

    // ── Shuffle options per player ────────────────────────────────────────────
    // Build a per-player shuffle map: { [question_id]: shuffled_options_array }
    // This is stored on the attempt so submit can reference it if needed.
    // Importantly, options are value-shuffled (not index-mapped), so the answer
    // submitted by the player is still the plain text value — no extra mapping needed.
    let optionsOrder = existingAttempt?.options_order || null;

    if (!optionsOrder) {
      optionsOrder = {};
      for (const q of rawQuestions) {
        if (q.format === 'multiple_choice' && Array.isArray(q.options) && q.options.length > 1) {
          optionsOrder[q.id] = shuffleArray(q.options);
        }
      }
    }

    // Build questions response — swap in shuffled options, never send correct_answer
    const questions = rawQuestions.map((q) => ({
      id: q.id,
      question: q.question,
      format: q.format,
      options: optionsOrder[q.id] || q.options || null,  // shuffled for this player
      order_index: q.order_index,
      image_url: q.image_url || null,
    }));

    // Create attempt (or update existing in-progress one with shuffle map)
    if (!existingAttempt) {
      await supabase.from('blitz_attempts').insert({
        tournament_id: id,
        player_id: player.id,
        answers: [],
        score: 0,
        total_time_ms: 0,
        started_at: now.toISOString(),
        status: 'in_progress',
        options_order: optionsOrder,
      });
    } else if (!existingAttempt.options_order) {
      // Backfill shuffle on resume (first start had no shuffle — legacy)
      await supabase
        .from('blitz_attempts')
        .update({ options_order: optionsOrder })
        .eq('id', existingAttempt.id);
    }

    return res.json({
      success: true,
      data: {
        questions,
        time_limit_seconds: tournament.time_limit_seconds,
        per_question_time_seconds: tournament.per_question_time_seconds || null,
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

    // Fetch player's attempt — may not exist if player never started
    const { data: attempt } = await supabase
      .from('blitz_attempts')
      .select('*')
      .eq('tournament_id', id)
      .eq('player_id', player.id)
      .maybeSingle();

    if (!attempt) return res.status(403).json({ success: false, error: 'No active attempt found. Start attempt first.' });
    if (attempt.status === 'completed') return res.status(409).json({ success: false, error: 'Attempt already submitted' });

    // Fetch correct answers for scoring
    const { data: questions } = await supabase
      .from('blitz_questions')
      .select('id, correct_answer, format')
      .eq('tournament_id', id);

    // Score server-side (optionsOrder stored on attempt — passed for reference)
    const { scored, score } = scoreAnswers(questions, answers, attempt.options_order);

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
      .select('id, title, status, prize_pool, total_registered')
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

    // Player's own attempt — fetch first so we can compute real position
    const { data: myAttempt } = await supabase
      .from('blitz_attempts')
      .select('score, total_time_ms')
      .eq('tournament_id', id)
      .eq('player_id', playerId)
      .maybeSingle();

    // Compute real final position: count how many players beat this player
    // (higher score, or same score + faster time)
    let myPosition = null;
    if (myAttempt) {
      const { count: betterCount } = await supabase
        .from('blitz_attempts')
        .select('id', { count: 'exact', head: true })
        .eq('tournament_id', id)
        .eq('status', 'completed')
        .or(`score.gt.${myAttempt.score},and(score.eq.${myAttempt.score},total_time_ms.lt.${myAttempt.total_time_ms})`);
      myPosition = (betterCount || 0) + 1;
    }

    const { data: myPrize } = await supabase
      .from('blitz_prizes')
      .select('position, prize_type, amount, ticket_code')
      .eq('tournament_id', id)
      .eq('player_id', playerId)
      .maybeSingle();

    return res.json({
      success: true,
      data: {
        tournament: { id, title: tournament.title, prize_pool: tournament.prize_pool, total_registered: tournament.total_registered },
        leaderboard,
        player: {
          position: myPosition,       // real final rank (works even outside top 20)
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
