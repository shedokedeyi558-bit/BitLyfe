#!/usr/bin/env node
/**
 * Database-Only Test: Check if welcome notifications are being created
 * 
 * This script:
 * 1. Finds recent players (last 10)
 * 2. For each player, checks if they have a welcome notification
 * 3. Reports the results
 * 4. Helps identify if welcome notifications are being created at all
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://fgwqzhhhcyqfpvlquyxc.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZnd3F6aGhoY3lxZnB2bHV5eGMiLCJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0IjoxNzgyOTIwNDA5LCJleHAiOjIwOTg0OTY0MDl9.DBdul1yvVBEYeYRdIT87V89vLE2xOMxivoZiQmK_SMk';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function runTest() {
  try {
    console.log('🔍 Checking Welcome Notifications in Database\n');

    // Get recent players
    console.log('📌 Step 1: Fetching 10 most recent players');
    console.log('-'.repeat(70));
    
    const { data: recentPlayers, error: playersError } = await supabase
      .from('players')
      .select('id, phone, name, created_at')
      .order('created_at', { ascending: false })
      .limit(10);

    if (playersError) {
      throw new Error(`Failed to fetch players: ${playersError.message}`);
    }

    console.log(`Found ${recentPlayers.length} recent players:\n`);

    // For each player, check for welcome notifications
    console.log('📌 Step 2: Checking for welcome notifications');
    console.log('-'.repeat(70));

    let welcmeNotificationCount = 0;
    let totalNotificationCount = 0;
    const results = [];

    for (const player of recentPlayers) {
      const { data: notifications, error: notifError } = await supabase
        .from('notifications')
        .select('id, type, title, created_at')
        .eq('player_id', player.id);

      if (notifError) {
        console.error(`  Error fetching notifications for ${player.phone}: ${notifError.message}`);
        continue;
      }

      const welcomeNotif = notifications.find(n => n.type === 'announcement' && n.title.includes('Welcome'));
      const hasWelcomeNotif = !!welcomeNotif;

      if (hasWelcomeNotif) welcmeNotificationCount++;
      totalNotificationCount += notifications.length;

      results.push({
        phone: player.phone,
        name: player.name,
        playerId: player.id,
        createdAt: player.created_at,
        notificationCount: notifications.length,
        hasWelcomeNotif: hasWelcomeNotif,
        welcomeNotifCreatedAt: welcomeNotif?.created_at || null,
      });

      // Print summary for this player
      const status = hasWelcomeNotif ? '✅' : '❌';
      console.log(`${status} ${player.phone} (${player.name})`);
      console.log(`   Created: ${new Date(player.created_at).toISOString()}`);
      console.log(`   Notifications: ${notifications.length} total ${hasWelcomeNotif ? ', including welcome' : ''}`);
      if (welcomeNotif) {
        console.log(`   Welcome created: ${new Date(welcomeNotif.created_at).toISOString()}`);
      }
      console.log();
    }

    // Summary
    console.log('\n📊 Summary:');
    console.log('-'.repeat(70));
    console.log(`Total players checked: ${recentPlayers.length}`);
    console.log(`Players with welcome notifications: ${welcmeNotificationCount}/${recentPlayers.length}`);
    console.log(`Total notifications found: ${totalNotificationCount}`);
    console.log(`Average notifications per player: ${(totalNotificationCount / recentPlayers.length).toFixed(2)}\n`);

    if (welcmeNotificationCount === 0) {
      console.log('❌ WARNING: No welcome notifications found in recent players!');
      console.log('   This suggests the welcome notification creation might not be working.\n');
    } else if (welcmeNotificationCount === recentPlayers.length) {
      console.log('✅ All recent players have welcome notifications.');
      console.log('   Welcome notification creation is working as expected.\n');
    } else {
      console.log(`⚠️  Partial: ${welcmeNotificationCount} out of ${recentPlayers.length} players have welcome notifications.`);
      console.log('   Some registrations may not have notifications.\n');
    }

    // Detail table
    console.log('📋 Details:');
    console.log('-'.repeat(70));
    console.log('Phone          | Name                  | Notifications | Welcome?');
    console.log('-'.repeat(70));
    for (const r of results) {
      const phone = r.phone.padEnd(14);
      const name = (r.name || 'N/A').substring(0, 20).padEnd(20);
      const notifCount = String(r.notificationCount).padEnd(13);
      const hasWelcome = r.hasWelcomeNotif ? 'YES' : 'NO';
      console.log(`${phone} | ${name} | ${notifCount} | ${hasWelcome}`);
    }

  } catch (error) {
    console.error(`\n❌ ERROR: ${error.message}\n`);
  }
}

runTest();
