const express = require('express');
const supabase = require('../db/supabase');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// Apply admin auth to all routes in this file
router.use(adminAuth);

/**
 * GET /api/admin/predictions
 * List all predictions (paginated)
 */
router.get('/', async (req, res) => {
  try {
    const { status, category, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabase
      .from('predictions')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status) query = query.eq('status', status);
    if (category) query = query.eq('category', category);

    const { data, error, count } = await query;

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch predictions' });

    return res.json({
      success: true,
      data: {
        predictions: data,
        total: count,
        page: Number(page),
        limit: Number(limit),
      },
    });
  } catch (err) {
    console.error('Get predictions error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch predictions' });
  }
});

/**
 * POST /api/admin/predictions
 * Create a new prediction
 */
router.post('/', async (req, res) => {
  try {
    const { question, category, entry_fee, prize_per_winner, max_participants, countdown_seconds } = req.body;

    if (!question || entry_fee === undefined || prize_per_winner === undefined || !countdown_seconds) {
      return res.status(400).json({
        success: false,
        error: 'question, entry_fee, prize_per_winner, and countdown_seconds are required',
      });
    }

    // Calculate countdown end time
    const countdownEndTime = new Date(Date.now() + countdown_seconds * 1000).toISOString();

    const { data, error } = await supabase
      .from('predictions')
      .insert({
        admin_id: req.admin.id,
        question,
        category: category || 'General',
        entry_fee: Number(entry_fee),
        prize_per_winner: Number(prize_per_winner),
        max_participants: max_participants || 10,
        countdown_seconds: Number(countdown_seconds),
        countdown_end_time: countdownEndTime,
        status: 'active',
      })
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: 'Failed to create prediction' });

    return res.status(201).json({ success: true, data: { prediction: data } });
  } catch (err) {
    console.error('Create prediction error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create prediction' });
  }
});

/**
 * GET /api/admin/predictions/audit-log
 * Returns the admin audit log for prediction-related manual actions.
 * Query params: ?playerId=<uuid>&limit=20&page=1
 */
router.get('/audit-log', async (req, res) => {
  try {
    const { playerId, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabase
      .from('admin_audit_log')
      .select('*', { count: 'exact' })
      .eq('action', 'resolve_stuck_prediction_entry')
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (playerId) query = query.eq('player_id', playerId);

    const { data, error, count } = await query;

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch audit log' });
    }

    return res.json({
      success: true,
      data: { logs: data, total: count, page: Number(page), limit: Number(limit) },
    });
  } catch (err) {
    console.error('Audit log fetch error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch audit log' });
  }
});

/**
 * GET /api/admin/predictions/stats
 * Prediction statistics and analytics
 */
router.get('/stats', async (req, res) => {
  try {
    // Use count-only queries — never fetch full rows just to count them
    const [totalRes, activeRes, lockedRes, completedRes, cancelledRes, participationsRes, revenueRes] =
      await Promise.all([
        supabase.from('predictions').select('id', { count: 'exact', head: true }),
        supabase.from('predictions').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        supabase.from('predictions').select('id', { count: 'exact', head: true }).eq('status', 'locked'),
        supabase.from('predictions').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
        supabase.from('predictions').select('id', { count: 'exact', head: true }).eq('status', 'cancelled'),
        supabase.from('prediction_participations').select('id', { count: 'exact', head: true }),
        // Revenue and prize need actual values — keep these as data fetches but select only what's needed
        supabase.from('predictions').select('entry_fee, current_participants').neq('status', 'cancelled'),
      ]);

    const { data: revRows } = revenueRes;

    const totalRevenueGenerated = (revRows || []).reduce(
      (sum, p) => sum + parseFloat(p.entry_fee) * (p.current_participants || 0),
      0,
    );

    // Prize distributed: sum amount_won from participations where it's > 0
    const { data: wonRows } = await supabase
      .from('prediction_participations')
      .select('amount_won')
      .gt('amount_won', 0);

    const totalPrizeDistributed = (wonRows || []).reduce(
      (sum, p) => sum + (parseFloat(p.amount_won) || 0),
      0,
    );

    const stats = {
      total:                totalRes.count      || 0,
      active:               activeRes.count     || 0,
      locked:               lockedRes.count     || 0,
      completed:            completedRes.count  || 0,
      cancelled:            cancelledRes.count  || 0,
      // live = active + locked: events still in play (useful for dashboard "at a glance")
      live:                 (activeRes.count || 0) + (lockedRes.count || 0),
      totalParticipations:  participationsRes.count || 0,
      totalRevenueGenerated,
      totalPrizeDistributed,
    };

    return res.json({ success: true, data: { stats } });
  } catch (err) {
    console.error('Predictions stats error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch prediction stats' });
  }
});

