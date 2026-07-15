/**
 * Special Pack endpoints — exam-style, one shared timer, admin-configurable pass threshold,
 * randomized per-player question sets, one attempt per account.
 *
 * Routes:
 *   POST /api/pills/special/start
 *   POST /api/pills/special/answer/:attemptId
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
 * Fisher-Yates shuffle — in-place
 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Fetch pills by IDs (in stored order — we preserve order from question_ids array)
 */
async function getPillsByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const { data } = await supabase
    .from('pills')
    .select('id, question, format, options, correct_answer, color, case_sensitive, spelling_tolerance')
    .in('id', ids);
  // Re-order to match the stored question_ids sequence
  const map = {};
  for (const p of data || []) map[p.id] = p;
  return ids.map((id) => map[id]).filter(Boolean);
}

/**
 * Sanitize a pill for the player — never expose correct_answer mid-exam
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
  };
}

/**
 * Grade a completed attempt:
 * Compare each answer against the correct pill answer, count correct ones.
 * Returns { correct_count }
 */
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

/**
 * Compute seconds remaining for an in-progress attempt.
 * Returns 0 if time has already expired.
 */
function secondsRemaining(startedAt, totalTimeSeconds) {
  const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  return Math.max(0, totalTimeSeconds - elapsed);
}

// ─── POST /api/pills/special/start ────────────────────────────────────────────

/**
 * POST /api/pills/special/start
 * Start or resume a Special pack attempt.
 *
 * New attempt:   charge fee, draw randomized question set, create special_attempts row.
 * Resume:        return current question + time_remaining (no new charge).
 * Already done:  reject with ALREADY_ATTEMPTED.
 *
 * Body: { packId, idempotency_key? }
 */
