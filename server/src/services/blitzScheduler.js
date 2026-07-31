/**
 * blitzScheduler.js
 *
 * Automated Blitz tournament status transitions.
 * Designed for Render free tier: NOT time-exact, self-healing catch-up.
 *
 * Column names (from blitz_tournaments):
 *   registration_start  → draft        → registration
 *   tournament_start    → registration → active
 *   tournament_end      → active       → scoring → completed
 *
 * Safe to call repeatedly. Idempotent per tournament per transition.
 * Each transition is logged with triggeredBy ('scheduler' or 'admin').
 */

const supabase = require('../db/supabase');
const { createNotifications } = require('../routes/notifications');

// ─── Shared scoring logic ─────────────────────────────────────────────────────
// Extracted from POST /api/admin/blitz/:id/score so both the scheduler
// and the admin route can call the same code path.

function generateTicketCode() {
  return 'TKT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

/**
 * scoreAndCompleteTournament(id, triggeredBy)
 *
 * Scores a tournament that is in 'active' or 'scoring' state.
 * Idempotent: already-awarded prizes are skipped.
 * Returns a summary object.
 */
async function scoreAndCompleteTournament(id, triggeredBy = 'admin') {
  const { data: tournament } = await supabase
    .from('blitz_tournaments')
    .select('*')
    .eq('id', id)
    .single();

  if (!tournament) throw new Error(`Tournament ${id} not found`);
  if (!['active', 'scoring'].includes(tournament.status)) {
    throw new Error(`Cannot score: status is ${tournament.status}`);
  }

  // Move to scoring immediately — prevents double-scoring if called concurrently
  await supabase.from('blitz_tournaments').update({ status: 'scoring' }).eq('id', id);
  console.log(`[blitzScheduler] ${id} → scoring (triggeredBy: ${triggeredBy})`);

  // Ranked leaderboard: score desc, time asc
  const { data: attempts } = await supabase
    .from('blitz_attempts')
    .select('id, player_id, score, total_time_ms')
    .eq('tournament_id', id)
    .eq('status', 'completed')
    .order('score', { ascending: false })
    .order('total_time_ms', { ascending: true });

  if (!attempts || attempts.length === 0) {
    await supabase.from('blitz_tournaments').update({ status: 'completed' }).eq('id', id);
    console.log(`[blitzScheduler] ${id} → completed (0 participants, triggeredBy: ${triggeredBy})`);
    return { message: 'No participants to score', total_participants: 0, total_cash_distributed: 0, non_cash_prizes_awarded: 0 };
  }

  let totalCashPaid = 0;
  let nonCashAwarded = 0;
  const prizeRecords = [];

  // ── Cash prizes ──────────────────────────────────────────────────────────
  const totalRevenue = tournament.total_registered * Number(tournament.entry_fee || 0);

  // ── NEW PRIZE MODEL (first_place_percent is set on this tournament) ───────
  // 1st = first_place_percent % of actual entry revenue (cash)
  // 2nd = free-entry ticket (always, no percent needed)
  // 3rd = third_place_discount_percent % off next entry (discount ticket)
  //
  // LEGACY model (first_place_percent is null): uses payout_distribution /
  // position_prizes / ticket_tier_percent as before — untouched.
  // ─────────────────────────────────────────────────────────────────────────
  const useNewPrizeModel = tournament.first_place_percent != null;

  if (useNewPrizeModel) {
    const firstPlacePct = Number(tournament.first_place_percent);
    const thirdDiscountPct = tournament.third_place_discount_percent != null
      ? Number(tournament.third_place_discount_percent)
      : null;

    // ── 1st place: cash ───────────────────────────────────────────────────
    if (attempts.length >= 1) {
      const attempt = attempts[0];

      const { data: existing } = await supabase
        .from('blitz_prizes')
        .select('id')
        .eq('tournament_id', id)
        .eq('player_id', attempt.player_id)
        .eq('position', 1)
        .maybeSingle();

      if (!existing) {
        const cashPrize = Math.round(totalRevenue * firstPlacePct / 100);

        const { data: player } = await supabase
          .from('players').select('balance').eq('id', attempt.player_id).single();

        await supabase
          .from('players')
          .update({ balance: (player?.balance || 0) + cashPrize })
          .eq('id', attempt.player_id);

        await supabase.from('transactions').insert({
          player_id: attempt.player_id,
          type: 'blitz_prize',
          amount: cashPrize,
          description: `Blitz 1st place (${firstPlacePct}%): ${tournament.title}`,
        });

        prizeRecords.push({ tournament_id: id, player_id: attempt.player_id, position: 1, prize_type: 'cash', amount: cashPrize });
        totalCashPaid += cashPrize;

        await createNotifications([{
          player_id: attempt.player_id,
          type: 'win',
          title: 'Blitz Prize! 🥇',
          message: `You finished 1st in ${tournament.title}! ₦${cashPrize.toLocaleString()} credited to your wallet.`,
        }]);
      }
    }

    // ── 2nd place: free-entry ticket ──────────────────────────────────────
    if (attempts.length >= 2) {
      const attempt = attempts[1];

      const { data: existing } = await supabase
        .from('blitz_prizes')
        .select('id')
        .eq('tournament_id', id)
        .eq('player_id', attempt.player_id)
        .eq('position', 2)
        .maybeSingle();

      if (!existing) {
        const ticketCode = generateTicketCode();
        // No expiry — redeemable on first future Blitz the player registers for
        const expiresAt = new Date();
        expiresAt.setFullYear(expiresAt.getFullYear() + 2); // 2 years as practical no-expiry

        await supabase.from('blitz_tickets').insert({
          player_id: attempt.player_id,
          source_tournament_id: id,
          ticket_code: ticketCode,
          expires_at: expiresAt.toISOString(),
          status: 'unused',
          discount_percent: null, // null = free entry
        });

        prizeRecords.push({ tournament_id: id, player_id: attempt.player_id, position: 2, prize_type: 'free_ticket', ticket_code: ticketCode, amount: 0 });
        nonCashAwarded++;

        await createNotifications([{
          player_id: attempt.player_id,
          type: 'win',
          title: 'Free Blitz Entry! 🥈🎫',
          message: `You finished 2nd in ${tournament.title}! Your free entry ticket: ${ticketCode} — use it when registering for your next Blitz.`,
        }]);
      }
    }

    // ── 3rd place: discount ticket ────────────────────────────────────────
    if (attempts.length >= 3 && thirdDiscountPct !== null) {
      const attempt = attempts[2];

      const { data: existing } = await supabase
        .from('blitz_prizes')
        .select('id')
        .eq('tournament_id', id)
        .eq('player_id', attempt.player_id)
        .eq('position', 3)
        .maybeSingle();

      if (!existing) {
        const ticketCode = generateTicketCode();
        const expiresAt = new Date();
        expiresAt.setFullYear(expiresAt.getFullYear() + 2);

        await supabase.from('blitz_tickets').insert({
          player_id: attempt.player_id,
          source_tournament_id: id,
          ticket_code: ticketCode,
          expires_at: expiresAt.toISOString(),
          status: 'unused',
          discount_percent: thirdDiscountPct,
        });

        prizeRecords.push({ tournament_id: id, player_id: attempt.player_id, position: 3, prize_type: 'discount', ticket_code: ticketCode, amount: 0 });
        nonCashAwarded++;

        await createNotifications([{
          player_id: attempt.player_id,
          type: 'win',
          title: `${thirdDiscountPct}% Off Next Blitz! 🥉🏷️`,
          message: `You finished 3rd in ${tournament.title}! Use code ${ticketCode} for ${thirdDiscountPct}% off your next Blitz entry.`,
        }]);
      }
    }

  } else {

  // ── LEGACY prize model ────────────────────────────────────────────────────
  const cashPool = Math.floor(totalRevenue * (Number(tournament.total_payout_percent || 80) / 100));
  const payoutDistribution = tournament.payout_distribution || [100];
  const cashWinnerCount = Number(tournament.cash_winner_count || 1);
  const guaranteedMinimum = tournament.guaranteed_minimum ? Number(tournament.guaranteed_minimum) : null;

  for (let i = 0; i < Math.min(cashWinnerCount, attempts.length); i++) {
    const attempt = attempts[i];
    const rank = i + 1;

    const { data: existing } = await supabase
      .from('blitz_prizes')
      .select('id')
      .eq('tournament_id', id)
      .eq('player_id', attempt.player_id)
      .eq('position', rank)
      .maybeSingle();
    if (existing) continue;

    const percentage = Number(payoutDistribution[i] || 0);
    let prize = Math.floor(cashPool * (percentage / 100));
    if (guaranteedMinimum && prize < guaranteedMinimum) prize = guaranteedMinimum;

    const { data: player } = await supabase
      .from('players')
      .select('balance')
      .eq('id', attempt.player_id)
      .single();

    await supabase
      .from('players')
      .update({ balance: (player?.balance || 0) + prize })
      .eq('id', attempt.player_id);

    await supabase.from('transactions').insert({
      player_id: attempt.player_id,
      type: 'blitz_prize',
      amount: prize,
      description: `Blitz prize — Position ${rank}: ${tournament.title}`,
    });

    prizeRecords.push({ tournament_id: id, player_id: attempt.player_id, position: rank, prize_type: 'cash', amount: prize });
    totalCashPaid += prize;

    const rankEmoji = ['🥇', '🥈', '🥉'][i] || '✨';
    await createNotifications([{
      player_id: attempt.player_id,
      type: 'win',
      title: `Blitz Prize! ${rankEmoji}`,
      message: `You finished #${rank} in ${tournament.title}! ₦${prize.toLocaleString()} credited to your wallet.`,
    }]);
  }

  // ── Non-cash prizes ───────────────────────────────────────────────────────
  const positionPrizes = tournament.position_prizes;

  if (positionPrizes && Array.isArray(positionPrizes) && positionPrizes.length > 0) {
    for (const prizeDef of positionPrizes) {
      const rank = Number(prizeDef.position);
      const prizeType = prizeDef.prize_type;
      const discountPercent = prizeDef.discount_percent ? Number(prizeDef.discount_percent) : null;

      if (rank > attempts.length) continue;
      const attempt = attempts[rank - 1];

      const { data: existing } = await supabase
        .from('blitz_prizes')
        .select('id')
        .eq('tournament_id', id)
        .eq('player_id', attempt.player_id)
        .eq('position', rank)
        .maybeSingle();
      if (existing) continue;

      const ticketCode = generateTicketCode();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      await supabase.from('blitz_tickets').insert({
        player_id: attempt.player_id,
        source_tournament_id: id,
        ticket_code: ticketCode,
        expires_at: expiresAt.toISOString(),
        status: 'unused',
        ...(prizeType === 'discount' && discountPercent ? { discount_percent: discountPercent } : {}),
      });

      prizeRecords.push({ tournament_id: id, player_id: attempt.player_id, position: rank, prize_type: prizeType, ticket_code: ticketCode, amount: 0 });
      nonCashAwarded++;

      let notifTitle, notifMsg;
      if (prizeType === 'free_ticket') {
        notifTitle = 'Free Blitz Entry! 🎫';
        notifMsg = `You finished #${rank} in ${tournament.title}! You've won a FREE entry. Code: ${ticketCode} (valid 30 days).`;
      } else {
        notifTitle = `${discountPercent}% Off Next Blitz Entry! 🏷️`;
        notifMsg = `You finished #${rank} in ${tournament.title}! Use code ${ticketCode} for ${discountPercent}% off (valid 30 days).`;
      }
      await createNotifications([{ player_id: attempt.player_id, type: 'win', title: notifTitle, message: notifMsg }]);
    }
  } else {
    // Legacy ticket_tier_percent fallback
    const ticketTierPercent = Number(tournament.ticket_tier_percent || 0);
    if (ticketTierPercent > 0) {
      const remainingParticipants = Math.max(0, attempts.length - cashWinnerCount);
      const ticketCount = Math.max(1, Math.floor(remainingParticipants * (ticketTierPercent / 100)));

      for (let i = cashWinnerCount; i < Math.min(cashWinnerCount + ticketCount, attempts.length); i++) {
        const attempt = attempts[i];
        const rank = i + 1;

        const { data: existing } = await supabase
          .from('blitz_prizes')
          .select('id')
          .eq('tournament_id', id)
          .eq('player_id', attempt.player_id)
          .eq('position', rank)
          .maybeSingle();
        if (existing) continue;

        const ticketCode = generateTicketCode();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);

        await supabase.from('blitz_tickets').insert({
          player_id: attempt.player_id,
          source_tournament_id: id,
          ticket_code: ticketCode,
          expires_at: expiresAt.toISOString(),
          status: 'unused',
        });

        prizeRecords.push({ tournament_id: id, player_id: attempt.player_id, position: rank, prize_type: 'free_ticket', ticket_code: ticketCode, amount: 0 });
        nonCashAwarded++;

        await createNotifications([{
          player_id: attempt.player_id,
          type: 'win',
          title: 'Free Blitz Ticket! 🎫',
          message: `You won a free entry ticket from ${tournament.title}. Code: ${ticketCode}. Valid 7 days.`,
        }]);
      }
    }
  }

  if (prizeRecords.length > 0) {
    await supabase.from('blitz_prizes').insert(prizeRecords);
  }

  // Close the legacy else block (new prize model skips to here directly)
  } // end legacy else

  await supabase.from('blitz_tournaments').update({ status: 'completed' }).eq('id', id);
  console.log(`[blitzScheduler] ${id} → completed (${attempts.length} participants, ₦${totalCashPaid} distributed, triggeredBy: ${triggeredBy})`);

  // Persist a scoring audit record so GET /api/admin/blitz/:id/results can report
  // when scoring ran and whether it was automatic or manual.
  // Uses entity_type = 'blitz_tournament', action = 'blitz_scored'.
  await supabase.from('admin_audit_log').insert({
    admin_id: '00000000-0000-0000-0000-000000000000',
    admin_email: triggeredBy === 'admin' ? 'admin@bitlyfe.internal' : 'scheduler@bitlyfe.internal',
    action: 'blitz_scored',
    entity_type: 'blitz_tournament',
    entity_id: id,
    player_id: null,
    resolution: triggeredBy,
    notes: `Tournament scored. ${attempts.length} participants. ₦${totalCashPaid} distributed. triggered_by: ${triggeredBy}`,
    payload: {
      triggered_by: triggeredBy,
      total_participants: attempts.length,
      total_cash_distributed: totalCashPaid,
      non_cash_prizes_awarded: nonCashAwarded,
    },
  }).catch(err => {
    // Don't fail scoring if audit insert fails — just log it
    console.error(`[blitzScheduler] audit log insert failed for ${id}:`, err.message);
  });

  return {
    message: 'Tournament scored and prizes distributed',
    total_participants: attempts.length,
    cash_winners: Math.min(cashWinnerCount, attempts.length),
    total_cash_distributed: totalCashPaid,
    non_cash_prizes_awarded: nonCashAwarded,
  };
}

