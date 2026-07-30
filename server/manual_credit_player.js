/**
 * APPROVED MANUAL CREDIT
 * Player: eb481faa-2325-4c06-9c8c-9fa105454b67
 * Amount: ₦500
 * Reference: dep_8c92be6a-ff02-464e-80c6-2673268fae61
 * Reason: Webhook payload parsing bug — confirmed paid via SquadCo, never credited
 * 
 * This script:
 * 1. Credits balance by ₦500
 * 2. Creates audit transaction (new type: manual_credit)
 * 3. Converts deposit_pending to deposit
 * 4. Logs event with full reference chain
 */
require('dotenv').config({ path: '.env' });
const supabase = require('./src/db/supabase');

const PLAYER_ID = 'eb481faa-2325-4c06-9c8c-9fa105454b67';
const AMOUNT = 500;
const REFERENCE = 'dep_8c92be6a-ff02-464e-80c6-2673268fae61';
const SQUAD_WEBHOOK_ID = 'webhook_2026-07-29T20:24:34.123655Z'; // timestamp from logs
const REASON = 'Manual credit: SquadCo webhook parsing bug. Payment confirmed at SquadCo (transaction_status: Success) but never credited to wallet due to event.data vs event.Body field name mismatch in webhook handler.';

async function main() {
  console.log('=== MANUAL CREDIT TRANSACTION ===\n');
  console.log(`Player: ${PLAYER_ID}`);
  console.log(`Amount: ₦${AMOUNT}`);
  console.log(`Reference: ${REFERENCE}`);
  console.log(`Squad Webhook: ${SQUAD_WEBHOOK_ID}\n`);

  try {
    // Step 1: Fetch current player state
    console.log('Step 1: Fetching current player state...');
    const { data: player, error: playerErr } = await supabase
      .from('players')
      .select('id, balance, email, phone')
      .eq('id', PLAYER_ID)
      .single();

    if (playerErr || !player) {
      console.error('ERROR: Player not found:', playerErr?.message);
      return;
    }

    console.log(`✓ Player found: balance=₦${player.balance}, email=${player.email || '(none)'}, phone=${player.phone}`);
    console.log();

    // Step 2: Verify deposit_pending exists
    console.log('Step 2: Verifying deposit_pending transaction exists...');
    const { data: pendingTxn, error: pendingErr } = await supabase
      .from('transactions')
      .select('*')
      .eq('reference', REFERENCE)
      .eq('type', 'deposit_pending')
      .single();

    if (pendingErr || !pendingTxn) {
      console.error('ERROR: deposit_pending not found:', pendingErr?.message);
      return;
    }

    console.log(`✓ Found deposit_pending:`);
    console.log(`  ID: ${pendingTxn.id}`);
    console.log(`  Amount: ₦${pendingTxn.amount}`);
    console.log(`  Created: ${pendingTxn.created_at}`);
    console.log();

    // Step 3: Check for existing deposit (idempotency)
    console.log('Step 3: Checking for existing completed deposit (idempotency)...');
    const { data: existingDeposit } = await supabase
      .from('transactions')
      .select('*')
      .eq('reference', REFERENCE)
      .eq('type', 'deposit')
      .maybeSingle();

    if (existingDeposit) {
      console.warn('⚠️  WARNING: Deposit already exists for this reference');
      console.log(`  ID: ${existingDeposit.id}`);
      console.log(`  Created: ${existingDeposit.created_at}`);
      console.log('  Skipping credit to avoid double-credit.\n');
      return;
    }

    console.log('✓ No existing deposit — safe to credit\n');

    // Step 4: Credit balance
    console.log('Step 4: Crediting balance...');
    const newBalance = (player.balance || 0) + AMOUNT;
    const { error: balanceErr } = await supabase
      .from('players')
      .update({ balance: newBalance })
      .eq('id', PLAYER_ID);

    if (balanceErr) {
      console.error('ERROR updating balance:', balanceErr.message);
      return;
    }

    console.log(`✓ Balance updated: ₦${player.balance} → ₦${newBalance}`);
    console.log();

    // Step 5: Create audit transaction (manual_credit type)
    console.log('Step 5: Creating audit transaction record...');
    const { error: auditErr } = await supabase
      .from('transactions')
      .insert({
        player_id: PLAYER_ID,
        type: 'manual_credit',
        amount: AMOUNT,
        description: `Manual credit via admin: ${REASON}`,
        reference: `${REFERENCE}_manual_audit`,
      });

    if (auditErr) {
      console.error('ERROR creating audit transaction:', auditErr.message);
      return;
    }

    console.log('✓ Audit transaction created\n');

    // Step 6: Delete deposit_pending (no longer needed — replaced by deposit below)
    console.log('Step 6: Deleting deposit_pending row...');
    const { error: delErr } = await supabase
      .from('transactions')
      .delete()
      .eq('reference', REFERENCE)
      .eq('type', 'deposit_pending');

    if (delErr) {
      console.error('ERROR deleting deposit_pending:', delErr.message);
      return;
    }

    console.log('✓ Deleted deposit_pending\n');

    // Step 7: Create final deposit record (settled state)
    console.log('Step 7: Creating final deposit transaction record...');
    const { error: depositErr } = await supabase
      .from('transactions')
      .insert({
        player_id: PLAYER_ID,
        type: 'deposit',
        amount: AMOUNT,
        description: `Deposit of ₦${AMOUNT} (manually credited — SquadCo webhook bug; confirmed successful at SquadCo, reference: ${SQUAD_WEBHOOK_ID})`,
        reference: REFERENCE,
      });

    if (depositErr) {
      console.error('ERROR creating deposit record:', depositErr.message);
      return;
    }

    console.log('✓ Deposit transaction record created\n');

    // Step 8: Verify final state
    console.log('Step 8: Verifying final state...');
    const { data: finalPlayer } = await supabase
      .from('players')
      .select('balance')
      .eq('id', PLAYER_ID)
      .single();

    const { data: finalTxns } = await supabase
      .from('transactions')
      .select('*')
      .eq('reference', REFERENCE)
      .order('created_at', { ascending: false })
      .limit(5);

    console.log(`✓ Final player balance: ₦${finalPlayer?.balance}`);
    console.log(`✓ Transaction records for reference ${REFERENCE}:`);
    for (const t of (finalTxns || [])) {
      console.log(`  ${t.created_at} | ${t.type.padEnd(15)} | ₦${String(t.amount).padStart(5)} | ${t.description.substring(0, 50)}...`);
    }

    console.log('\n=== MANUAL CREDIT COMPLETE ===');
    console.log(`✓ Player ${PLAYER_ID} credited ₦${AMOUNT}`);
    console.log(`✓ Audit trail established with reference ${REFERENCE}`);
    console.log(`✓ Webhook ID: ${SQUAD_WEBHOOK_ID}`);

  } catch (err) {
    console.error('CRITICAL ERROR:', err);
  }
}

main();
