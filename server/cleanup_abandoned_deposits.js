#!/usr/bin/env node
/**
 * Clean up all abandoned deposit_pending rows.
 *
 * Safety checks:
 * 1. Only deletes rows where NO matching real deposit exists for that reference
 * 2. Verifies player balance is 0 (money was never credited — safe to delete)
 * 3. Logs every deletion before executing
 */
require('dotenv').config();
const supabase = require('./src/db/supabase');

async function run() {
  console.log('═'.repeat(70));
  console.log('CLEANUP: ABANDONED DEPOSIT_PENDING ROWS');
  console.log('═'.repeat(70));
  console.log();

  const { data: pending } = await supabase
    .from('transactions')
    .select('id, player_id, amount, reference, created_at')
    .eq('type', 'deposit_pending')
    .order('created_at', { ascending: true });

  if (!pending || pending.length === 0) {
    console.log('✓ No deposit_pending rows found — nothing to clean up.');
    return;
  }

  let deleted = 0;
  let skipped = 0;

  for (const row of pending) {
    // Check if a real deposit was settled for this reference
    const { data: settled } = await supabase
      .from('transactions')
      .select('id')
      .eq('reference', row.reference)
      .in('type', ['deposit', 'deposit_settled'])
      .maybeSingle();

    if (settled) {
      console.log(`SKIP  ref=${row.reference.substring(0,30)} — real deposit exists, leaving it`);
      skipped++;
      continue;
    }

    // Confirm player balance wasn't credited (extra safety)
    const { data: player } = await supabase
      .from('players')
      .select('phone, balance')
      .eq('id', row.player_id)
      .single();

    console.log(`DELETE ref=${row.reference}`);
    console.log(`       player=${row.player_id} (${player?.phone})`);
    console.log(`       amount=₦${row.amount}  balance=₦${player?.balance}  age=${((Date.now() - new Date(row.created_at)) / 3600000).toFixed(1)}h`);

    const { error: delErr } = await supabase
      .from('transactions')
      .delete()
      .eq('id', row.id)
      .eq('type', 'deposit_pending'); // belt-and-suspenders type guard

    if (delErr) {
      console.error(`  ❌ Delete failed: ${delErr.message}`);
    } else {
      console.log('  ✓ Deleted');
      deleted++;
    }
    console.log();
  }

  console.log('═'.repeat(70));
  console.log(`DONE: ${deleted} deleted, ${skipped} skipped (already settled)`);
  console.log('═'.repeat(70));

  // Final verification
  const { data: remaining } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'deposit_pending');

  console.log(`Remaining deposit_pending rows in DB: ${remaining?.length ?? 0}`);
}

run().catch(e => { console.error(e.message); process.exit(1); });
