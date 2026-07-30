#!/usr/bin/env node
require('dotenv').config();
const supabase = require('./src/db/supabase');

async function run() {
  const phone = '+2347048047900';
  const phone2 = '07048047900';
  const phone3 = '+234704804790';

  // Find player by phone variants
  const { data: players } = await supabase
    .from('players')
    .select('id, name, phone, email, balance, bonus_balance, created_at')
    .or(`phone.eq.${phone},phone.eq.${phone2},phone.like.%7048047900%`);

  console.log('Players found:', JSON.stringify(players, null, 2));

  if (!players || players.length === 0) {
    console.log('No player found — trying broad search');
    const { data: broad } = await supabase
      .from('players')
      .select('id, name, phone, email, balance, bonus_balance, created_at')
      .ilike('phone', '%7048047900%');
    console.log('Broad search:', JSON.stringify(broad, null, 2));
    if (!broad || broad.length === 0) return;
    players.push(...broad);
  }

  for (const p of players) {
    console.log('\n─── Player:', p.id);
    console.log('phone:', p.phone, '| balance:', p.balance, '| bonus:', p.bonus_balance);

    // All transactions
    const { data: txns } = await supabase
      .from('transactions')
      .select('id, type, amount, description, reference, created_at')
      .eq('player_id', p.id)
      .order('created_at', { ascending: false });

    console.log('Transactions:');
    for (const t of txns || []) {
      console.log(`  [${t.created_at}] ${t.type.padEnd(20)} ₦${t.amount} ref=${t.reference}`);
    }
  }
}

run().catch(e => { console.error(e.message); process.exit(1); });