router.post('/start', idempotency(), auth, async (req, res) => {
  try {
    const { packId } = req.body;
    const player = req.player;

    if (!packId) {
      return res.status(400).json({ success: false, error: 'packId is required' });
    }

    // Fetch pack — must be special type and active
    const { data: pack, error: packErr } = await supabase
      .from('pill_packs')
      .select('id, name, entry_fee, prize, status, pack_type, is_vip, question_count, total_time_seconds, required_correct, entry_window_end')
      .eq('id', packId)
      .single();

    if (packErr || !pack) {
      return res.status(404).json({ success: false, error: 'Pack not found' });
    }

    const isSpecial = pack.pack_type === 'special' || pack.is_vip;
    if (!isSpecial) {
      return res.status(400).json({ success: false, error: 'This is not a special pack. Use POST /api/pills/open instead.' });
    }

    if (pack.status !== 'active') {
      return res.status(409).json({ success: false, error: 'Special pack is not currently active' });
    }

    // Check entry window
    if (pack.entry_window_end && new Date(pack.entry_window_end) < new Date()) {
      return res.status(409).json({ success: false, code: 'ENTRY_CLOSED', error: 'Entry window for this special has closed' });
    }

    const questionCount = pack.question_count || 10;
    const totalTimeSecs = pack.total_time_seconds || 600;
    const entryFee = pack.entry_fee ? parseFloat(pack.entry_fee) : 0;

    // Check for existing attempt (unique constraint guarantees at most one)
    const { data: existing } = await supabase
      .from('special_attempts')
      .select('id, status, current_question_index, question_ids, answers, started_at, total_time_seconds')
      .eq('player_id', player.id)
      .eq('pack_id', packId)
      .maybeSingle();

    if (existing) {
      if (existing.status === 'passed' || existing.status === 'failed') {
        return res.status(409).json({
          success: false,
          code: 'ALREADY_ATTEMPTED',
          error: `You have already ${existing.status} this special. One attempt per account.`,
          result: existing.status,
        });
      }

      // in_progress — resume, check if time expired
      const secsLeft = secondsRemaining(existing.started_at, existing.total_time_seconds);

      if (secsLeft <= 0) {
        // Time ran out — grade whatever was answered so far and close the attempt
        const questionIds = existing.question_ids || [];
        const answers = existing.answers || [];
        const { correct_count } = await gradeAttempt(questionIds, answers);
        const requiredCorrect = pack.required_correct || questionCount;
        const passed = correct_count >= requiredCorrect;
        const finalStatus = passed ? 'passed' : 'failed';

        await supabase
          .from('special_attempts')
          .update({ status: finalStatus, correct_count, completed_at: new Date().toISOString() })
          .eq('id', existing.id);

        let newBalance = player.balance;
        if (passed && pack.prize) {
          const prize = parseFloat(pack.prize);
          const { data: fresh } = await supabase.from('players').select('balance').eq('id', player.id).single();
          newBalance = (fresh?.balance || 0) + prize;
          await supabase.from('players').update({ balance: newBalance }).eq('id', player.id);
          await supabase.from('transactions').insert({
            player_id: player.id, type: 'pill_win', amount: prize,
            description: `Passed special pack: ${pack.name}`,
          });
          await createNotification(player.id, 'win', 'Special Pack Passed! 🎉',
            `You passed "${pack.name}" with ${correct_count}/${questionIds.length} correct! ₦${prize.toLocaleString()} credited.`);
        }

        return res.json({
          success: true,
          timed_out: true,
          result: finalStatus,
          correct_count,
          required_correct: requiredCorrect,
          total_questions: questionIds.length,
          prize_credited: passed ? parseFloat(pack.prize || 0) : 0,
          newBalance,
          message: passed ? `Time up — but you passed with ${correct_count}/${questionIds.length}!` : `Time up — ${correct_count}/${questionIds.length} correct. Required: ${requiredCorrect}.`,
        });
      }

      // Resume with time still remaining
      const questionIds = existing.question_ids || [];
      const idx = existing.current_question_index;
      const pills = await getPillsByIds(questionIds);

      return res.json({
        success: true,
        resumed: true,
        attempt_id: existing.id,
        question: sanitize(pills[idx], idx, pills.length),
        questions_remaining: pills.length - idx,
        time_remaining_seconds: secsLeft,
        total_time_seconds: existing.total_time_seconds,
      });
    }

    // New attempt — validate question bank
    const { data: bankPills, error: bankErr } = await supabase
      .from('pills')
      .select('id')
      .eq('pack_id', packId)
      .eq('status', 'available');

    if (bankErr) return res.status(500).json({ success: false, error: 'Failed to fetch question bank' });

    const bankSize = (bankPills || []).length;
    if (bankSize < questionCount) {
      return res.status(409).json({
        success: false,
        code: 'INSUFFICIENT_QUESTIONS',
        error: `Pack has only ${bankSize} available questions, needs at least ${questionCount}.`,
      });
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
          description: `Special pack entry: ${pack.name}`,
        });
      } catch (billingErr) {
        if (billingErr.insufficientFunds) return res.status(402).json({ success: false, error: billingErr.message });
        throw billingErr;
      }
    }

    // Randomly select question_count pills from the bank
    const allIds = (bankPills || []).map((p) => p.id);
    shuffle(allIds);
    const selectedIds = allIds.slice(0, questionCount);

    // Create attempt row
    const { data: attempt, error: attemptErr } = await supabase
      .from('special_attempts')
      .insert({
        player_id: player.id,
        pack_id: packId,
        question_ids: selectedIds,
        current_question_index: 0,
        answers: new Array(questionCount).fill(null),
        total_time_seconds: totalTimeSecs,
        status: 'in_progress',
        correct_count: 0,
      })
      .select('id')
      .single();

    if (attemptErr) {
      // Refund on failure
      if (billing) {
        await supabase.from('players').update({
          balance: player.balance,
          bonus_balance: player.bonus_balance || 0,
        }).eq('id', player.id);
      }
      // Handle unique constraint violation (double-tap race condition)
      if (attemptErr.code === '23505') {
        return res.status(409).json({ success: false, code: 'ALREADY_ATTEMPTED', error: 'An attempt for this pack already exists.' });
      }
      return res.status(500).json({ success: false, error: 'Failed to start special attempt' });
    }

    const pills = await getPillsByIds(selectedIds);

    return res.status(201).json({
      success: true,
      resumed: false,
      attempt_id: attempt.id,
      question: sanitize(pills[0], 0, pills.length),
      question_count: questionCount,
      total_time_seconds: totalTimeSecs,
      required_correct: pack.required_correct || questionCount,
      time_remaining_seconds: totalTimeSecs,
      newBalance: billing ? billing.newBalance : player.balance,
      newBonusBalance: billing ? billing.newBonusBalance : (player.bonus_balance || 0),
      bonusUsed: billing ? billing.bonusUsed : 0,
    });
  } catch (err) {
    console.error('Special start error:', err);
    return res.status(500).json({ success: false, error: 'Failed to start special pack' });
  }
});

// ─── POST /api/pills/special/answer/:attemptId ────────────────────────────────

/**
 * POST /api/pills/special/answer/:attemptId
 * Record answer for the current question. Does NOT reveal correct/incorrect mid-exam.
 *
 * Time check: if elapsed > total_time_seconds, force-grade immediately.
 * If more questions remain: return next question + time_remaining.
 * If last question (or time ran out): grade, determine pass/fail, credit prize if passed.
 *
 * Body: { answer }
 *
 * Response — next question:
 *   { success, result: "next", next_question, questions_remaining, time_remaining_seconds }
 *
 * Response — completed (pass or fail):
 *   { success, result: "passed"|"failed", correct_count, required_correct,
 *     total_questions, prize_credited, newBalance, message }
 */
