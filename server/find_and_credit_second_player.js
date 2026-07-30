/**
 * Find and credit second affected player
 * Reference: dep_cf12190a-053b-48a2-a307-ffd4b3fdbf86
 * Amount: ₦200
 * Email: player_15f1d00f@bitlyfe.app
 * Status: Confirmed Success on SquadCo dashboard
 */
require('dotenv').config({ path: '.env' });
const supabase = require('./src/db/supabase');

const REFERENCE = 'dep_cf12190a-053b-48a2-a307-ffd4b3fdbf86';
const AMOUNT = 200;
const EMAIL = 'player_15f1d00f@bitlyfe.app';
const ID_PREFIX = '15f1d00f';
const REASON = 'Manual credit: SquadCo webhook parsing bug. Payment confirmed at SquadCo (transaction_status: Success) but never credited to wallet due to event.data vs event.Body field name mismatch in webhook handler.';

async function main() {
  console.log('=== SECOND AFFECTED PLAYER CREDIT ===\n');
  console.log(`Reference: ${REFERENCE}`);
  console.log(`Amount: ₦${AMOUNT}`);
  console.log(`Email: ${EMAIL}`);
  console.log(`ID prefix: ${ID_PREFIX}\n`);

  try {
    // Step 1: Find player by email
    console.log('Step 1: Finding player by email...');
    let { data: player, error: playerErr } = await supabase
      .from('players')
      .select('id, email, balance, bonus_balance, phone')
      .eq('email', EMAIL)
      .maybeSingle();

    if (playerErr) {
      console.error('ERROR querying by email:', playerErr.message);
      return;
    }

    if (!player) {
      console.log(`✗ Player with email ${EMAIL} not found`);
      console.log('Trying to find by ID prefix...');
      
      // Try searching by ID pattern
      const { data: candidates } = await supabase
        .from('players')
        .select('id, email, balance, phone')
        .ilike('id', `${ID_PREFIX}%`)
        .limit(5);

      if (candidates && candidates.length > 0) {
        console.log(`Found ${candidates.length} candidate(s) with ID prefix ${ID_PREFIX}:`);
        for (const c of candidates) {
          console.log(`  ${c.id} | ${c.email || '(no email)'}`);
        }
      }
      return;
    }

    console.log(`✓ Player found:`);
    console.log(`  ID: ${player.id}`);
    console.log(`  Email: ${player.email}`);
    console.log(`  Phone: ${player.phone || '(not set)'}`);
    console.log(`  Balance: ₦${player.balance}`);
    console.log(`  Bonus Balance: ₦${player.bonus_balance || 0}`);
    console.log();

    // Step 2: Verify deposit_pending exists
    console.log('Step 2: Verifying deposit_pending transaction exists...');
    const { data: pendingTxn, error: pendingErr } = await supabase
      .from('transactions')
      .select('*')
      .eq('reference', REFERENCE)
      .eq('type', 'deposit_pending')
      .single();

    if (pendingErr && pendingErr.code !== 'PGRST116') {  // PGRST116 = no rows
      console.error('ERROR querying pending deposit:', pendingErr.message);
      return;
    }

    if (!pendingTxn) {
      console.log(`✗ No deposit_pending found for reference ${REFERENCE}`);
      console.log('Checking all deposit records for this player and reference...');
      
      const { data: allTxns } = await supabase
        .from('transactions')
        .select('*')
        .eq('player_id', player.id)
        .eq('reference', REFERENCE)
        .order('created_at', { ascending: false });

      if (allTxns && allTxns.length > 0) {
        console.log(`Found ${allTxns.length} transaction(s):`);
        for (const t of allTxns) {
          console.log(`  Type: ${t.type}, Amount: ₦${t.amount}, Created: ${t.created_at}`);
        }
      }
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
      .eq('id', player.id);

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
        player_id: player.id,
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

    // Step 6: Delete deposit_pending
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
        player_id: player.id,
        type: 'deposit',
        amount: AMOUNT,
        description: `Deposit of ₦${AMOUNT} (manually credited — SquadCo webhook bug; confirmed successful at SquadCo)`,
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
      .eq('id', player.id)
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

    console.log('\n=== SECOND PLAYER CREDIT COMPLETE ===');
    console.log(`✓ Player ${player.id} credited ₦${AMOUNT}`);
    console.log(`✓ Email: ${player.email}`);
    console.log(`✓ Reference: ${REFERENCE}`);
    console.log(`✓ New balance: ₦${finalPlayer?.balance}`);

  } catch (err) {
    console.error('CRITICAL ERROR:', err);
  }
}

main();
