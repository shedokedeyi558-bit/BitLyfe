/**
 * adminChallengeScheduler.js
 *
 * Sweeps pending admin_challenge_requests that have passed expires_at,
 * marks them expired, and refunds the stake.
 * Same self-healing pattern as specialsScheduler.js.
 * Called every ~15s from index.js.
 */

const supabase = require('../db/supabase');

async function expireStaleRequests() {
  try {
    const now = new Date().toISOString();

    // Find all pending requests past their expiry
    const { data: stale, error } = await supabase
      .from('admin_challenge_requests')
      .select('id, player_id, stake')
      .eq('status', 'pending')
      .lte('expires_at', now);

    if (error) {
      console.error('[adminChallengeScheduler] fetch error:', error.message);
      return;
    }

    if (!stale || stale.length === 0) return;

    for (const req of stale) {
      try {
        // Atomic guard: only mark expired if still pending
        const { error: updateErr } = await supabase
          .from('admin_challenge_requests')
          .update({ status: 'expired' })
          .eq('id', req.id)
          .eq('status', 'pending');

        if (updateErr) {
          console.error(`[adminChallengeScheduler] failed to expire request ${req.id}:`, updateErr.message);
          continue;
        }

        // Refund stake to real balance
        const { data: player } = await supabase
          .from('players')
          .select('balance')
          .eq('id', req.player_id)
          .single();

        if (!player) {
          console.error(`[adminChallengeScheduler] player ${req.player_id} not found for refund`);
          continue;
        }

        await supabase
          .from('players')
          .update({ balance: Number(player.balance || 0) + req.stake })
          .eq('id', req.player_id);

        await supabase.from('transactions').insert({
          player_id: req.player_id,
          type: 'admin_challenge_refund',
          amount: req.stake,
          description: 'Beat the Admin — request expired, stake refunded',
        });

        console.log(`[adminChallengeScheduler] expired request ${req.id}, refunded ₦${req.stake} to ${req.player_id}`);
      } catch (reqErr) {
        console.error(`[adminChallengeScheduler] error processing request ${req.id}:`, reqErr.message);
      }
    }
  } catch (err) {
    // Top-level catch — never crash the process
    console.error('[adminChallengeScheduler] expireStaleRequests error:', err.message);
  }
}

module.exports = { expireStaleRequests };
