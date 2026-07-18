/**
 * Shared billing helper for all paid-entry endpoints.
 *
 * Draws funds in priority order: bonus_balance first, real balance second.
 * Winnings always credit real balance — this module handles debiting only.
 *
 * Returns { newBalance, newBonusBalance, bonusUsed, realUsed }
 * or throws an error string if insufficient funds.
 */

const supabase = require('../db/supabase');

/**
 * Deduct an entry fee from a player's accounts, bonus first.
 *
 * @param {string} playerId
 * @param {number} entryFee
 * @param {object} txnFields  - { type, description } for the transaction record
 * @returns {{ newBalance, newBonusBalance, bonusUsed, realUsed }}
 */
async function deductEntryFee(playerId, entryFee, txnFields) {
  // Fetch fresh balances — never trust cached player object for money ops
  const { data: player, error } = await supabase
    .from('players')
    .select('balance, bonus_balance')
    .eq('id', playerId)
    .single();

  if (error || !player) throw new Error('Player not found');

  const balance      = Number(player.balance || 0);
  const bonusBalance = Number(player.bonus_balance || 0);
  const total        = balance + bonusBalance;

  if (total < entryFee) {
    throw { insufficientFunds: true, message: 'Insufficient balance' };
  }

  // Draw from bonus first, real balance for the remainder
  const bonusUsed = Math.min(bonusBalance, entryFee);
  const realUsed  = entryFee - bonusUsed;

  const newBonusBalance = bonusBalance - bonusUsed;
  const newBalance      = balance - realUsed;

  // Apply both deductions in one update
  await supabase
    .from('players')
    .update({ balance: newBalance, bonus_balance: newBonusBalance })
    .eq('id', playerId);

  // Record transaction
  await supabase.from('transactions').insert({
    player_id: playerId,
    type: txnFields.type,
    amount: -entryFee,
    description: txnFields.description,
    bonus_used: bonusUsed,   // for reporting — requires bonus_used column (see migration)
  });

  return { newBalance, newBonusBalance, bonusUsed, realUsed };
}

/**
 * Refund an entry fee back to a player's real balance.
 * Used as a compensating transaction when a post-charge write fails.
 *
 * Always refunds to real balance (not bonus) — bonus was drawn first on entry
 * but a partial-bonus refund would require knowing the exact split, which
 * isn't available in the failure path. Refunding to real balance is safe
 * and never leaves the player worse off.
 *
 * @param {string} playerId
 * @param {number} entryFee
 * @param {string} predictionId  - used in the transaction description for traceability
 */
async function refundEntryFee(playerId, entryFee, predictionId) {
  // Fetch fresh balance before crediting
  const { data: player, error } = await supabase
    .from('players')
    .select('balance')
    .eq('id', playerId)
    .single();

  if (error || !player) throw new Error('Player not found during refund');

  const newBalance = Number(player.balance || 0) + entryFee;

  await supabase
    .from('players')
    .update({ balance: newBalance })
    .eq('id', playerId);

  await supabase.from('transactions').insert({
    player_id: playerId,
    type: 'prediction_refund',
    amount: entryFee,
    description: `Auto-refund: participation write failed for prediction ${predictionId}`,
  });
}

module.exports = { deductEntryFee, refundEntryFee };