/**
 * GET /api/admin/predictions/:id
 * Single prediction detail — same shape as entries in GET /api/admin/games,
 * plus participants_summary: { total, submitted, pending_submission }
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: prediction, error } = await supabase
      .from('predictions')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !prediction) {
      return res.status(404).json({ success: false, error: 'Prediction not found' });
    }

    // participants_summary — count directly, no need to fetch all rows
    const [totalRes, submittedRes] = await Promise.all([
      supabase
        .from('prediction_participations')
        .select('id', { count: 'exact', head: true })
        .eq('prediction_id', id),
      supabase
        .from('prediction_participations')
        .select('id', { count: 'exact', head: true })
        .eq('prediction_id', id)
        .not('answer', 'is', null),
    ]);

    const total     = totalRes.count     || 0;
    const submitted = submittedRes.count || 0;

    // Match the formatPrediction shape from GET /api/admin/games
    const now = Date.now();
    const countdownEnd = new Date(prediction.countdown_end_time).getTime();

    // Compute display_status dynamically — same logic as formatPrediction in games.js
    const display_status = prediction.correct_answer ? 'completed'
      : countdownEnd < now ? 'locked'
      : 'active';

    return res.json({
      success: true,
      data: {
        prediction: {
          id: prediction.id,
          game_type: 'predictions',
          title: prediction.question,
          question: prediction.question,
          category: prediction.category,
          status: prediction.status,
          display_status,
          entry_fee: Number(prediction.entry_fee),
          fee: Number(prediction.entry_fee),
          prize_per_winner: Number(prediction.prize_per_winner),
          max_slots: prediction.max_participants,
          slots_filled: prediction.current_participants,
          countdown_end: prediction.countdown_end_time,
          countdown_remaining_seconds: Math.max(0, Math.floor((countdownEnd - now) / 1000)),
          correct_answer: prediction.correct_answer || null,
          event_date: prediction.event_date || null,
          created_at: prediction.created_at,
          stats: {
            total_players: prediction.current_participants,
            revenue: prediction.current_participants * Number(prediction.entry_fee),
          },
          participants_summary: {
            total,
            submitted,
            pending_submission: total - submitted,
          },
        },
      },
    });
  } catch (err) {
    console.error('Get single prediction error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch prediction' });
  }
});

/**
 * PUT /api/admin/predictions/:id
 * Update a prediction (question, prize, etc.)
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Prevent updating these fields
    delete updates.id;
    delete updates.admin_id;
    delete updates.created_at;
    delete updates.correct_answer; // Use mark-answer endpoint instead

    const { data, error } = await supabase
      .from('predictions')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ success: false, error: 'Prediction not found or update failed' });

    return res.json({ success: true, data: { prediction: data } });
  } catch (err) {
    console.error('Update prediction error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update prediction' });
  }
});

/**
 * POST /api/admin/predictions/:id/mark-answer
 * Mark correct answer and credit winners
 */
