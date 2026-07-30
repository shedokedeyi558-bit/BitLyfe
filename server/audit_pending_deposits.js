#!/usr/bin/env node
/**
 * Audit all deposit_pending rows across every player account.
 * Shows: how old they are, whether a matching real deposit exists,
 * and whether the player's balance reflects the payment or not.
 */
require('dotenv').config();
const supabase = require('./src/db/supabase');

async function run() {
  console.log('═'.repeat(70));
  console.log('DEPOSIT_PENDING AUDIT — ALL PLAYERS');
  console.log('═'.repeat(70));

  const { data: pending, error } = await supabase
    .from('transactions')
    .select('id, player_id, amount, reference, created_at')
    .eq('type', 'deposit_pending')
    .order('created_at', { ascending: false });

  if (error) { console.error('Query error:', error.message); return; }

  console.log(`Total deposit_pending rows: ${(pending || []).length}`);
  console.log();

  for (const row of pending || []) {
    const ageHours = ((Date.now() - new Date(row.created_at)) / 3600000).toFixed(1);

    // Check if a real deposit with same reference exists
    const { data: settled } = await supabase
      .from('transactions')
      .select('id, type, created_at')
      .eq('reference', row.reference)
      .in('type', ['deposit', 'deposit_settled'])
      .maybeSingle();

    // Get player balance
    const { data: player } = await supabase
      .from('players')
      .select('phone, balance, bonus_balance')
      .eq('id', row.player_id)
      .single();

    const status = settled ? 'ALREADY_SETTLED' : 'ABANDONED';

    console.log(`Reference: ${row.reference}`);
    console.log(`  player:   ${row.player_id} (${player?.phone || 'no phone'})`);
    console.log(`  amount:   ₦${row.amount}`);
    console.log(`  age:      ${ageHours}h ago (${row.created_at.substring(0,19)})`);
    console.log(`  balance:  ₦${player?.balance} real | ₦${player?.bonus_balance} bonus`);
    console.log(`  status:   ${status}${settled ? ` — real deposit row exists (${settled.type})` : ' — no matching deposit row found'}`);
    console.log();
  }

  const abandoned = (pending || []).filter(async () => true); // count done below
  console.log('─'.repeat(70));
  console.log('Summary:');
  console.log(`  Total deposit_pending: ${(pending || []).length}`);
}

run().catch(e => { console.error(e.message); process.exit(1); });
