/**
 * Check the THIRD affected player
 * Reference: dep_9dbbf70d-b6fb-44b5-aaa5-c0493c517bb4
 * Amount: ₦200
 */
require('dotenv').config({ path: '.env' });
const supabase = require('./src/db/supabase');

const REFERENCE = 'dep_9dbbf70d-b6fb-44b5-aaa5-c0493c517bb4';
const AMOUNT = 200;

async function main() {
  console.log('=== CHECKING THIRD AFFECTED PLAYER ===\n');
  console.log(`Reference: ${REFERENCE}`);
  console.log(`Amount: ₦${AMOUNT}\n`);

  try {
    // Find by reference
    console.log('Step 1: Looking up deposit by reference...');
    const { data: deposits } = await supabase
      .from('transactions')
      .select('*')
      .eq('reference', REFERENCE)
      .order('created_at', { ascending: false });

    if (!deposits || deposits.length === 0) {
      console.log(`✗ No transactions found with reference ${REFERENCE}`);
      return;
    }

    console.log(`Found ${deposits.length} transaction(s):\n`);
    const deposit = deposits[0];
    
    console.log(`Type: ${deposit.type}`);
    console.log(`Player: ${deposit.player_id}`);
    console.log(`Amount: ₦${deposit.amount}`);
    console.log(`Created: ${deposit.created_at}\n`);

    // Get player details
    console.log('Step 2: Fetching player details...');
    const { data: player } = await supabase
      .from('players')
      .select('id, email, phone, balance, bonus_balance')
      .eq('id', deposit.player_id)
      .single();

    if (!player) {
      console.log(`ERROR: Player ${deposit.player_id} not found`);
      return;
    }

    console.log(`✓ Player found:`);
    console.log(`  ID: ${player.id}`);
    console.log(`  Email: ${player.email || '(not set)'}`);
    console.log(`  Phone: ${player.phone || '(not set)'}`);
    console.log(`  Balance: ₦${player.balance}`);
    console.log(`  Bonus Balance: ₦${player.bonus_balance || 0}\n`);

    if (deposit.type === 'deposit_pending') {
      console.log(`⚠️  This is a PENDING deposit (never completed)`);
      console.log(`    Player is SHORT by ₦${AMOUNT}`);
      console.log(`    Status: NEEDS CREDITING`);
    } else if (deposit.type === 'deposit') {
      console.log(`✓ This is a completed deposit`);
      console.log(`  Already credited to player`);
    }

  } catch (err) {
    console.error('ERROR:', err);
  }
}

main();