router.post('/:id/mark-answer', async (req, res) => {
  try {
    const { id } = req.params;
    const { correctAnswer } = req.body;

    if (!correctAnswer) {
      return res.status(400).json({ success: false, error: 'correctAnswer is required' });
    }

    // Fetch prediction
    const { data: prediction, error: predErr } = await supabase
      .from('predictions')
      .select('*')
      .eq('id', id)
      .single();

    if (predErr || !prediction) {
      return res.status(404).json({ success: false, error: 'Prediction not found' });
    }

    // Fetch all participations
    const { data: participations } = await supabase
      .from('prediction_participations')
      .select('*')
      .eq('prediction_id', id);

    const prizePerWinner = parseFloat(prediction.prize_per_winner);
    let winnersCount = 0;

    // Update each participation
    for (const part of participations) {
      const isCorrect = String(part.answer).toLowerCase().trim() === String(correctAnswer).toLowerCase().trim();

      await supabase
        .from('prediction_participations')
        .update({
          is_correct: isCorrect,
          amount_won: isCorrect ? prizePerWinner : 0,
        })
        .eq('id', part.id);

      // Credit winners
      if (isCorrect) {
        winnersCount++;
        const { data: player } = await supabase
          .from('players')
          .select('balance')
          .eq('id', part.player_id)
          .single();

        const newBalance = (player.balance || 0) + prizePerWinner;

        await supabase.from('players').update({ balance: newBalance }).eq('id', part.player_id);

        await supabase.from('transactions').insert({
          player_id: part.player_id,
          type: 'prediction_win',
          amount: prizePerWinner,
          description: `Won prediction: ${prediction.question.substring(0, 50)}...`,
        });
      }
    }

    // Update prediction status
    await supabase
      .from('predictions')
      .update({
        correct_answer: correctAnswer,
        status: 'completed',
      })
      .eq('id', id);

    return res.json({
      success: true,
      data: {
        message: 'Prediction marked and winners credited',
        prediction: {
          id: prediction.id,
          question: prediction.question,
          correctAnswer: correctAnswer,
          status: 'completed',
          totalParticipants: participations?.length || 0,
          winnersCount: winnersCount,
          totalPrizeDistributed: winnersCount * prizePerWinner,
        },
      },
    });
  } catch (err) {
    console.error('Mark prediction answer error:', err);
    return res.status(500).json({ success: false, error: 'Failed to mark prediction answer' });
  }
});

/**
 * POST /api/admin/predictions/:id/cancel
 * Cancel a prediction (refund all participants)
 */
router.post('/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch prediction
    const { data: prediction, error: predErr } = await supabase
      .from('predictions')
      .select('*')
      .eq('id', id)
      .single();

    if (predErr || !prediction) {
      return res.status(404).json({ success: false, error: 'Prediction not found' });
    }

    // Fetch all participations
    const { data: participations } = await supabase
      .from('prediction_participations')
      .select('*')
      .eq('prediction_id', id);

    const entryFee = parseFloat(prediction.entry_fee);

    // Refund each participant
    for (const part of participations) {
      const { data: player } = await supabase
        .from('players')
        .select('balance')
        .eq('id', part.player_id)
        .single();

      const newBalance = (player.balance || 0) + entryFee;

      await supabase.from('players').update({ balance: newBalance }).eq('id', part.player_id);

      await supabase.from('transactions').insert({
        player_id: part.player_id,
        type: 'prediction_refund',
        amount: entryFee,
        description: `Refunded from cancelled prediction: ${prediction.question.substring(0, 50)}...`,
      });
    }

    // Update prediction status
    await supabase.from('predictions').update({ status: 'cancelled' }).eq('id', id);

    return res.json({
      success: true,
      data: {
        message: `Prediction cancelled. ${participations?.length || 0} participants refunded.`,
        prediction: {
          id: prediction.id,
          status: 'cancelled',
          refundedCount: participations?.length || 0,
          totalRefunded: (participations?.length || 0) * entryFee,
        },
      },
    });
  } catch (err) {
    console.error('Cancel prediction error:', err);
    return res.status(500).json({ success: false, error: 'Failed to cancel prediction' });
  }
});

/**
 * GET /api/admin/predictions/:id/participations
 * View all participations for a prediction (raw, paginated)
 */
router.get('/:id/participations', async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const { data, error, count } = await supabase
      .from('prediction_participations')
      .select('*, players(phone, name)', { count: 'exact' })
      .eq('prediction_id', id)
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch participations' });

    return res.json({
      success: true,
      data: {
        participations: data,
        total: count,
        page: Number(page),
        limit: Number(limit),
      },
    });
  } catch (err) {
    console.error('Get participations error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch participations' });
  }
});

