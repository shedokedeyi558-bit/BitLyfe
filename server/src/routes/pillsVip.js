/**
 * VIP / Special Pack endpoints — exam-style, one shared timer, pass threshold.
 * Mirrors the logic in pillsSpecial.js but serves the /api/pills/vip/* paths
 * that the frontend calls, with the response envelope the frontend expects.
 *
 * Routes:
 *   POST /api/pills/vip/start
 *   POST /api/pills/vip/answer/:sessionId
 *
 * Both VIP (is_vip=true) and special (pack_type='special') packs are accepted.
 * Attempts are stored in the special_attempts table (one row per player/pack).
 */

const express = require('express');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');
const idempotency = require('../middleware/idempotency');
const { checkAnswer } = require('../services/gameLogic');
const { createNotification } = require('./notifications');
const { deductEntryFee } = require('../services/billing');

const router = express.Router();

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Determine the input mode for type-answer questions based on correct_answer.
 * Returns 'numeric' if the answer is purely numeric (digits, optional decimal/minus/hyphen),
 * otherwise returns 'text'.
 */
function getAnswerInputMode(correctAnswer) {
  if (!correctAnswer || typeof correctAnswer !== 'string') {
    return 'text';
  }

  const numericPattern = /^-?\d+(?:\.\d+)?(?:-\d+)?$/;
  return numericPattern.test(correctAnswer.trim()) ? 'numeric' : 'text';
}

/**
 * Check player's daily and weekly spend limits.
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

  // Get player limits — player may not have any set
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
 * Credit a Specials/VIP prize to a player's balance.
 * Fetches a fresh balance to avoid race conditions, updates the players row,
 * inserts a specials_win transaction, and returns newBalance.
 * Throws on any DB failure so the caller can handle it and never silently skip.
 */
async function creditSpecialsPrize(playerId, prize, packName) {
  // Always re-fetch balance immediately before crediting — never trust cached player
  const { data: fresh, error: fetchErr } = await supabase
    .from('players')
    .select('balance')
    .eq('id', playerId)
    .single();

  if (fetchErr || !fresh) throw new Error(`creditSpecialsPrize: could not fetch player ${playerId}`);

  const newBalance = Number(fresh.balance || 0) + prize;

  const { error: updateErr } = await supabase
    .from('players')
    .update({ balance: newBalance })
    .eq('id', playerId);

  if (updateErr) throw new Error(`creditSpecialsPrize: balance update failed: ${updateErr.message}`);

  const { error: txnErr } = await supabase.from('transactions').insert({
    player_id: playerId,
    type: 'specials_win',
    amount: prize,
    description: `Special exam passed: ${packName}`,
  });

  if (txnErr) throw new Error(`creditSpecialsPrize: transaction insert failed: ${txnErr.message}`);

  return newBalance;
}

/** Fisher-Yates in-place shuffle */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Fetch pills by IDs, re-ordered to match the stored question_ids sequence.
 * Uses parallel .eq() queries instead of .in() — the Supabase JS SDK silently
 * returns empty results for .in('id', uuidArray) on UUID primary key columns.
 */
async function getPillsByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const results = await Promise.all(
    ids.map((id) =>
      supabase
        .from('pills')
        .select('id, question, format, options, correct_answer, color, case_sensitive')
        .eq('id', id)
        .single()
        .then(({ data }) => data)
    )
  );
  return results.filter(Boolean);
}

/**
 * Sanitize a pill for the player — strip correct_answer, add question_number.
 * No per-question timer — exam uses a single shared countdown (exam_duration).
 */
function sanitize(pill, index, total) {
  return {
    question_number: index + 1,
    total_questions: total,
    id: pill.id,
    question: pill.question,
    format: pill.format,
    options: pill.options || null,
    color: pill.color || '#8B5CF6',
    answer_input_mode: pill.format === 'type_answer' ? getAnswerInputMode(pill.correct_answer) : undefined,
  };
}

/** Grade a completed attempt — returns { correct_count } */
async function gradeAttempt(questionIds, answers) {
  const pills = await getPillsByIds(questionIds);
  let correct = 0;
  for (let i = 0; i < pills.length; i++) {
    const submitted = answers[i];
    if (submitted !== null && submitted !== undefined && checkAnswer(pills[i], String(submitted))) {
      correct++;
    }
  }
  return { correct_count: correct };
}