router.post('/answer/:attemptId', auth, async (req, res) => {
  try {
    const { attemptId } = req.params;
    const { answer } = req.body;
    const player = req.player;

    if (answer === undefined || answer === null) {
      return res.status(400).json({ success: false, error: 'answer is required (send empty string to skip)' });
    }

    const { data: attempt, error: attemptErr } = await supabase
      .from('special_attempts')
      .select('id, player_id, pack_id, question_ids, current_question_index, answers, started_at, total_time_seconds, status')
      .eq('id', attemptId)
      .single();

    if (attemptErr || !attempt) {
      return res.status(404).json({ success: false, error: 'Special attempt not found' });
    }

    if (attempt.player_id !== player.id) {
      return res.status(403).json({ success: false, error: 'This attempt does not belong to you' });
    }

    if (attempt.status !== 'in_progress') {
      return res.status(409).json({
        success: false,
        code: 'ALREADY_COMPLETED',
        error: `Attempt already ${attempt.status}`,
        result: attempt.status,
      });
    }

    const questionIds = attempt.question_ids || [];
    const currentAnswers = attempt.answers || new Array(questionIds.length).fill(null);
    const idx = attempt.current_question_index;
    const secsLeft = secondsRemaining(attempt.started_at, attempt.total_time_seconds);
    const timedOut = secsLeft <= 0;

    // Record this answer (even if timed out — it was submitted)
    currentAnswers[idx] = String(answer);
    const nextIdx = idx + 1;
    const isLastQuestion = nextIdx >= questionIds.length;

    // Fetch pack for prize/threshold
    const { data: pack } = await supabase
      .from('pill_packs')
      .select('name, prize, required_correct, question_count')
      .eq('id', attempt.pack_id)
      .single();

    const requiredCorrect = pack?.required_correct || questionIds.length;

    // Complete the attempt if: last question answered OR timed out
    if (isLastQuestion || timedOut) {
      const { correct_count } = await gradeAttempt(questionIds, currentAnswers);
      const passed = correct_count >= requiredCorrect;
      const finalStatus = passed ? 'passed' : 'failed';

      await supabase
        .from('special_attempts')
        .update({
          answers: currentAnswers,
          current_question_index: nextIdx,
          status: finalStatus,
          correct_count,
          completed_at: new Date().toISOString(),
        })
        .eq('id', attemptId);

      let newBalance = player.balance;
      let prizeCredited = 0;

      if (passed && pack?.prize) {
        const prize = parseFloat(pack.prize);
        prizeCredited = prize;
        const { data: fresh } = await supabase.from('players').select('balance').eq('id', player.id).single();
        newBalance = (fresh?.balance || 0) + prize;
        await supabase.from('players').update({ balance: newBalance }).eq('id', player.id);
        await supabase.from('transactions').insert({
          player_id: player.id, type: 'pill_win', amount: prize,
          description: `Passed special pack: ${pack.name}`,
        });
        await createNotification(player.id, 'win', 'Special Pack Passed! 🎉',
          `You passed "${pack.name}" with ${correct_count}/${questionIds.length} correct! ₦${prize.toLocaleString()} credited.`);
      }

      return res.json({
        success: true,
        result: finalStatus,
        timed_out: timedOut && !isLastQuestion,
        correct_count,
        required_correct: requiredCorrect,
        total_questions: questionIds.length,
        prize_credited: prizeCredited,
        newBalance,
        message: passed
          ? `Passed! ${correct_count}/${questionIds.length} correct.`
          : `Failed — ${correct_count}/${questionIds.length} correct. Required: ${requiredCorrect}.`,
      });
    }

    // More questions remain — advance and return next question
    await supabase
      .from('special_attempts')
      .update({ answers: currentAnswers, current_question_index: nextIdx })
      .eq('id', attemptId);

    const pills = await getPillsByIds(questionIds);
    const nextPill = pills[nextIdx];

    return res.json({
      success: true,
      result: 'next',
      next_question: sanitize(nextPill, nextIdx, questionIds.length),
      questions_remaining: questionIds.length - nextIdx,
      time_remaining_seconds: Math.max(0, secsLeft),
    });
  } catch (err) {
    console.error('Special answer error:', err);
    return res.status(500).json({ success: false, error: 'Failed to process answer' });
  }
});

module.exports = router;