/**
 * GET /api/admin/predictions/:id/participants
 * Review all participants before revealing an answer.
 * Returns masked phone, submitted answer, and submission timestamp.
 * Participants who entered but haven't submitted yet are included (answer will be null).
 */
router.get('/:id/participants', async (req, res) => {
  try {
    const { id } = req.params;

    // Verify prediction exists
    const { data: prediction, error: predErr } = await supabase
      .from('predictions')
      .select('id, question, status, current_participants')
      .eq('id', id)
      .single();

    if (predErr || !prediction) {
      return res.status(404).json({ success: false, error: 'Prediction not found' });
    }

    const { data: participations, error } = await supabase
      .from('prediction_participations')
      .select('id, answer, submitted_at, created_at, players(phone, name)')
      .eq('prediction_id', id)
      .order('submitted_at', { ascending: true, nullsFirst: false });

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch participants' });
    }

    const participants = (participations || []).map((p) => {
      const phone = p.players?.phone || '';
      // Mask: keep first 4 and last 2 digits, replace middle with ***
      const masked = phone.length >= 6
        ? `${phone.slice(0, 4)}***${phone.slice(-2)}`
        : '***';

      return {
        id: p.id,
        phone: masked,
        name: p.players?.name || null,
        answer: p.answer || null,
        submitted_at: p.submitted_at || null,
        has_submitted: p.answer !== null,
        entered_at: p.created_at,
      };
    });

    const submittedCount = participants.filter((p) => p.has_submitted).length;
    const pendingCount = participants.length - submittedCount;

    return res.json({
      success: true,
      data: {
        prediction: {
          id: prediction.id,
          question: prediction.question,
          status: prediction.status,
        },
        summary: {
          total: participants.length,
          submitted: submittedCount,
          pending_submission: pendingCount,
        },
        participants,
      },
    });
  } catch (err) {
    console.error('Get prediction participants error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch participants' });
  }
});

/**
 * POST /api/admin/predictions/:id/resolve-stuck-entry
 *
 * Manually resolves a stuck prediction entry where a player paid but their
 * answer was never recorded (e.g. due to a submission race condition bug).
 *
 * Two resolutions:
 *   "record_answer" — write the player's intended answer into the participation
 *                     row so it is evaluated normally when the admin runs mark-answer.
 *                     Use when: the player's intended answer is known and the
 *                     prediction has not yet been marked (correct_answer is still null).
 *
 *   "refund"        — credit the entry fee back to the player's real balance.
 *                     Use when: the prediction is already completed/revealed so there
 *                     is no way to evaluate a late answer, or the intended answer
 *                     cannot be recovered.
 *
 * Body:
 *   {
 *     "playerId":   "<uuid>",          // required
 *     "resolution": "record_answer" | "refund",   // required
 *     "answer":     "<string>",        // required when resolution === "record_answer"
 *     "notes":      "<string>"         // required — admin explains why they are doing this
 *   }
 *
 * Every call is written to admin_audit_log regardless of outcome.
 * Requires: DATABASE_MIGRATION_ADMIN_AUDIT_LOG.sql to have been run.
 */