/** Seconds remaining for an in-progress attempt (floor at 0) */
function secondsRemaining(startedAt, totalTimeSeconds) {
  const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  return Math.max(0, totalTimeSeconds - elapsed);
}

/**
 * Smart question selection for Specials exams.
 *
 * Priority: unseen questions first, then already-seen ones (shuffled).
 * Full reset: if the player has seen every question in the bank, clears
 * their history and starts fresh again.
 *
 * New questions added by admin are automatically included in the unseen
 * pool on the player's next attempt — no special detection needed.
 *
 * Also records the selected questions in specials_question_history so
 * the next attempt knows what this player has already seen.
 *
 * @param {string} packId
 * @param {string} playerId
 * @param {number} questionCount  - how many to draw (already validated >= 1)
 * @param {Array}  bankPills      - [{ id }] — all non-deleted pills for this pack
 * @returns {string[]} selectedIds — shuffled array of pill UUIDs, length = questionCount
 */
async function selectQuestionsForAttempt(packId, playerId, questionCount, bankPills) {
  const allIds = (bankPills || []).map((p) => p.id);

  // Fetch this player's history for this pack
  const { data: historyRows, error: histErr } = await supabase
    .from('specials_question_history')
    .select('question_id')
    .eq('pack_id', packId)
    .eq('player_id', playerId);

  if (histErr) {
    // If the table doesn't exist yet (migration not run), fall back to plain shuffle
    if (histErr.code === 'PGRST205' || histErr.message?.includes('schema cache')) {
      console.warn('[selectQuestions] specials_question_history table not found — falling back to plain shuffle');
      const fallback = shuffle([...allIds]);
      return fallback.slice(0, questionCount);
    }
    // Any other error — log and fall back rather than blocking entry
    console.error('[selectQuestions] history fetch error:', histErr.message);
    const fallback = shuffle([...allIds]);
    return fallback.slice(0, questionCount);
  }

  const seenIds = new Set((historyRows || []).map((r) => r.question_id));

  let fresh = allIds.filter((id) => !seenIds.has(id));
  let stale = allIds.filter((id) =>  seenIds.has(id));

  let selectedIds;

  if (fresh.length === 0 && stale.length > 0) {
    // Full cycle complete — reset history for this player+pack, start fresh
    await supabase
      .from('specials_question_history')
      .delete()
      .eq('pack_id', packId)
      .eq('player_id', playerId);
    // All questions are now "fresh" again
    fresh = [...allIds];
    stale = [];
  }

  if (fresh.length >= questionCount) {
    // Plenty of unseen questions — pick randomly from fresh pool only
    selectedIds = shuffle([...fresh]).slice(0, questionCount);
  } else {
    // Some fresh, not enough — take all fresh + fill remainder from shuffled stale
    const needed = questionCount - fresh.length;
    selectedIds = shuffle([...fresh, ...shuffle([...stale]).slice(0, needed)]);
  }

  // Record selected questions in history (upsert — idempotent if attempt is retried)
  if (selectedIds.length > 0) {
    const now = new Date().toISOString();
    const rows = selectedIds.map((qId) => ({
      pack_id:     packId,
      player_id:   playerId,
      question_id: qId,
      shown_at:    now,
    }));
    const { error: upsertErr } = await supabase
      .from('specials_question_history')
      .upsert(rows, { onConflict: 'pack_id,player_id,question_id' });
    if (upsertErr) {
      // Non-fatal — selection already done, just log
      console.error('[selectQuestions] history upsert error:', upsertErr.message);
    }
  }

  return selectedIds;
}

// ─── POST /api/pills/vip/start ────────────────────────────────────────────────

