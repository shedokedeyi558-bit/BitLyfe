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
 * Reads from the shared `pills` table — same table the admin endpoint writes to.
 */
async function getPillsByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const { data } = await supabase
    .from('pills')
    .select('id, question, format, options, correct_answer, timer_seconds, color, case_sensitive')
    .in('id', ids);
  const map = {};
  for (const p of data || []) map[p.id] = p;
  return ids.map((id) => map[id]).filter(Boolean);
}

/**
 * Sanitize a pill for the player — strip correct_answer, add question_number.
 * Uses the pill's own timer_seconds for the per-question timer field.
 */
function sanitize(pill, index, total) {
  return {
    question_number: index + 1,
    total_questions: total,
    id: pill.id,
    question: pill.question,
    format: pill.format,
    options: pill.options || null,
    timer: pill.timer_seconds || 30,
    color: pill.color || '#8B5CF6',
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
 *     question: { question, format, options, timer }
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

    // Fetch pack — must be vip/special type and active
    const { data: pack, error: packErr } = await supabase
      .from('pill_packs')
      .select('id, name, category, entry_fee, prize, status, pack_type, is_vip, question_count, total_time_seconds, required_correct, quiz_expires_at')
      .eq('id', packId)
      .single();

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
          const { data: fresh } = await supabase.from('players').select('balance').eq('id', player.id).single();
          newBalance = (fresh?.balance || 0) + prize;
          await supabase.from('players').update({ balance: newBalance }).eq('id', player.id);
          await supabase.from('transactions').insert({
            player_id: player.id, type: 'pill_win', amount: prize,
            description: `Passed VIP pack: ${pack.name}`,
          });
          await createNotification(player.id, 'win', 'VIP Pack Passed! 🎉',
            `You passed "${pack.name}" with ${correct_count}/${questionIds.length} correct! ₦${prize.toLocaleString()} credited.`);
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
          new_balance: player.balance,
          exam_duration: existing.total_time_seconds,
          time_remaining_seconds: secsLeft,
          question: sanitize(pills[idx], idx, pills.length),
        },
      });
    }

    // ── New attempt ────────────────────────────────────────────────────────────

    // Block new entries if quiz_expires_at has passed.
    // In-progress attempts (resumed above) are NOT affected — only new entries.
    // This is independent of entry_window_end (Time Machine / predictions only).
    if (pack.quiz_expires_at && new Date(pack.quiz_expires_at) < new Date()) {
      return res.status(410).json({
        success: false,
        code: 'QUIZ_EXPIRED',
        error: 'This pack is no longer accepting new entries — it has ended.',
      });
    }

    // Fetch available pills from the shared `pills` table, filtered by pack_id only.
    // Exclude soft-deleted pills (deleted_at IS NOT NULL) — they stay in the DB
    // for historical attempt auditing but must not appear in new attempt draws.
    const { data: bankPills, error: bankErr } = await supabase
      .from('pills')
      .select('id')
      .eq('pack_id', packId)
      .eq('status', 'available')
      .is('deleted_at', null);

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

    // Randomly draw effectiveQuestionCount pills from the bank
    const allIds = (bankPills || []).map((p) => p.id);
    shuffle(allIds);
    const selectedIds = allIds.slice(0, effectiveQuestionCount);

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
      // Slot already locked. Determine if this is a same-player retry of the same answer
      // (connection dropped before the original response arrived) or a genuine conflict.
      const existingLocks   = attempt.answer_locked_at || [];
      const existingAnswers = attempt.answers || [];
      const existingLockedAt  = existingLocks[idx]   || null;
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
            .select('status, correct_count')
            .eq('id', sessionId)
            .single();
          const { data: freshPlayer } = await supabase
            .from('players').select('balance').eq('id', player.id).single();
          return res.json({
            success: true,
            idempotent_replay: true,
            data: {
              correct: isCorrect,
              correct_answer: retryPill?.correct_answer ?? null,
              locked: true,
              locked_at: existingLockedAt,
              streak_complete: true,
              passed: doneAttempt?.status === 'passed',
              score: doneAttempt?.correct_count ?? 0,
              prize: doneAttempt?.status === 'passed' ? parseFloat(retryPack?.prize || 0) : 0,
              new_balance: freshPlayer?.balance ?? player.balance,
              entry_fee: entryFeeRetry,
              question_number: idx + 1,
              total_questions: questionIds.length,
              required_correct: requiredCorrectRetry,
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
    supabase.rpc('increment_pill_stats', {
      p_pill_id:    questionIds[idx],
      p_is_correct: isCorrect,
    }).catch((err) => console.error('increment_pill_stats error:', err));
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
        const { data: fresh } = await supabase.from('players').select('balance').eq('id', player.id).single();
        newBalance = (fresh?.balance || 0) + prize;
        await supabase.from('players').update({ balance: newBalance }).eq('id', player.id);
        await supabase.from('transactions').insert({
          player_id: player.id,
          type: 'pill_win',
          amount: prize,
          description: `Passed VIP pack: ${pack.name}`,
        });
        await createNotification(
          player.id, 'win',
          'VIP Pack Passed! 🏆',
          `You passed "${pack.name}" with ${correct_count}/${questionIds.length} correct! ₦${prize.toLocaleString()} credited.`
        );
      }

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
