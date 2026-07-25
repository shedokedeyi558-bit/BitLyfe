const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://fgwqzhhhcyqfpvlquyxc.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZnd3F6aGhoY3lxZnB2bHF1eXhjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjkyMDQwOSwiZXhwIjoyMDk4NDk2NDA5fQ.DBdul1yvVBEYeYRdIT87V89vLE2xOMxivoZiQmK_SMk'
);

async function deepAnalysis() {
  console.log('='.repeat(100));
  console.log('DEEP PILL ANALYSIS: Locked State Investigation');
  console.log('='.repeat(100));
  console.log();

  try {
    // Query 1: Get ALL columns for the problematic pill plays
    console.log('QUERY 1: All columns for "What is my name" pill plays (raw select)');
    console.log('-'.repeat(100));
    
    const { data: allCols, error: allColsErr } = await supabase
      .from('pill_plays')
      .select('*')
      .eq('pill_id', '7ec486af-3df2-4d33-a1eb-31c30de20f14')
      .order('created_at', { ascending: false });

    if (allColsErr) {
      console.error('ERROR:', allColsErr);
    } else {
      console.log(`Found ${allCols.length} rows:`);
      console.log(JSON.stringify(allCols, null, 2));
    }
    console.log();

    // Query 2: Specifically check locked_at values
    console.log('QUERY 2: Checking locked_at and submitted_answer explicitly');
    console.log('-'.repeat(100));
    
    const { data: lockData, error: lockErr } = await supabase
      .from('pill_plays')
      .select('id, pill_id, player_id, won, locked_at, submitted_answer, created_at')
      .eq('pill_id', '7ec486af-3df2-4d33-a1eb-31c30de20f14');

    if (lockErr) {
      console.error('ERROR:', lockErr);
    } else {
      console.log('Explicit lock columns query:');
      lockData.forEach((row, i) => {
        console.log(`\n  Row ${i + 1}:`);
        console.log(`    id: ${row.id}`);
        console.log(`    player_id: ${row.player_id}`);
        console.log(`    won: ${row.won}`);
        console.log(`    locked_at: ${row.locked_at || '(NULL)'}`);
        console.log(`    submitted_answer: ${row.submitted_answer || '(NULL)'}`);
        console.log(`    created_at: ${row.created_at}`);
      });
    }
    console.log();

    // Query 3: Check ALL pill_plays to see which ones have locked_at set
    console.log('QUERY 3: All pill_plays with non-NULL locked_at (showing lock usage)');
    console.log('-'.repeat(100));
    
    const { data: lockedPlays, error: lockedErr } = await supabase
      .from('pill_plays')
      .select('id, pill_id, player_id, won, locked_at, submitted_answer, created_at, pills(question)')
      .not('locked_at', 'is', null)
      .order('locked_at', { ascending: false })
      .limit(20);

    if (lockedErr) {
      console.error('ERROR:', lockedErr);
    } else {
      console.log(`Found ${lockedPlays.length} pill_plays with locked_at set:`);
      console.log(JSON.stringify(lockedPlays, null, 2));
    }
    console.log();

    // Query 4: Check player info
    console.log('QUERY 4: Player information for both players');
    console.log('-'.repeat(100));
    
    const playerIds = [
      '87b31941-32d5-450c-9c87-79d8855e533c', // Player 1 (recent attempt)
      'ce4c3e13-7330-4175-b565-33eb22ab8db1'  // Player 2 (won)
    ];

    for (const playerId of playerIds) {
      const { data: player, error: playerErr } = await supabase
        .from('players')
        .select('id, name, email, balance, games_played, games_won, created_at')
        .eq('id', playerId)
        .single();

      if (playerErr) {
        console.error(`ERROR fetching player ${playerId}:`, playerErr);
      } else {
        console.log(`\nPlayer: ${playerId}`);
        console.log(JSON.stringify(player, null, 2));
      }
    }
    console.log();

    // Query 5: Check if there are any other pill_plays for either player with this pill
    console.log('QUERY 5: Transaction history for both players (to see if multiple submissions happened)');
    console.log('-'.repeat(100));
    
    for (const playerId of playerIds) {
      const { data: trans, error: transErr } = await supabase
        .from('transactions')
        .select('id, type, amount, description, created_at')
        .eq('player_id', playerId)
        .eq('type', 'pill_win')
        .order('created_at', { ascending: false })
        .limit(10);

      if (transErr) {
        console.error(`ERROR fetching transactions for ${playerId}:`, transErr);
      } else {
        console.log(`\nPlayer ${playerId} - Recent pill wins:`);
        if (trans.length === 0) {
          console.log('  (No pill wins)');
        } else {
          console.log(JSON.stringify(trans, null, 2));
        }
      }
    }
    console.log();

    console.log('='.repeat(100));
    console.log('ANALYSIS COMPLETE');
    console.log('='.repeat(100));

  } catch (error) {
    console.error('Unexpected error:', error);
  }
}

deepAnalysis();