/**
 * POST /api/pills/vip/start
 * Start or resume a VIP/Special pack attempt.
 *
 * New attempt:   charge fee, draw randomized question set, insert into special_attempts.
 * Resume:        return current question + time_remaining (no new charge).
 * Already done:  HTTP 409, ALREADY_ATTEMPTED.
 *
 * Body: { packId } or { pack_id }
 *
 * Success response:
 * {
 *   success: true,
 *   data: {
 *     session_id, pack_id, pack_name, category, entry_fee, prize,
 *     total_questions, required_correct, current_question_index,
 *     is_new_attempt, new_balance, exam_duration,
 *     question: { question_number, total_questions, id, question, format, options, color }
 *   }
 * }
 */
router.post('/start', idempotency(), auth, async (req, res) => {
  try {
    const packId = req.body.packId || req.body.pack_id;
    const player = req.player;

    if (!packId) {
      return res.status(400).json({ success: false, error: 'packId is required' });
    }

    // Fetch pack — use RPC to bypass stale PostgREST schema cache
    const { data: pack, error: packErr } = await supabase
      .rpc('get_pill_pack_for_entry', { p_id: packId });

    if (packErr || !pack) {
      return res.status(404).json({ success: false, error: 'Pack not found' });
    }

    const isSpecial = pack.pack_type === 'special' || pack.is_vip === true;
    if (!isSpecial) {
      return res.status(400).json({
        success: false,
        error: 'This is not a VIP/Special pack. Use POST /api/pills/open instead.',
      });
    }

    if (pack.status !== 'active') {
      return res.status(409).json({ success: false, error: 'This pack is not currently active' });
    }

    const questionCount = pack.question_count || null; // null → use all available pills
    const totalTimeSecs = pack.total_time_seconds || 600;
    const entryFee = pack.entry_fee ? parseFloat(pack.entry_fee) : 0;

    // Check for an existing attempt (UNIQUE player_id+pack_id in special_attempts)
    const { data: existing } = await supabase
      .from('special_attempts')
      .select('id, status, current_question_index, question_ids, answers, started_at, total_time_seconds')
      .eq('player_id', player.id)
      .eq('pack_id', packId)
      .maybeSingle();

    if (existing) {
      // Completed attempt — reject
      if (existing.status === 'passed' || existing.status === 'failed') {
        return res.status(409).json({
          success: false,
          code: 'ALREADY_ATTEMPTED',
          error: 'Already attempted',
        });
      }

      // In-progress — check time
      const secsLeft = secondsRemaining(existing.started_at, existing.total_time_seconds);

      if (secsLeft <= 0) {
        // Time expired — grade and close
        const questionIds = existing.question_ids || [];
        const answers = existing.answers || [];
        const { correct_count } = await gradeAttempt(questionIds, answers);
        const requiredCorrect = pack.required_correct || questionIds.length;
        const passed = correct_count >= requiredCorrect;
        const finalStatus = passed ? 'passed' : 'failed';

        await supabase
          .from('special_attempts')
          .update({ status: finalStatus, correct_count, completed_at: new Date().toISOString() })
          .eq('id', existing.id);

        let newBalance = player.balance;
        if (passed && pack.prize) {
          const prize = parseFloat(pack.prize);
          try {
            newBalance = await creditSpecialsPrize(player.id, prize, pack.name);
          } catch (creditErr) {
            console.error('creditSpecialsPrize (timeout finalize) failed:', creditErr.message);
            // Attempt is already marked passed — log and continue; do not surface to client
          }
          await createNotification(player.id, 'win', 'Special Exam Passed! 🎉',
            `You passed "${pack.name}" with ${correct_count}/${questionIds.length} correct! ₦${prize.toLocaleString()} credited.`
          ).catch(() => {});
        }

        return res.status(409).json({
          success: false,
          code: 'ALREADY_ATTEMPTED',
          error: 'Already attempted',
          timed_out: true,
          result: finalStatus,
        });
      }

      // Resume — still time left
      const questionIds = existing.question_ids || [];
      const idx = existing.current_question_index;
      const pills = await getPillsByIds(questionIds);

      return res.json({
        success: true,
        data: {
          session_id: existing.id,
          pack_id: pack.id,
          pack_name: pack.name,
          category: pack.category || null,
          entry_fee: entryFee,
          prize: pack.prize ? parseFloat(pack.prize) : 0,
          total_questions: pills.length,
          required_correct: pack.required_correct || pills.length,
          current_question_index: idx,
          is_new_attempt: false,
          new_balance: (await supabase.from('players').select('balance').eq('id', player.id).single().then(r => r.data?.balance)) ?? player.balance,
          exam_duration: existing.total_time_seconds,
          time_remaining_seconds: secsLeft,
          question: sanitize(pills[idx], idx, pills.length),
        },
      });
    }

    // ── New attempt ────────────────────────────────────────────────────────────

    // Block new entries if quiz_expires_at has passed.
    // In-progress attempts (resumed above) are NOT affected — only new entries.
    if (pack.quiz_expires_at && new Date(pack.quiz_expires_at) < new Date()) {
      return res.status(410).json({
        success: false,
        code: 'QUIZ_EXPIRED',
        error: 'This pack is no longer accepting new entries — it has ended.',
      });
    }

    // Block new entries if max_entries cap is reached.
    // Both limits are independent — whichever hits first closes the pack.
    if (pack.max_entries !== null && pack.max_entries !== undefined) {
      const currentEntries = pack.current_entries || 0;
      if (currentEntries >= pack.max_entries) {
        return res.status(410).json({
          success: false,
          code: 'ENTRY_CAP_REACHED',
          error: `This pack has reached its maximum entries (${pack.max_entries}). It is now closed.`,
          current_entries: currentEntries,
          max_entries: pack.max_entries,
        });
      }
    }

    // Fetch ALL non-deleted pills from the bank — regardless of status.
    // For Specials, each player draws a fresh randomized set from the full bank.
    // The pill 'status' column (available/played) is only meaningful for Standard Pills
    // where a pill is globally consumed on first play. Specials are NOT stock-gated —
    // entry is gated only by quiz_expires_at (checked above) and one-attempt-per-account.
    const { data: bankPills, error: bankErr } = await supabase
      .from('pills')
      .select('id')
      .eq('pack_id', packId)
      .is('deleted_at', null);   // exclude only soft-deleted pills

    if (bankErr) {
      console.error('VIP start — pills query error:', bankErr);
      return res.status(500).json({ success: false, error: 'Failed to fetch pack questions' });
    }

    const bankSize = (bankPills || []).length;
    const effectiveQuestionCount = questionCount || bankSize;

    if (bankSize < effectiveQuestionCount) {
      return res.status(409).json({
        success: false,
        code: 'INSUFFICIENT_QUESTIONS',
        error: `Pack has only ${bankSize} available question(s), needs at least ${effectiveQuestionCount}.`,
      });
    }

    if (bankSize === 0) {
      return res.status(409).json({
        success: false,
        code: 'INSUFFICIENT_QUESTIONS',
        error: 'This pack has no available questions yet.',
      });
    }

    // Check spend limits
    if (entryFee > 0) {
      const limitCheck = await checkSpendLimit(player.id, entryFee);
      if (!limitCheck.allowed) {
        return res.status(429).json({ success: false, code: 'LIMIT_REACHED', error: limitCheck.reason });
      }
    }

    // Check balance
    if (entryFee > 0 && (player.balance || 0) + (player.bonus_balance || 0) < entryFee) {
      return res.status(402).json({ success: false, error: 'Insufficient balance' });
    }

    // Charge entry fee
    let billing = null;
    if (entryFee > 0) {
      try {
        billing = await deductEntryFee(player.id, entryFee, {
          type: 'pill_open',
          description: `VIP pack entry: ${pack.name}`,
        });
      } catch (billingErr) {
        if (billingErr.insufficientFunds) {
          return res.status(402).json({ success: false, error: billingErr.message });
        }
        throw billingErr;
      }
    }

    // Smart question selection: unseen questions first, then already-seen ones.
    // Falls back to plain shuffle if migration not yet applied.
    const selectedIds = await selectQuestionsForAttempt(
      packId, player.id, effectiveQuestionCount, bankPills
    );

    // Create attempt row in special_attempts
    const { data: attempt, error: attemptErr } = await supabase
      .from('special_attempts')
      .insert({
        player_id: player.id,
        pack_id: packId,
        question_ids: selectedIds,
        current_question_index: 0,
        answers: new Array(effectiveQuestionCount).fill(null),
        total_time_seconds: totalTimeSecs,
        status: 'in_progress',
        correct_count: 0,
      })
      .select('id')
      .single();

    if (attemptErr) {
      // Refund if insert failed
      if (billing) {
        await supabase.from('players').update({
          balance: player.balance,
          bonus_balance: player.bonus_balance || 0,
        }).eq('id', player.id);
      }
      if (attemptErr.code === '23505') {
        return res.status(409).json({
          success: false,
          code: 'ALREADY_ATTEMPTED',
          error: 'Already attempted',
        });
      }
      console.error('VIP start — attempt insert error:', attemptErr);
      return res.status(500).json({ success: false, error: 'Failed to start VIP attempt' });
    }

    // Increment current_entries on the pack — fire-and-forget, never blocks response.
    // This is what powers entries_made / entry_cap_reached on the admin pack list.
    Promise.resolve(
      supabase.rpc('increment_pack_entries', { p_id: packId })
    ).catch((err) => console.error('increment_pack_entries failed:', err));

    const pills = await getPillsByIds(selectedIds);

    return res.status(201).json({
      success: true,
      data: {
        session_id: attempt.id,
        pack_id: pack.id,
        pack_name: pack.name,
        category: pack.category || null,
        entry_fee: entryFee,
        prize: pack.prize ? parseFloat(pack.prize) : 0,
        total_questions: effectiveQuestionCount,
        required_correct: pack.required_correct || effectiveQuestionCount,
        current_question_index: 0,
        is_new_attempt: true,
        new_balance: billing ? billing.newBalance : player.balance,
        new_bonus_balance: billing ? billing.newBonusBalance : (player.bonus_balance || 0),
        bonus_used: billing ? billing.bonusUsed : 0,
        exam_duration: totalTimeSecs,
        time_remaining_seconds: totalTimeSecs,
        question: sanitize(pills[0], 0, pills.length),
      },
    });
  } catch (err) {
    console.error('VIP start error:', err);
    return res.status(500).json({ success: false, error: 'Failed to start VIP pack' });
  }
});

