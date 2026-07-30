/**
 * Find second affected player by deposit reference
 */
require('dotenv').config({ path: '.env' });
const supabase = require('./src/db/supabase');

const REFERENCE = 'dep_cf12190a-053b-48a2-a307-ffd4b3fdbf86';
const AMOUNT = 200;

async function main() {
  console.log('=== FINDING SECOND PLAYER BY REFERENCE ===\n');
  console.log(`Reference: ${REFERENCE}`);
  console.log(`Expected amount: ₦${AMOUNT}\n`);

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
      console.log('\nSearching for similar references (partial match)...');
      
      const { data: similar } = await supabase
        .from('transactions')
        .select('reference, player_id, type, amount, created_at')
        .ilike('reference', '%cf12190a%')
        .limit(5);
      
      if (similar && similar.length > 0) {
        console.log(`Found ${similar.length} similar reference(s):`);
        for (const t of similar) {
          console.log(`  ${t.reference} | Player: ${t.player_id} | Type: ${t.type} | Amount: ₦${t.amount}`);
        }
      }
      return;
    }

    console.log(`Found ${deposits.length} transaction(s) with this reference:\n`);
    let playerId = null;

    for (const d of deposits) {
      console.log(`Type: ${d.type}`);
      console.log(`Player: ${d.player_id}`);
      console.log(`Amount: ₦${d.amount}`);
      console.log(`Created: ${d.created_at}`);
      console.log(`Description: ${d.description || '(none)'}\n`);
      
      if (!playerId) playerId = d.player_id;
    }

    if (!playerId) {
      console.log('ERROR: No player ID found');
      return;
    }

    // Get player details
    console.log('Step 2: Fetching player details...');
    const { data: player } = await supabase
      .from('players')
      .select('id, email, phone, balance, bonus_balance')
      .eq('id', playerId)
      .single();

    if (!player) {
      console.log(`ERROR: Player ${playerId} not found`);
      return;
    }

    console.log(`✓ Player found:`);
    console.log(`  ID: ${player.id}`);
    console.log(`  Email: ${player.email || '(not set)'}`);
    console.log(`  Phone: ${player.phone || '(not set)'}`);
    console.log(`  Balance: ₦${player.balance}`);
    console.log(`  Bonus Balance: ₦${player.bonus_balance || 0}`);
    console.log(`\n✓ SHORT BY ₦${AMOUNT}? ${player.balance % 100 === (AMOUNT * -1) % 100 ? 'LIKELY' : 'CHECK MANUALLY'}`);

  } catch (err) {
    console.error('ERROR:', err);
  }
}

main();
