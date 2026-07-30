require('dotenv').config({ path: '.env' });
const supabase = require('./src/db/supabase');

async function main() {
  const PLAYER_ID = 'eb481faa-2325-4c06-9c8c-9fa105454b67';
  const FIRST_REF = 'dep_8c92be6a-ff02-464e-80c6-2673268fae61'; // already processed

  console.log('=== CHECKING SECOND DEPOSIT ===\n');

  // Find all pending deposits for this player
  const { data: deposits } = await supabase
    .from('transactions')
    .select('*')
    .eq('player_id', PLAYER_ID)
    .eq('type', 'deposit_pending')
    .order('created_at', { ascending: false });

  if (!deposits || deposits.length === 0) {
    console.log('✓ No more pending deposits found (first deposit already credited)\n');
    return;
  }

  console.log(`Found ${deposits.length} pending deposit(s):\n`);
  for (const d of deposits) {
    console.log(`Reference: ${d.reference}`);
    console.log(`Amount: ₦${d.amount}`);
    console.log(`Created: ${d.created_at}`);
    console.log(`Description: ${d.description || '(none)'}`);
    console.log();
  }

  if (deposits.length > 0 && deposits[0].reference !== FIRST_REF) {
    console.log(`Second deposit reference: ${deposits[0].reference}`);
    console.log(`\nNeed to check SquadCo dashboard/API for this reference`);
    console.log('Questions:');
    console.log('1. Did SquadCo confirm this payment as successful?');
    console.log('2. If yes, where is the webhook? (no webhook received yet)');
    console.log('3. If no webhook, was payment failed or is it still pending?');
  }
}

main();