// ─── Main catch-up check ──────────────────────────────────────────────────────

/**
 * checkAndAdvanceBlitzStatuses(triggeredBy)
 *
 * Idempotent. Safe to call late — catches up any missed windows.
 * Transitions:
 *   draft        → registration  when now >= registration_start
 *   registration → active        when now >= tournament_start
 *   active       → scoring/completed when now >= tournament_end
 */
async function checkAndAdvanceBlitzStatuses(triggeredBy = 'scheduler') {
  const now = new Date().toISOString();

  try {
    // ── draft → registration ─────────────────────────────────────────────
    const { data: draftReady } = await supabase
      .from('blitz_tournaments')
      .select('id, title, registration_start')
      .eq('status', 'draft')
      .lte('registration_start', now);

    for (const t of draftReady || []) {
      const { error } = await supabase
        .from('blitz_tournaments')
        .update({ status: 'registration' })
        .eq('id', t.id)
        .eq('status', 'draft'); // guard against race

      if (!error) {
        console.log(`[blitzScheduler] AUTO: ${t.id} "${t.title}" draft → registration (triggeredBy: ${triggeredBy})`);

        // Notify all players about the new open tournament
        try {
          const { data: allPlayers } = await supabase.from('players').select('id');
          if (allPlayers && allPlayers.length > 0) {
            await createNotifications(allPlayers.map(p => ({
              player_id: p.id,
              type: 'new_event',
              title: 'New Blitz Tournament! ⚡',
              message: `${t.title} — Registration is now open`,
            })));
          }
        } catch (notifErr) {
          console.error(`[blitzScheduler] Notification error for ${t.id}:`, notifErr.message);
        }
      }
    }

    // ── registration → active ────────────────────────────────────────────
    const { data: activationReady } = await supabase
      .from('blitz_tournaments')
      .select('id, title, tournament_start')
      .eq('status', 'registration')
      .lte('tournament_start', now);

    for (const t of activationReady || []) {
      const { error } = await supabase
        .from('blitz_tournaments')
        .update({ status: 'active' })
        .eq('id', t.id)
        .eq('status', 'registration'); // guard against race

      if (!error) {
        console.log(`[blitzScheduler] AUTO: ${t.id} "${t.title}" registration → active (triggeredBy: ${triggeredBy})`);
      }
    }

    // ── active → scoring/completed ───────────────────────────────────────
    const { data: scoringReady } = await supabase
      .from('blitz_tournaments')
      .select('id, title, tournament_end')
      .eq('status', 'active')
      .lte('tournament_end', now);

    for (const t of scoringReady || []) {
      try {
        const summary = await scoreAndCompleteTournament(t.id, triggeredBy);
        console.log(`[blitzScheduler] AUTO scored ${t.id} "${t.title}": ${JSON.stringify(summary)}`);
      } catch (scoreErr) {
        // Don't let one failing tournament break the whole check
        console.error(`[blitzScheduler] Failed to auto-score ${t.id} "${t.title}":`, scoreErr.message);
      }
    }

  } catch (err) {
    // Top-level catch — never let the scheduler crash the server
    console.error('[blitzScheduler] checkAndAdvanceBlitzStatuses error:', err.message);
  }
}

module.exports = { checkAndAdvanceBlitzStatuses, scoreAndCompleteTournament };
