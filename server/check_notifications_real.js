#!/usr/bin/env node
/**
 * Real test using .env credentials
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function main() {
  console.log('📌 Checking Welcome Notifications\n');

  try {
    // Get 10 most recent players
    const { data: players, error: playersErr } = await supabase
      .from('players')
      .select('id, phone, name, created_at')
      .order('created_at', { ascending: false })
      .limit(10);

    if (playersErr) throw new Error(playersErr.message);

    console.log(`Found ${players.length} recent players\n`);

    let withWelcome = 0;

    for (const player of players) {
      const { data: notifs } = await supabase
        .from('notifications')
        .select('type, title, created_at')
        .eq('player_id', player.id);

      const welcome = notifs?.find(n => n.type === 'announcement' && n.title?.includes('Welcome'));
      const status = welcome ? '✅' : '❌';

      if (welcome) withWelcome++;

      console.log(`${status} ${player.phone}`);
      console.log(`   Player ID: ${player.id}`);
      console.log(`   Created: ${new Date(player.created_at).toLocaleString()}`);
      console.log(`   Total notifications: ${notifs?.length || 0}`);
      if (welcome) {
        console.log(`   Welcome created: ${new Date(welcome.created_at).toLocaleString()}`);
      }
      console.log();
    }

    console.log(`\n📊 Result: ${withWelcome}/${players.length} players have welcome notifications`);

    if (withWelcome === 0) {
      console.log('❌ NO welcome notifications found!');
    } else if (withWelcome === players.length) {
      console.log('✅ All players have welcome notifications');
    } else {
      console.log(`⚠️  Partial (${withWelcome} have them)`);
    }

  } catch (err) {
    console.error('ERROR:', err.message);
  }
}

main();
