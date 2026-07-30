#!/usr/bin/env node

/**
 * Deep audit: Investigate the 1.25 play-to-played-pill ratio
 * Find which pill has 2 play entries and why
 */

require('dotenv').config();
const supabase = require('./src/db/supabase');

async function deepAudit() {
  console.log('═'.repeat(80));
  console.log('DEEP PILL AUDIT: Investigating 1.25 Ratio Anomaly');
  console.log('═'.repeat(80));
  console.log('');

  try {
    // Get all play records
    const { data: allPlays, error: playsErr } = await supabase
      .from('pill_plays')
      .select('*');

    if (playsErr) {
      console.error('Error fetching plays:', playsErr);
      return;
    }

    console.log(`Total pill_plays records: ${allPlays.length}`);
    console.log('');

    // Find plays grouped by pill_id
    const byPill = {};
    for (const play of allPlays) {
      if (!byPill[play.pill_id]) byPill[play.pill_id] = [];
      byPill[play.pill_id].push(play);
    }

    // Find pills with multiple plays
    const multiPlays = Object.entries(byPill)
      .filter(([, plays]) => plays.length > 1)
      .map(([pillId, plays]) => ({ pillId, plays, count: plays.length }));

    if (multiPlays.length > 0) {
      console.log(`❌ Found ${multiPlays.length} pill(s) with multiple play records:`);
      console.log('');

      for (const { pillId, plays } of multiPlays) {
        console.log(`PILL ID: ${pillId}`);
        console.log('─'.repeat(80));

        const { data: pill } = await supabase
          .from('pills')
          .select('question, status, pack_id, entry_fee, prize, created_at')
          .eq('id', pillId)
          .single();

        if (pill) {
          console.log(`Question: ${pill.question.substring(0, 60)}...`);
          console.log(`Status: ${pill.status}`);
          console.log(`Pack ID: ${pill.pack_id}`);
          console.log(`Entry Fee: ${pill.entry_fee}, Prize: ${pill.prize}`);
          console.log(`Created: ${pill.created_at}`);
        }

        console.log('');
        console.log('Plays:');
        for (const [i, play] of plays.entries()) {
          console.log(`  [${i+1}] ID: ${play.id}`);
          console.log(`      Player: ${play.player_id}`);
          console.log(`      Won: ${play.won}`);
          console.log(`      Opened: ${play.created_at}`);
          console.log(`      Locked (answered): ${play.locked_at || '(not answered)'}`);
          console.log(`      Answer: ${play.submitted_answer || '(no answer)'}`);
          console.log('');
        }

        // Fetch the player(s) who played this pill
        const playerIds = [...new Set(plays.map(p => p.player_id))];
        for (const playerId of playerIds) {
          const { data: player } = await supabase
            .from('players')
            .select('id, email, name, balance, games_won, created_at')
            .eq('id', playerId)
            .single();

          if (player) {
            console.log(`Player: ${player.email}`);
            console.log(`  Name: ${player.name}`);
            console.log(`  Balance: ₦${player.balance}`);
            console.log(`  Games Won: ${player.games_won}`);
            console.log(`  Account Created: ${player.created_at}`);
          }
        }

        // Check pill pack for 4-pill profile
        if (pill && pill.pack_id) {
          const { data: pack } = await supabase
            .from('pill_packs')
            .select('name, pack_type, status, question_count')
            .eq('id', pill.pack_id)
            .single();

          if (pack) {
            console.log(`Pack: ${pack.name} (Type: ${pack.pack_type})`);
            console.log(`Pack Status: ${pack.status}`);
            console.log(`Pack Question Count: ${pack.question_count}`);

            // Get all pills in this pack
            const { data: packPills } = await supabase
              .from('pills')
              .select('id, status')
              .eq('pack_id', pill.pack_id);

            console.log(`Pills in pack: ${packPills.length}`);
            packPills.forEach(p => {
              console.log(`  - ${p.id.substring(0, 8)}... status=${p.status}`);
            });
          }
        }

        console.log('');
        console.log('═'.repeat(80));
      }
    } else {
      console.log('✓ No pills have multiple play records');
    }

    console.log('');

    // Check for plays where player appears twice for different pills in same pack
    console.log('Checking for same player playing multiple pills in same pack...');
    console.log('─'.repeat(80));

    const byPlayer = {};
    for (const play of allPlays) {
      if (!byPlayer[play.player_id]) byPlayer[play.player_id] = [];
      byPlayer[play.player_id].push(play);
    }

    for (const [playerId, plays] of Object.entries(byPlayer)) {
      if (plays.length > 1) {
        // Get pack info for each
        const pillIds = plays.map(p => p.pill_id);
        const { data: pills } = await supabase
          .from('pills')
          .select('id, pack_id')
          .in('id', pillIds);

        const packMap = {};
        for (const pill of pills) {
          if (!packMap[pill.pack_id]) packMap[pill.pack_id] = [];
          packMap[pill.pack_id].push(pill.id);
        }

        // Find if same player played multiple pills from same pack
        for (const [packId, packPillIds] of Object.entries(packMap)) {
          const playerPlaysInPack = plays.filter(p => packPillIds.includes(p.pill_id));
          if (playerPlaysInPack.length > 1) {
            console.log(`Player ${playerId} played ${playerPlaysInPack.length} pills from pack ${packId}`);
            playerPlaysInPack.forEach(p => {
              console.log(`  - Pill: ${p.pill_id.substring(0, 8)}..., Won: ${p.won}`);
            });
          }
        }
      }
    }

    console.log('');
    console.log('═'.repeat(80));
    console.log('DEEP AUDIT COMPLETE');
    console.log('═'.repeat(80));

  } catch (err) {
    console.error('Error:', err.message);
  }
}

deepAudit();
