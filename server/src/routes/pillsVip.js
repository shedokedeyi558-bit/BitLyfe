const express = require('express');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');
const idempotency = require('../middleware/idempotency');
const { checkAnswer } = require('../services/gameLogic');
const { createNotification } = require('./notifications');
const { deductEntryFee } = require('../services/billing');

const router = express.Router();

/**
 * Helper: fetch ordered pills for a VIP pack (by created_at, available only)
 */
async function getVipPills(packId) {
  const { data, error } = await supabase
    .from('pills')
    .select('id, question, format, options, correct_answer, timer_seconds, color, case_sensitive, spelling_tolerance')
    .eq('pack_id', packId)
    .eq('status', 'available')
    .order('created_at', { ascending: true });
  return { pills: data || [], error };
}

/**
 * Sanitize a pill for sending to player — strip correct_answer
 */
function sanitizePill(pill, index, total) {
  return {
    question_number: index + 1,
    total_questions: total,
    id: pill.id,
    question: pill.question,
    format: pill.format,
    options: pill.options || null,
    timer: pill.timer_seconds,
    color: pill.color || '#00FF66',
  };
}

// ─── POST /api/pills/vip/start ─────────────────────────────────────────────────

/**
 * POST /api/pills/vip/start
 * Charge entry fee and start (or resume) a VIP pack attempt.
 * Idempotent: if an in_progress attempt already exists, resume it.
 * Body: { packId, idempotency_key? }
 *
 * Response shapes:
 *   New attempt:
 *   { success: true, session_id, resumed: false, question: {...}, questions_remaining: N }
 *
 *   Resumed attempt:
 *   { success: true, session_id, resumed: true, question: {...}, questions_remaining: N }
 */
router.post('/start', idempotency(), auth, async (req, res) => {
  try {
    const { packId } = req.body;
    const player = req.player;

    if (!packId) {
      return res.status(400).json({ success: false, error: 'packId is required' });
    }

    // Fetch pack — must be VIP and active
    const { data: pack, error: packErr } = await supabase
      .from('pill_packs')
      .select('id, name, entry_fee, prize, is_vip, status')
      .eq('id', packId)
      .single();

    if (packErr || !pack) {
      return res.status(404).json({ success: false, error: 'Pack not found' });
    }

    if (!pack.is_vip) {
      return res.status(400).json({ success: false, error: 'This pack is not a VIP pack. Use POST /api/pills/open instead.' });
    }

    if (pack.status !== 'active') {
      return res.status(409).json({ success: false, error: 'VIP pack is not currently active' });
    }

    const entryFee = pack.entry_fee ? parseFloat(pack.entry_fee) : 0;

    // Check if player already has an attempt for this pack
    const { data: existingAttempt } = await supabase
      .from('vip_attempts')
      .select('id, current_question_index, status')
      .eq('player_id', player.id)
      .eq('pack_id', packId)
      .maybeSingle();

    if (existingAttempt) {
      if (existingAttempt.status === 'in_progress') {
        // Resume — no new charge
        const { pills } = await getVipPills(packId);

        if (existingAttempt.current_question_index >= pills.length) {
          return res.status(409).json({ success: false, error: 'All questions answered — no further questions available' });
        }

        const currentPill = pills[existingAttempt.current_question_index];

        return res.json({
          success: true,
          resumed: true,
          session_id: existingAttempt.id,
          question: sanitizePill(currentPill, existingAttempt.current_question_index, pills.length),
          questions_remaining: pills.length - existingAttempt.current_question_index,
          newBalance: player.balance,
        });
      }

      if (existingAttempt.status === 'won') {
        return res.status(409).json({ success: false, code: 'ALREADY_WON', error: 'You have already completed and won this VIP pack' });
      }

      if (existingAttempt.status === 'failed') {
        return res.status(409).json({ success: false, code: 'ALREADY_FAILED', error: 'Your attempt on this VIP pack has ended. A new attempt is not available.' });
      }
    }

    // Validate minimum 10 questions
    const { pills, error: pillsErr } = await getVipPills(packId);
    if (pillsErr) {
      return res.status(500).json({ success: false, error: 'Failed to fetch pack questions' });
    }

    if (pills.length < 10) {
      return res.status(409).json({
        success: false,
        code: 'INSUFFICIENT_QUESTIONS',
        error: `VIP pack has only ${pills.length} questions. Minimum is 10.`,
      });
    }

    // Check balance (bonus + real combined)
    if ((player.balance || 0) + (player.bonus_balance || 0) < entryFee) {
      return res.status(402).json({ success: false, error: 'Insufficient balance' });
    }

    // Charge entry fee — bonus first, real balance for remainder. Transaction recorded inside.
    let billing;
    try {
      billing = await deductEntryFee(player.id, entryFee, {
        type: 'pill_open',
        description: `VIP pack entry: ${pack.name}`,
      });
    } catch (billingErr) {
      if (billingErr.insufficientFunds) return res.status(402).json({ success: false, error: billingErr.message });
      throw billingErr;
    }

    // Create attempt
    const { data: attempt, error: attemptErr } = await supabase
      .from('vip_attempts')
      .insert({
        player_id: player.id,
        pack_id: packId,
        current_question_index: 0,
        status: 'in_progress',
      })
      .select('id')
      .single();

    if (attemptErr) {
      // Refund if insert failed — restore both deducted amounts
      if (entryFee > 0 && billing) {
        await supabase.from('players').update({
          balance: player.balance,
          bonus_balance: player.bonus_balance || 0,
        }).eq('id', player.id);
      }
      return res.status(500).json({ success: false, error: 'Failed to start VIP attempt' });
    }

    return res.status(201).json({
      success: true,
      resumed: false,
      session_id: attempt.id,
      question: sanitizePill(pills[0], 0, pills.length),
      questions_remaining: pills.length,
      newBalance: billing ? billing.newBalance : player.balance,
      newBonusBalance: billing ? billing.newBonusBalance : (player.bonus_balance || 0),
      bonusUsed: billing ? billing.bonusUsed : 0,
    });
  } catch (err) {
    console.error('VIP start error:', err);
    return res.status(500).json({ success: false, error: 'Failed to start VIP pack' });
  }
});