// ─── POST /api/pills/vip/answer/:sessionId ────────────────────────────────────

/**
 * POST /api/pills/vip/answer/:sessionId
 * Submit answer for the current question in a VIP/Special attempt.
 *
 * Each question locks independently via lock_special_answer() — an atomic
 * DB-level conditional UPDATE that only fires when the slot is currently null.
 * A duplicate submission (double-click, retry) returns 409 ALREADY_ANSWERED.
 *
 * Non-final question response:
 * { success: true, data: { correct, correct_answer, locked_at,
 *     next_question, next_question_index, streak_complete: false,
 *     entry_fee, question_number } }
 *
 * Final question response:
 * { success: true, data: { correct, correct_answer, locked_at,
 *     streak_complete: true, passed, score, prize, new_balance,
 *     entry_fee, question_number } }
 *
 * Body: { answer }
 */
router.post('/answer/:sessionId', auth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { answer } = req.body;
    const player = req.player;

    if (answer === undefined || answer === null) {
      return res.status(400).json({ success: false, error: 'answer is required (send empty string to skip)' });
    }

    // Fetch attempt from special_attempts — include answer_locked_at for lock state
    const { data: attempt, error: attemptErr } = await supabase
      .from('special_attempts')
      .select('id, player_id, pack_id, question_ids, current_question_index, answers, answer_locked_at, started_at, total_time_seconds, status')
      .eq('id', sessionId)
      .single();

    if (attemptErr || !attempt) {
      return res.status(404).json({ success: false, error: 'VIP session not found' });
    }

    if (attempt.player_id !== player.id) {
      return res.status(403).json({ success: false, error: 'This session does not belong to you' });
    }

    if (attempt.status !== 'in_progress') {
      return res.status(409).json({
        success: false,
        code: attempt.status === 'passed' ? 'ALREADY_WON' : 'ALREADY_FAILED',
        error: `This session has already ended with status: ${attempt.status}`,
      });
    }

    const questionIds = attempt.question_ids || [];
    const idx = attempt.current_question_index;
    const secsLeft = secondsRemaining(attempt.started_at, attempt.total_time_seconds);
    const timedOut = secsLeft <= 0;

    if (idx >= questionIds.length) {
      return res.status(409).json({ success: false, error: 'All questions already answered' });
    }

    // ── Block submissions after timeout ───────────────────────────────────────
    // Timer has expired — no new submissions allowed. Return immediately without locking.
    if (timedOut) {
      return res.status(408).json({
        success: false,
        code: 'TIMEOUT_EXPIRED',
        error: 'The timer has expired. This question is now locked.',
        locked: true,
      });
    }

    // ── Atomic per-question lock ──────────────────────────────────────────────
    // lock_special_answer() does:
    //   UPDATE special_attempts
    //   SET answers[idx] = answer, answer_locked_at[idx] = now
    //   WHERE id = sessionId AND status = 'in_progress'
    //     AND answer_locked_at[idx] IS NULL   ← the gate
    // Returns 1 if lock acquired, 0 if already locked.
    const now = new Date().toISOString();
    const { data: lockCount, error: lockErr } = await supabase
      .rpc('lock_special_answer', {
        p_attempt_id: sessionId,
        p_player_id:  player.id,
        p_idx:        idx,
        p_answer:     String(answer),
        p_now:        now,
      });

    if (lockErr) {
      console.error('lock_special_answer RPC error:', lockErr);
      return res.status(500).json({ success: false, error: 'Failed to lock answer' });
    }

    if (lockCount === 0) {
      // Slot already locked. Re-fetch attempt to get post-RPC state —
      // pre-RPC attempt.answers may still be null, causing false conflict detection.
      const { data: freshAttemptForRetry } = await supabase
        .from('special_attempts')
        .select('answers, answer_locked_at')
        .eq('id', sessionId)
        .single();

      const existingLocks   = freshAttemptForRetry?.answer_locked_at || attempt.answer_locked_at || [];
      const existingAnswers = freshAttemptForRetry?.answers || attempt.answers || [];
      const existingLockedAt  = existingLocks[idx] || null;
      const existingAnswer    = existingAnswers[idx];

      if (existingAnswer !== null && existingAnswer !== undefined && String(existingAnswer) === String(answer)) {
        // Idempotent retry — re-derive and return the same result the original request returned
        const [retryPill] = await getPillsByIds([questionIds[idx]]);
        const isCorrect   = retryPill ? checkAnswer(retryPill, String(answer)) : false;

        const { data: retryPack } = await supabase
          .from('pill_packs')
          .select('name, entry_fee, prize, required_correct, question_count')
          .eq('id', attempt.pack_id)
          .single();

        const entryFeeRetry     = retryPack?.entry_fee ? parseFloat(retryPack.entry_fee) : 0;
        const requiredCorrectRetry = retryPack?.required_correct || questionIds.length;
        const nextIdxRetry      = idx + 1;
        const isLastRetry       = nextIdxRetry >= questionIds.length;

        if (isLastRetry) {
          // Re-fetch final counts for the completed attempt
          const { data: doneAttempt } = await supabase
            .from('special_attempts')
            .select('status, correct_count, answers')
            .eq('id', sessionId)
            .single();
          const passed = doneAttempt?.status === 'passed';
          const prize = passed ? parseFloat(retryPack?.prize || 0) : 0;
          const finalAnswers = doneAttempt?.answers || [];

          // (d) Per-question stats — fire-and-forget, may have been skipped on crash
          Promise.resolve(supabase.rpc('increment_pill_stats', {
            p_pill_id:    questionIds[idx],
            p_is_correct: isCorrect,
          })).catch(() => {});

          // Compensating credit: if passed but no specials_win transaction exists, apply credit now
          let currentBalance;
          const { data: freshBal } = await supabase.from('players').select('balance').eq('id', player.id).single();
          currentBalance = freshBal?.balance ?? player.balance;

          if (passed && prize > 0) {
            const { data: existingTxn } = await supabase
              .from('transactions')
              .select('id')
              .eq('player_id', player.id)
              .eq('type', 'specials_win')
              .ilike('description', `%${retryPack?.name || ''}%`)
              .maybeSingle();

            if (!existingTxn) {
              try {
                currentBalance = await creditSpecialsPrize(player.id, prize, retryPack?.name || attempt.pack_id);
              } catch (creditErr) {
                console.error('[vip-replay] compensating credit failed:', creditErr.message);
                // Don't crash the idempotent replay — return current balance as-is
              }
              await createNotification(player.id, 'win', 'Special Exam Passed! 🏆',
                `₦${prize.toLocaleString()} credited.`).catch(() => {});
            } else {
              const { data: fp } = await supabase.from('players').select('balance').eq('id', player.id).single();
              currentBalance = fp?.balance ?? currentBalance;
            }
          }

          // Build per-question breakdown for review
          const retryAllPills = await getPillsByIds(questionIds);
          const retryQuestionsBreakdown = questionIds.map((qId, i) => {
            const pill = retryAllPills[i];
            const playerAnswer = finalAnswers[i];
            const isCorrectAnswer = playerAnswer !== null && playerAnswer !== undefined && checkAnswer(pill, String(playerAnswer));
            
            return {
              question_number: i + 1,
              question_text: pill?.question || '',
              format: pill?.format || 'mcq',
              options: pill?.format === 'mcq' ? (pill?.options || []) : null,
              player_answer: playerAnswer !== null && playerAnswer !== undefined ? String(playerAnswer) : null,
              correct_answer: pill?.correct_answer || '',
              is_correct: isCorrectAnswer,
            };
          });

          return res.json({
            success: true,
            idempotent_replay: true,
            data: {
              correct: isCorrect,
              correct_answer: retryPill?.correct_answer ?? null,
              locked: true,
              locked_at: existingLockedAt,
              streak_complete: true,
              passed,
              score: doneAttempt?.correct_count ?? 0,
              prize,
              new_balance: currentBalance,
              entry_fee: entryFeeRetry,
              question_number: idx + 1,
              total_questions: questionIds.length,
              required_correct: requiredCorrectRetry,
              questions_breakdown: retryQuestionsBreakdown,
            },
          });
        }

        // Non-final — return the same "next question" response shape
        const retryPills   = await getPillsByIds(questionIds);
        const nextPillRetry = retryPills[nextIdxRetry];
        return res.json({
          success: true,
          idempotent_replay: true,
          data: {
            correct: isCorrect,
            correct_answer: retryPill?.correct_answer ?? null,
            locked: true,
            locked_at: existingLockedAt,
            next_question: nextPillRetry ? sanitize(nextPillRetry, nextIdxRetry, questionIds.length) : null,
            next_question_index: nextIdxRetry,
            streak_complete: false,
            entry_fee: entryFeeRetry,
            question_number: idx + 1,
            questions_remaining: questionIds.length - nextIdxRetry,
            time_remaining_seconds: Math.max(0, secsLeft),
          },
        });
      }

      // Different answer — genuine conflict
      return res.status(409).json({
        success: false,
        code: 'ALREADY_ANSWERED',
        error: 'This question has already been answered with a different answer',
        locked: true,
        locked_at: existingLockedAt,
        question_number: idx + 1,
      });
    }
    // ── Lock acquired — read back the current answers array ──────────────────

    // Re-fetch attempt to get the answers array as updated by the RPC
    const { data: freshAttempt } = await supabase
      .from('special_attempts')
      .select('answers')
      .eq('id', sessionId)
      .single();

    const currentAnswers = freshAttempt?.answers || new Array(questionIds.length).fill(null);

    // Fetch the current pill for grading + correct_answer reveal
    const [currentPill] = await getPillsByIds([questionIds[idx]]);
    if (!currentPill) {
      return res.status(500).json({ success: false, error: 'Could not load current question' });
    }

    const isCorrect = checkAnswer(currentPill, String(answer));

    // Increment per-question stats atomically (fire-and-forget).
    // Only reached after lock acquired — retries never get here, so no double-counting.
    Promise.resolve(supabase.rpc('increment_pill_stats', {
      p_pill_id:    questionIds[idx],
      p_is_correct: isCorrect,
    })).catch((err) => console.error('increment_pill_stats error:', err));
    const nextIdx = idx + 1;
    const isLastQuestion = nextIdx >= questionIds.length;

    // Fetch pack for prize/threshold
    const { data: pack } = await supabase
      .from('pill_packs')
      .select('name, entry_fee, prize, required_correct, question_count')
      .eq('id', attempt.pack_id)
      .single();

    const entryFee = pack?.entry_fee ? parseFloat(pack.entry_fee) : 0;
    const requiredCorrect = pack?.required_correct || questionIds.length;

    // Complete attempt if last question answered or time ran out
    if (isLastQuestion || timedOut) {
      const { correct_count } = await gradeAttempt(questionIds, currentAnswers);
      const passed = correct_count >= requiredCorrect;
      const finalStatus = passed ? 'passed' : 'failed';

      await supabase
        .from('special_attempts')
        .update({
          current_question_index: nextIdx,
          status: finalStatus,
          correct_count,
          completed_at: new Date().toISOString(),
        })
        .eq('id', sessionId);

      let newBalance = player.balance;
      let prizeCredited = 0;

      if (passed && pack?.prize) {
        const prize = parseFloat(pack.prize);
        prizeCredited = prize;
        try {
          newBalance = await creditSpecialsPrize(player.id, prize, pack.name);
        } catch (creditErr) {
          console.error('creditSpecialsPrize failed — attempt marked passed but balance not updated:', creditErr.message);
          // Surface the error; do NOT silently swallow. Client will see 500 and can retry.
          return res.status(500).json({
            success: false,
            code: 'PRIZE_CREDIT_FAILED',
            error: 'Exam passed but prize credit failed — contact support. Your result is saved.',
          });
        }
        await createNotification(
          player.id, 'win',
          'Special Exam Passed! 🏆',
          `You passed "${pack.name}" with ${correct_count}/${questionIds.length} correct! ₦${prize.toLocaleString()} credited.`
        ).catch(() => {});
      }

      // Build per-question breakdown for review
      const allPills = await getPillsByIds(questionIds);
      const questionsBreakdown = questionIds.map((qId, i) => {
        const pill = allPills[i];
        const playerAnswer = currentAnswers[i];
        const isCorrectAnswer = playerAnswer !== null && playerAnswer !== undefined && checkAnswer(pill, String(playerAnswer));
        
        return {
          question_number: i + 1,
          question_text: pill?.question || '',
          format: pill?.format || 'mcq',
          options: pill?.format === 'mcq' ? (pill?.options || []) : null,
          player_answer: playerAnswer !== null && playerAnswer !== undefined ? String(playerAnswer) : null,
          correct_answer: pill?.correct_answer || '',
          is_correct: isCorrectAnswer,
        };
      });

      return res.json({
        success: true,
        data: {
          correct: isCorrect,
          correct_answer: currentPill.correct_answer,
          locked: true,
          locked_at: now,
          streak_complete: true,
          passed,
          score: correct_count,
          prize: prizeCredited,
          new_balance: newBalance,
          entry_fee: entryFee,
          question_number: idx + 1,
          total_questions: questionIds.length,
          required_correct: requiredCorrect,
          timed_out: timedOut && !isLastQuestion,
          questions_breakdown: questionsBreakdown,
        },
      });
    }

    // More questions remain — advance current_question_index
    await supabase
      .from('special_attempts')
      .update({ current_question_index: nextIdx })
      .eq('id', sessionId);

    const pills = await getPillsByIds(questionIds);
    const nextPill = pills[nextIdx];

    return res.json({
      success: true,
      data: {
        correct: isCorrect,
        correct_answer: currentPill.correct_answer,
        locked: true,
        locked_at: now,
        next_question: sanitize(nextPill, nextIdx, questionIds.length),
        next_question_index: nextIdx,
        streak_complete: false,
        entry_fee: entryFee,
        question_number: idx + 1,
        questions_remaining: questionIds.length - nextIdx,
        time_remaining_seconds: Math.max(0, secsLeft),
      },
    });
  } catch (err) {
    console.error('VIP answer error:', err);
    return res.status(500).json({ success: false, error: 'Failed to process VIP answer' });
  }
});

module.exports = router;
