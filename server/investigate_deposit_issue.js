/**
 * Investigate missing deposit for player 0704 804 7900
 * Amount: ~₦500
 * Time: ~9:30 PM last night (2026-07-29 21:30)
 */
require('dotenv').config({ path: '.env' });
const supabase = require('./src/db/supabase');

const PLAYER_PHONE = '+2347048047900';  // Normalized format
const APPROX_AMOUNT = 500;
const APPROX_TIME = '2026-07-29T21:30:00';  // 9:30 PM last night

async function main() {
  console.log('=== DEPOSIT INVESTIGATION ===\n');
  console.log(`Player phone: ${PLAYER_PHONE}`);
  console.log(`Expected amount: ~₦${APPROX_AMOUNT}`);
  console.log(`Expected time: ~${APPROX_TIME}\n`);

  // Step 1: Find the player
  console.log('--- Step 1: Find Player ---');
  const { data: player, error: playerErr } = await supabase
    .from('players')
    .select('id, phone, name, email, balance, bonus_balance, created_at')
    .eq('phone', PLAYER_PHONE)
    .maybeSingle();

  if (playerErr) {
    console.log('ERROR querying player:', playerErr.message);
    return;
  }

  if (!player) {
    console.log(`✗ Player with phone ${PLAYER_PHONE} not found`);
    console.log('Trying variations...');
    
    // Try without +234 prefix
    const altPhone = '0' + PLAYER_PHONE.slice(4);  // +2347048047900 → 07048047900
    const { data: altPlayer } = await supabase
      .from('players')
      .select('id, phone, name, email, balance, bonus_balance')
      .eq('phone', altPhone)
      .maybeSingle();

    if (altPlayer) {
      console.log(`✓ Found with alternate format: ${altPhone}`);
      Object.assign(player || {}, altPlayer);
    } else {
      console.log('Player not found with any phone format');
      return;
    }
  }

  console.log(`✓ Player found:`);
  console.log(`  ID: ${player.id}`);
  console.log(`  Name: ${player.name || '(not set)'}`);
  console.log(`  Phone: ${player.phone}`);
  console.log(`  Email: ${player.email || '(not set)'}`);
  console.log(`  Current balance: ₦${player.balance}`);
  console.log(`  Current bonus_balance: ₦${player.bonus_balance || 0}`);
  console.log(`  Account created: ${player.created_at}`);
  console.log();

  // Step 2: Query all transactions around the expected time
  console.log('--- Step 2: All Transactions (last 48 hours) ---');
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  
  const { data: allTxns, error: txnErr } = await supabase
    .from('transactions')
    .select('*')
    .eq('player_id', player.id)
    .gte('created_at', since)
    .order('created_at', { ascending: false });

  if (txnErr) {
    console.log('ERROR querying transactions:', txnErr.message);
    return;
  }

  if (!allTxns || allTxns.length === 0) {
    console.log('✗ No transactions found in last 48 hours');
  } else {
    console.log(`Found ${allTxns.length} transaction(s) in last 48 hours:\n`);
    for (const t of allTxns) {
      console.log(`  ${t.created_at} | Type: ${t.type.padEnd(20)} | Amount: ₦${String(t.amount).padStart(5)} | Ref: ${t.reference || '(none)'}`);
      if (t.description) console.log(`    Description: ${t.description}`);
    }
  }
  console.log();

  // Step 3: Query deposit_pending specifically
  console.log('--- Step 3: Pending Deposit Records ---');
  const { data: pendingTxns } = await supabase
    .from('transactions')
    .select('*')
    .eq('player_id', player.id)
    .eq('type', 'deposit_pending')
    .order('created_at', { ascending: false });

  if (!pendingTxns || pendingTxns.length === 0) {
    console.log('✗ No deposit_pending records found');
  } else {
    console.log(`Found ${pendingTxns.length} pending deposit(s):\n`);
    for (const t of pendingTxns) {
      console.log(`  ${t.created_at} | Amount: ₦${t.amount} | Reference: ${t.reference}`);
      console.log(`    Description: ${t.description}`);
    }
  }
  console.log();

  // Step 4: Query deposit records (successful)
  console.log('--- Step 4: Successful Deposit Records ---');
  const { data: successTxns } = await supabase
    .from('transactions')
    .select('*')
    .eq('player_id', player.id)
    .in('type', ['deposit', 'deposit_settled'])
    .order('created_at', { ascending: false })
    .limit(10);

  if (!successTxns || successTxns.length === 0) {
    console.log('✗ No successful deposit records found (ever)');
  } else {
    console.log(`Found ${successTxns.length} successful deposit(s) (showing last 10):\n`);
    for (const t of successTxns) {
      console.log(`  ${t.created_at} | Amount: ₦${t.amount} | Reference: ${t.reference}`);
    }
  }
  console.log();

  // Step 5: Query webhook_logs for any charge_successful events
  console.log('--- Step 5: Squad Webhook Logs (last 48 hours) ---');
  const { data: webhooks } = await supabase
    .from('webhook_logs')
    .select('*')
    .eq('event_type', 'charge_successful')
    .gte('created_at', since)
    .order('created_at', { ascending: false });

  if (!webhooks || webhooks.length === 0) {
    console.log('✗ No charge_successful webhook events in last 48 hours');
  } else {
    console.log(`Found ${webhooks.length} charge_successful webhook(s):\n`);
    for (const w of webhooks) {
      const data = w.payload?.data || {};
      console.log(`  ${w.created_at} | Status: ${w.status || 'received'} | Ref: ${data.transaction_ref || 'N/A'}`);
      console.log(`    Amount: ₦${Math.floor((data.amount || 0) / 100)} | Status: ${data.transaction_status}`);
      
      // Check if this reference matches any of the player's pending deposits
      if (data.transaction_ref && pendingTxns) {
        const matchingPending = pendingTxns.find(t => t.reference === data.transaction_ref);
        if (matchingPending) {
          console.log(`    ⚠️  MATCHES pending deposit for this player!`);
        }
      }
    }
  }
  console.log();

  // Step 6: Analyze for ~₦500 around 9:30 PM
  console.log('--- Step 6: Analysis ---');
  const targetAmount = APPROX_AMOUNT;
  const targetTime = new Date(APPROX_TIME);
  const timeWindow = 2 * 60 * 60 * 1000; // ±2 hours

  const suspectTxns = (allTxns || []).filter(t => {
    const txTime = new Date(t.created_at);
    const timeDiff = Math.abs(txTime - targetTime);
    const amountMatch = Math.abs(t.amount - targetAmount) <= 50; // ±₦50
    return timeDiff <= timeWindow && amountMatch;
  });

  if (suspectTxns.length === 0) {
    console.log(`✗ No transactions found matching ₦${targetAmount} ±₦50 around ${APPROX_TIME} ±2h`);
  } else {
    console.log(`Found ${suspectTxns.length} transaction(s) matching criteria:\n`);
    for (const t of suspectTxns) {
      console.log(`  ${t.created_at} | Type: ${t.type} | Amount: ₦${t.amount} | Ref: ${t.reference || 'N/A'}`);
      console.log(`    Description: ${t.description}`);
    }
  }
  console.log();

  // Step 7: Recommendations
  console.log('--- Step 7: Diagnostic Summary ---\n');
  
  const hasPending = (pendingTxns || []).length > 0;
  const hasSuccessful = (successTxns || []).length > 0;
  const hasMatchingWebhook = (webhooks || []).filter(w => {
    const ref = w.payload?.data?.transaction_ref;
    return ref && (pendingTxns || []).some(t => t.reference === ref);
  }).length > 0;

  console.log('Current state:');
  console.log(`  Player balance: ₦${player.balance}`);
  console.log(`  Pending deposits: ${hasPending ? 'YES' : 'NO'}`);
  console.log(`  Successful deposits (ever): ${hasSuccessful ? 'YES' : 'NO'}`);
  console.log(`  Matching webhook received: ${hasMatchingWebhook ? 'YES' : 'NO'}`);
  console.log();

  if (hasPending && hasMatchingWebhook) {
    console.log('⚠️  ISSUE FOUND: Pending deposit exists AND matching webhook received, but balance not credited');
    console.log('Root cause: Webhook processing may have failed');
    console.log('Next step: Check webhook_logs.status and server logs for errors');
  } else if (hasPending && !hasMatchingWebhook) {
    console.log('⚠️  ISSUE: Pending deposit exists but no webhook received');
    console.log('Root cause: Either payment not completed on Squad side, or webhook not sent/received');
    console.log('Next step: Check Squad dashboard for transaction status');
  } else if (!hasPending && !hasSuccessful) {
    console.log('✓ No deposit attempts found in database');
    console.log('Possible causes:');
    console.log('  1. Player initiated payment but it failed before reaching our server');
    console.log('  2. Player saw frontend "success" popup but payment actually failed');
    console.log('  3. Wrong player phone number provided');
  }

  console.log('\n=== END INVESTIGATION ===');
}

main().catch(console.error);
