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

module.exports = { deductEntryFee };
