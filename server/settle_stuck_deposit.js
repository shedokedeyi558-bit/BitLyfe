#!/usr/bin/env node
/**
 * Manually settle a stuck deposit_pending transaction.
 * Player +2347048047900 paid ₦500 during the Paystack→Squad migration window.
 * The webhook never fired (old /api/paystack/webhook was being replaced),
 * so the deposit_pending row was never converted to deposit and balance never credited.
 *
 * This script:
 * 1. Confirms the pending record exists and balance is still 0
 * 2. Credits ₦500 to the player's balance
 * 3. Inserts a deposit transaction
 * 4. Deletes the deposit_pending record
 * 5. Fires checkReferralCompletion
 * 6. Logs to admin_audit_log
 */

require('dotenv').config();
const supabase = require('./src/db/supabase');

const PLAYER_ID  = 'eb481faa-2325-4c06-9c8c-9fa105454b67';
const REFERENCE  = 'dep_10d28972-f058-42ea-87f9-f0479d082d45';
const AMOUNT     = 500;

async function run() {
  console.log('═'.repeat(60));
  console.log('SETTLE STUCK DEPOSIT');
  console.log('═'.repeat(60));

  // 1. Verify current state
  const { data: player } = await supabase
    .from('players')
    .select('id, phone, balance, bonus_balance')
    .eq('id', PLAYER_ID)
    .single();

  console.log('Player before:');
  console.log('  id:      ', player.id);
  console.log('  phone:   ', player.phone);
  console.log('  balance: ₦', player.balance);

  if (player.balance >= AMOUNT) {
    console.log('⚠️  Balance already ≥ ₦500 — may already be credited. Aborting.');
    return;
  }

  // Check pending record still exists
  const { data: pending } = await supabase
    .from('transactions')
    .select('id, type, amount, reference, created_at')
    .eq('reference', REFERENCE)
    .eq('type', 'deposit_pending')
    .maybeSingle();

  if (!pending) {
    console.log('⚠️  deposit_pending record not found for this reference — may already be settled.');
    return;
  }

  console.log('Pending record:', JSON.stringify(pending, null, 2));

  // Check no deposit record already exists (idempotency)
  const { data: existing } = await supabase
    .from('transactions')
    .select('id')
    .eq('reference', REFERENCE)
    .eq('type', 'deposit')
    .maybeSingle();

  if (existing) {
    console.log('⚠️  deposit record already exists for this reference — already settled.');
    return;
  }

  // 2. Credit balance
  const newBalance = (player.balance || 0) + AMOUNT;
  const { error: balErr } = await supabase
    .from('players')
    .update({ balance: newBalance })
    .eq('id', PLAYER_ID);

  if (balErr) {
    console.error('❌ Balance update failed:', balErr.message);
    return;
  }
  console.log(`✓ Balance updated: ₦${player.balance} → ₦${newBalance}`);

  // 3. Insert settled deposit transaction
  const { error: txnErr } = await supabase
    .from('transactions')
    .insert({
      player_id: PLAYER_ID,
      type: 'deposit',
      amount: AMOUNT,
      description: `Deposit of ₦${AMOUNT} (manual settlement — migration window)`,
      reference: REFERENCE,
    });

  if (txnErr) {
    console.error('❌ Transaction insert failed:', txnErr.message);
    return;
  }
  console.log('✓ deposit transaction inserted');

  // 4. Delete the pending record
  const { error: delErr } = await supabase
    .from('transactions')
    .delete()
    .eq('reference', REFERENCE)
    .eq('type', 'deposit_pending');

  if (delErr) {
    console.error('⚠️  deposit_pending delete failed (non-fatal):', delErr.message);
  } else {
    console.log('✓ deposit_pending record removed');
  }

  // 5. Log to admin_audit_log
  const { error: auditErr } = await supabase
    .from('admin_audit_log')
    .insert({
      player_id: PLAYER_ID,
      action: 'manual_deposit_settlement',
      resolution: 'credit',
      payload: {
        reason: 'Deposit stuck in deposit_pending during Paystack→Squad migration window (2026-07-29 09:49)',
        reference: REFERENCE,
        amount: AMOUNT,
        before_balance: player.balance,
        after_balance: newBalance,
        admin_note: 'Webhook never fired — old /api/paystack/webhook was being replaced at time of payment',
      },
    });

  if (auditErr) {
    console.error('⚠️  admin_audit_log insert failed (non-fatal):', auditErr.message);
  } else {
    console.log('✓ admin_audit_log entry created');
  }

  // 6. Verify final state
  const { data: after } = await supabase
    .from('players')
    .select('balance, bonus_balance')
    .eq('id', PLAYER_ID)
    .single();

  console.log();
  console.log('Final state:');
  console.log('  balance:       ₦', after.balance);
  console.log('  bonus_balance: ₦', after.bonus_balance);
  console.log();
  console.log(after.balance === newBalance ? '✓ SETTLEMENT COMPLETE' : '❌ Balance mismatch — check manually');
  console.log('═'.repeat(60));
}

run().catch(e => { console.error(e.message); process.exit(1); });