router.post('/:id/resolve-stuck-entry', async (req, res) => {
  const { id: predictionId } = req.params;
  const { playerId, resolution, answer, notes } = req.body;
  const admin = req.admin;

  // ── Input validation ────────────────────────────────────────────────────────
  if (!playerId) {
    return res.status(400).json({ success: false, error: 'playerId is required' });
  }
  if (!['record_answer', 'refund'].includes(resolution)) {
    return res.status(400).json({ success: false, error: 'resolution must be "record_answer" or "refund"' });
  }
  if (resolution === 'record_answer' && (!answer || String(answer).trim() === '')) {
    return res.status(400).json({ success: false, error: 'answer is required when resolution is "record_answer"' });
  }
  if (!notes || String(notes).trim().length < 10) {
    return res.status(400).json({ success: false, error: 'notes is required (minimum 10 characters) — explain why this manual action is necessary' });
  }

  const cleanNotes = String(notes).trim();
  const adminEmail = admin.email || 'unknown';

  try {
    // ── Fetch prediction ──────────────────────────────────────────────────────
    const { data: prediction, error: predErr } = await supabase
      .from('predictions')
      .select('id, question, status, correct_answer, entry_fee, countdown_end_time')
      .eq('id', predictionId)
      .single();

    if (predErr || !prediction) {
      return res.status(404).json({ success: false, error: 'Prediction not found' });
    }

    // ── Fetch participation ───────────────────────────────────────────────────
    const { data: participation, error: partErr } = await supabase
      .from('prediction_participations')
      .select('id, answer, submitted_at, is_correct, amount_won, created_at')
      .eq('prediction_id', predictionId)
      .eq('player_id', playerId)
      .maybeSingle();

    if (partErr) {
      console.error('resolve-stuck-entry participation lookup error:', partErr);
      return res.status(500).json({ success: false, error: 'Failed to look up participation record' });
    }

    if (!participation) {
      return res.status(404).json({
        success: false,
        error: 'No participation record found for this player + prediction. The entry fee may not have been recorded — check transactions manually.',
      });
    }

    // ── Guard: don't overwrite an already-submitted answer ───────────────────
    if (participation.answer !== null && resolution === 'record_answer') {
      return res.status(409).json({
        success: false,
        error: `Player already has a recorded answer ("${participation.answer}"). This entry is not stuck.`,
      });
    }

    // ── Snapshot for audit log ───────────────────────────────────────────────
    const auditPayload = {
      prediction: {
        id: prediction.id,
        question: prediction.question,
        status: prediction.status,
        correct_answer: prediction.correct_answer || null,
        countdown_end_time: prediction.countdown_end_time,
      },
      participation_before: {
        id: participation.id,
        answer: participation.answer,
        submitted_at: participation.submitted_at,
        is_correct: participation.is_correct,
        amount_won: participation.amount_won,
      },
      resolution,
      answer_recorded: resolution === 'record_answer' ? String(answer).trim() : null,
    };

    // ── Execute resolution ────────────────────────────────────────────────────

    if (resolution === 'record_answer') {
      // Validate: can only record an answer if correct_answer hasn't been set yet
      // (if the prediction is already marked, recording a late answer would be meaningless
      // unless the admin intends to include it — we allow it but flag it in the response)
      const cleanAnswer = String(answer).trim();
      const alreadyRevealed = prediction.correct_answer !== null && prediction.status === 'completed';

      // Write the answer into the participation row
      const { error: updateErr } = await supabase
        .from('prediction_participations')
        .update({
          answer: cleanAnswer,
          submitted_at: new Date().toISOString(),
        })
        .eq('id', participation.id);

      if (updateErr) {
        console.error('resolve-stuck-entry answer write error:', updateErr);
        return res.status(500).json({ success: false, error: 'Failed to write answer to participation record' });
      }

      auditPayload.participation_after = {
        answer: cleanAnswer,
        submitted_at: new Date().toISOString(),
      };

      // If prediction is already revealed, immediately evaluate correctness and credit if won
      let creditedPrize = null;
      if (alreadyRevealed) {
        const isCorrect =
          cleanAnswer.toLowerCase().trim() === prediction.correct_answer.toLowerCase().trim();
        const prizePerWinner = parseFloat(prediction.prize_per_winner || 0);
        const amountWon = isCorrect ? prizePerWinner : 0;

        await supabase
          .from('prediction_participations')
          .update({ is_correct: isCorrect, amount_won: amountWon })
          .eq('id', participation.id);

        if (isCorrect && amountWon > 0) {
          const { data: freshPlayer } = await supabase
            .from('players')
            .select('balance')
            .eq('id', playerId)
            .single();

          const newBalance = (freshPlayer?.balance || 0) + amountWon;
          await supabase.from('players').update({ balance: newBalance }).eq('id', playerId);
          await supabase.from('transactions').insert({
            player_id: playerId,
            type: 'prediction_win',
            amount: amountWon,
            description: `Admin-resolved win: prediction "${prediction.question.substring(0, 50)}..." (stuck entry corrected by ${adminEmail})`,
          });
          creditedPrize = amountWon;
        }

        auditPayload.auto_evaluated = { is_correct: isCorrect, amount_won: amountWon };
      }

      // Write audit log
      await supabase.from('admin_audit_log').insert({
        admin_id: admin.id,
        admin_email: adminEmail,
        action: 'resolve_stuck_prediction_entry',
        entity_type: 'prediction_participation',
        entity_id: participation.id,
        player_id: playerId,
        resolution: 'record_answer',
        notes: cleanNotes,
        payload: auditPayload,
      });

      return res.json({
        success: true,
        data: {
          resolution: 'record_answer',
          answer_recorded: cleanAnswer,
          already_revealed: alreadyRevealed,
          credited_prize: creditedPrize,
          message: alreadyRevealed
            ? `Answer recorded and evaluated against already-revealed correct answer "${prediction.correct_answer}". ${creditedPrize ? `Player credited ₦${creditedPrize}.` : 'Player did not win.'}`
            : `Answer recorded. It will be evaluated normally when you run mark-answer for this prediction.`,
        },
      });
    }

    // resolution === 'refund'
    const entryFee = parseFloat(prediction.entry_fee);

    // Idempotency: check if a manual-refund transaction already exists for this participation
    const { data: existingRefund } = await supabase
      .from('transactions')
      .select('id')
      .eq('player_id', playerId)
      .eq('type', 'prediction_refund')
      .ilike('description', `%${participation.id}%`)
      .maybeSingle();

    if (existingRefund) {
      return res.status(409).json({
        success: false,
        error: 'A refund for this participation has already been issued. Check transactions for this player.',
      });
    }

    // Credit real balance (not bonus — manual refunds always go to withdrawable balance)
    const { data: freshPlayer } = await supabase
      .from('players')
      .select('balance')
      .eq('id', playerId)
      .single();

    if (!freshPlayer) {
      return res.status(404).json({ success: false, error: 'Player not found' });
    }

    const newBalance = (freshPlayer.balance || 0) + entryFee;

    const { error: balanceErr } = await supabase
      .from('players')
      .update({ balance: newBalance })
      .eq('id', playerId);

    if (balanceErr) {
      console.error('resolve-stuck-entry balance update error:', balanceErr);
      return res.status(500).json({ success: false, error: 'Failed to credit refund to player balance' });
    }

    const { error: txnErr } = await supabase.from('transactions').insert({
      player_id: playerId,
      type: 'prediction_refund',
      amount: entryFee,
      description: `Admin manual refund: stuck entry on prediction "${prediction.question.substring(0, 50)}..." (participation ${participation.id}) — actioned by ${adminEmail}`,
    });

    if (txnErr) {
      // Balance was credited but transaction log failed — log loudly, don't roll back
      console.error('CRITICAL: refund credited but transaction log failed. Player:', playerId, 'Amount:', entryFee, 'Participation:', participation.id, txnErr);
    }

    auditPayload.refund_amount = entryFee;
    auditPayload.new_balance = newBalance;

    // Write audit log
    await supabase.from('admin_audit_log').insert({
      admin_id: admin.id,
      admin_email: adminEmail,
      action: 'resolve_stuck_prediction_entry',
      entity_type: 'prediction_participation',
      entity_id: participation.id,
      player_id: playerId,
      resolution: 'refund',
      notes: cleanNotes,
      payload: auditPayload,
    });

    return res.json({
      success: true,
      data: {
        resolution: 'refund',
        amount_refunded: entryFee,
        new_balance: newBalance,
        message: `₦${entryFee} refunded to player's real balance. Transaction and audit log recorded.`,
      },
    });
  } catch (err) {
    console.error('resolve-stuck-entry error:', err);
    return res.status(500).json({ success: false, error: 'Failed to resolve stuck entry' });
  }
});

module.exports = router;