// ─── POST /api/pills/vip/answer/:sessionId ─────────────────────────────────────

/**
 * POST /api/pills/vip/answer/:sessionId
 * Submit answer for the current question in a VIP attempt.
 *
 * Correct + more questions remain → advance to next, return next question
 * Correct + was last question    → mark won, credit prize, return result
 * Incorrect                      → mark failed, no refund, return which question + correct answer
 *
 * Body: { answer }
 *
 * Response shapes:
 *   Correct, more remain:
 *   { success: true, result: "correct", next_question: {...}, questions_remaining: N }
 *
 *   Correct, last question (won):
 *   { success: true, result: "won", prize: N, newBalance: N, message: "..." }
 *
 *   Incorrect (failed):
 *   { success: true, result: "failed", failed_on_question: N, correct_answer: "...", message: "..." }
 */
router.post('/answer/:sessionId', auth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { answer } = req.body;
    const player = req.player;

    if (!answer && answer !== '0') {
      return res.status(400).json({ success: false, error: 'answer is required' });
    }

    // Fetch attempt
    const { data: attempt, error: attemptErr } = await supabase
      .from('vip_attempts')
      .select('id, player_id, pack_id, current_question_index, status')
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
        code: attempt.status === 'won' ? 'ALREADY_WON' : 'ALREADY_FAILED',
        error: `This VIP session has already ended with status: ${attempt.status}`,
      });
    }

    // Fetch pack for prize value
    const { data: pack } = await supabase
      .from('pill_packs')
      .select('name, prize')
      .eq('id', attempt.pack_id)
      .single();

    // Fetch ordered pills
    const { pills } = await getVipPills(attempt.pack_id);

    if (pills.length === 0) {
      return res.status(500).json({ success: false, error: 'No questions available for this pack' });
    }

    const idx = attempt.current_question_index;

    if (idx >= pills.length) {
      return res.status(409).json({ success: false, error: 'All questions already answered' });
    }

    const currentPill = pills[idx];

    // Check answer using shared normalizer (trim, lowercase, strip trailing punctuation)
    const correct = checkAnswer(currentPill, String(answer));

    if (!correct) {
      // Mark attempt as failed
      await supabase
        .from('vip_attempts')
        .update({ status: 'failed', completed_at: new Date().toISOString() })
        .eq('id', sessionId);

      return res.json({
        success: true,
        result: 'failed',
        failed_on_question: idx + 1,
        total_questions: pills.length,
        correct_answer: currentPill.correct_answer,
        message: `Incorrect on question ${idx + 1}. No refund — better luck next time!`,
      });
    }

    // Correct answer
    const isLastQuestion = idx + 1 >= pills.length;

    if (isLastQuestion) {
      // Player has answered all questions correctly — they won
      const prize = pack?.prize ? parseFloat(pack.prize) : 0;

      await supabase
        .from('vip_attempts')
        .update({
          status: 'won',
          current_question_index: idx + 1,
          completed_at: new Date().toISOString(),
        })
        .eq('id', sessionId);

      if (prize > 0) {
        const { data: freshPlayer } = await supabase
          .from('players')
          .select('balance')
          .eq('id', player.id)
          .single();

        const newBalance = (freshPlayer?.balance || 0) + prize;

        await supabase.from('players').update({ balance: newBalance }).eq('id', player.id);

        await supabase.from('transactions').insert({
          player_id: player.id,
          type: 'pill_win',
          amount: prize,
          description: `Won VIP pack: ${pack?.name || attempt.pack_id}`,
        });

        await createNotification(
          player.id, 'win',
          'VIP Pack Complete! 🏆',
          `You answered all ${pills.length} questions correctly! ₦${prize.toLocaleString()} credited to your wallet.`
        );

        return res.json({
          success: true,
          result: 'won',
          prize,
          newBalance,
          total_questions: pills.length,
          message: `You answered all ${pills.length} questions correctly! ₦${prize.toLocaleString()} won.`,
        });
      }

      return res.json({
        success: true,
        result: 'won',
        prize: 0,
        total_questions: pills.length,
        message: `You answered all ${pills.length} questions correctly!`,
      });
    }

    // Correct, more questions remain — advance to next
    const nextIdx = idx + 1;

    await supabase
      .from('vip_attempts')
      .update({ current_question_index: nextIdx })
      .eq('id', sessionId);

    const nextPill = pills[nextIdx];

    return res.json({
      success: true,
      result: 'correct',
      next_question: sanitizePill(nextPill, nextIdx, pills.length),
      questions_remaining: pills.length - nextIdx,
    });
  } catch (err) {
    console.error('VIP answer error:', err);
    return res.status(500).json({ success: false, error: 'Failed to process VIP answer' });
  }
});

module.exports = router;
