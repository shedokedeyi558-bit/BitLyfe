/**
 * specialsScheduler.js
 *
 * Background catch-up job for timed-out special_attempts rows.
 * Same self-healing pattern as blitzScheduler.js.
 *
 * Finds attempts where:
 *   status = 'in_progress'
 *   AND (started_at + total_time_seconds) < now   ← exam timer expired
 *
 * For each: grades whatever answers were submitted, sets correct_count,
 * status (passed/failed), completed_at. Credits prize if passed.
 *
 * Safe to call repeatedly — only processes genuinely expired attempts.
 * Never touches attempts that still have time remaining.
 */

const supabase = require('../db/supabase');
const { checkAnswer } = require('../services/gameLogic');

/**
 * Grade a set of submitted answers against their pills.
 * Returns { correct_count }
 */
async function gradeAttempt(questionIds, answers) {
  if (!questionIds || questionIds.length === 0) return { correct_count: 0 };

  // Fetch pills one by one — .in() on UUID arrays can silently return empty in Supabase JS SDK
  const pills = (
    await Promise.all(
      questionIds.map((id) =>
        supabase
          .from('pills')
          .select('id, format, options, correct_answer, case_sensitive, spelling_tolerance')
          .eq('id', id)
          .single()
          .then(({ data }) => data)
      )
    )
  ).filter(Boolean);

  let correct_count = 0;
  for (let i = 0; i < pills.length; i++) {
    const submitted = (answers || [])[i];
    if (submitted !== null && submitted !== undefined && submitted !== '') {
      if (checkAnswer(pills[i], String(submitted))) correct_count++;
    }
  }
  return { correct_count };
}

/**
 * Credit prize to a player's balance and record a specials_win transaction.
 * Re-fetches balance to avoid stale-cache race.
 */
async function creditPrize(playerId, prize, packName) {
  const { data: fresh } = await supabase
    .from('players')
    .select('balance')
    .eq('id', playerId)
    .single();

  if (!fresh) throw new Error(`creditPrize: player ${playerId} not found`);

  await supabase
    .from('players')
    .update({ balance: Number(fresh.balance || 0) + prize })
    .eq('id', playerId);

  await supabase.from('transactions').insert({
    player_id: playerId,
    type: 'specials_win',
    amount: prize,
    description: `Special exam passed: ${packName} (auto-finalized)`,
  });
}

/**
 * finalizeTimedOutAttempts()
 *
 * Idempotent. Safe to call on every relevant request + from a periodic interval.
 * Only touches attempts where the exam timer has genuinely expired.
 */
async function finalizeTimedOutAttempts() {
  try {
    const now = new Date();
    const nowISO = now.toISOString();

    // Fetch all in-progress attempts — we filter by timer expiry in JS because
    // Supabase JS SDK doesn't support computed column filters like
    // (started_at + interval '130 seconds') < now directly.
    // In practice this table is small (one row per player per pack).
    const { data: attempts, error } = await supabase
      .from('special_attempts')
      .select('id, player_id, pack_id, question_ids, answers, started_at, total_time_seconds, correct_count')
      .eq('status', 'in_progress');

    if (error) {
      console.error('[specialsScheduler] fetch error:', error.message);
      return;
    }

    const expired = (attempts || []).filter((a) => {
      if (!a.started_at || !a.total_time_seconds) return false;
      const expiresAt = new Date(a.started_at).getTime() + a.total_time_seconds * 1000;
      return expiresAt <= now.getTime();
    });

    if (expired.length === 0) return;

    // Fetch the packs for prize/pass-threshold data in one batch
    const packIds = [...new Set(expired.map((a) => a.pack_id))];
    const { data: packs } = await supabase
      .from('pill_packs')
      .select('id, name, prize, required_correct, question_count')
      .in('id', packIds);

    const packMap = {};
    for (const p of packs || []) packMap[p.id] = p;

    for (const attempt of expired) {
      try {
        const pack = packMap[attempt.pack_id];
        if (!pack) {
          console.error(`[specialsScheduler] pack ${attempt.pack_id} not found for attempt ${attempt.id}`);
          continue;
        }

        const questionIds = attempt.question_ids || [];
        const answers = attempt.answers || [];

        const { correct_count } = await gradeAttempt(questionIds, answers);

        const required = pack.required_correct || questionIds.length;
        const passed = correct_count >= required;
        const finalStatus = passed ? 'passed' : 'failed';
        const completedAt = nowISO;

        // Mark attempt complete — use .eq('status', 'in_progress') as guard
        // against double-finalization if two scheduler runs overlap
        const { error: updateErr } = await supabase
          .from('special_attempts')
          .update({ status: finalStatus, correct_count, completed_at: completedAt })
          .eq('id', attempt.id)
          .eq('status', 'in_progress'); // guard

        if (updateErr) {
          console.error(`[specialsScheduler] update error for attempt ${attempt.id}:`, updateErr.message);
          continue;
        }

        console.log(
          `[specialsScheduler] finalized attempt ${attempt.id} ` +
          `pack="${pack.name}" player=${attempt.player_id} ` +
          `score=${correct_count}/${questionIds.length} status=${finalStatus}`
        );

        // Credit prize if passed
        if (passed && pack.prize) {
          const prize = parseFloat(pack.prize);
          try {
            await creditPrize(attempt.player_id, prize, pack.name);
            console.log(`[specialsScheduler] prize ₦${prize} credited to ${attempt.player_id}`);
          } catch (prizeErr) {
            // Attempt is already marked passed — log but don't re-throw
            // Admin can manually credit if needed
            console.error(`[specialsScheduler] prize credit failed for ${attempt.id}:`, prizeErr.message);
          }
        }

        // Notify player of result (direct insert — avoids circular require with notifications.js)
        try {
          const title = passed ? 'Special Exam Passed! 🎉' : 'Special Exam Ended';
          const message = passed
            ? `You passed "${pack.name}" with ${correct_count}/${questionIds.length} correct! ₦${parseFloat(pack.prize || 0).toLocaleString()} credited.`
            : `Your attempt on "${pack.name}" has ended. You got ${correct_count}/${questionIds.length} correct.`;
          await supabase.from('notifications').insert({
            player_id: attempt.player_id,
            type: passed ? 'win' : 'loss',
            title,
            message,
          });
        } catch (notifErr) {
          console.error(`[specialsScheduler] notification failed for ${attempt.id}:`, notifErr.message);
        }
      } catch (attemptErr) {
        // Don't let one failed attempt block the rest
        console.error(`[specialsScheduler] error finalizing attempt ${attempt.id}:`, attemptErr.message);
      }
    }
  } catch (err) {
    // Top-level catch — never crash the process
    console.error('[specialsScheduler] finalizeTimedOutAttempts error:', err.message);
  }
}

module.exports = { finalizeTimedOutAttempts };
