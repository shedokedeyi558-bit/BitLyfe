#!/usr/bin/env node

/**
 * Analyze the actual issue:
 * Player a7c13796 played 4 pills from pack c0c54868 and won all 4
 * But pill 1bc3f6e7 has TWO play entries:
 *   - One by eb9b5078 (opened but never answered/locked)
 *   - One by a7c13796 (opened, answered "Q", won)
 *
 * The question: How did a7c13796 play pill 1bc3f6e7 after it was marked played?
 */

require('dotenv').config();
const supabase = require('./src/db/supabase');

async function analyzeIssue() {
  console.log('═'.repeat(80));
  console.log('ROOT CAUSE ANALYSIS: Player Won After Pill Marked "Played"');
  console.log('═'.repeat(80));
  console.log('');

  try {
    const PILL_ID = '1bc3f6e7-116d-451d-a53f-7dca3363c408';
    const PACK_ID = 'c0c54868-5a15-4e89-8370-7e8a87dbc3ee';
    const PLAYER_A = 'eb9b5078-f808-4e74-bf48-826791481a5a';  // opened, no answer
    const PLAYER_B = 'a7c13796-abea-47cb-8e57-cebc00da81f8';  // won

    console.log('SCENARIO:');
    console.log(`Pill ID:     ${PILL_ID}`);
    console.log(`Pack ID:     ${PACK_ID} (4-pill standard pack)`);
    console.log(`Player A:    ${PLAYER_A} (opened but didn't answer)`);
    console.log(`Player B:    ${PLAYER_B} (opened, answered, and WON)`);
    console.log('');

    // Get the pill plays in order
    const { data: plays } = await supabase
      .from('pill_plays')
      .select('*')
      .eq('pill_id', PILL_ID)
      .order('created_at', { ascending: true });

    console.log('Timeline of events:');
    console.log('─'.repeat(80));

    for (const play of plays) {
      console.log(`${play.created_at}`);
      console.log(`  → Player: ${play.player_id.substring(0, 8)}...`);
      console.log(`  → Action: Opened pill`);
      console.log(`  → Won: ${play.won}`);
      console.log(`  → Locked at (answered): ${play.locked_at || 'NOT ANSWERED'}`);
      console.log('');
    }

    // Get pill history
    const { data: pill } = await supabase
      .from('pills')
      .select('*')
      .eq('id', PILL_ID)
      .single();

    console.log('Pill state:');
    console.log('─'.repeat(80));
    console.log(`Status: ${pill.status}`);
    console.log(`Question: ${pill.question.substring(0, 60)}...`);
    console.log(`Correct Answer: ${pill.correct_answer}`);
    console.log(`Updated at: ${pill.updated_at}`);
    console.log('');

    // Check if there were any transactions
    console.log('Transaction history:');
    console.log('─'.repeat(80));

    const { data: txns } = await supabase
      .from('transactions')
      .select('*')
      .in('player_id', [PLAYER_A, PLAYER_B])
      .order('created_at', { ascending: true });

    for (const txn of txns) {
      const playerLabel = txn.player_id === PLAYER_A ? 'PLAYER_A' : 'PLAYER_B';
      console.log(`${txn.created_at} [${playerLabel}]`);
      console.log(`  Type: ${txn.type}`);
      console.log(`  Amount: ${txn.amount}`);
      console.log(`  Description: ${txn.description}`);
      console.log('');
    }

    // Get all pills in the pack with play counts
    console.log('All pills in pack:');
    console.log('─'.repeat(80));

    const { data: packPills } = await supabase
      .from('pills')
      .select('id, question, status, updated_at')
      .eq('pack_id', PACK_ID)
      .order('created_at', { ascending: true });

    for (const p of packPills) {
      const { count: playCount } = await supabase
        .from('pill_plays')
        .select('*', { count: 'exact', head: true })
        .eq('pill_id', p.id);

      console.log(`${p.id.substring(0, 8)}... | Status: ${p.status.padEnd(10)} | Plays: ${playCount} | ${p.question.substring(0, 40)}...`);
    }

    console.log('');
    console.log('═'.repeat(80));
    console.log('ANALYSIS:');
    console.log('═'.repeat(80));
    console.log('');
    console.log('Timeline reconstruction:');
    console.log('1. Player B opens pill #1 (20:36:53) → deducted ₦200, balance held');
    console.log('2. Player B answers within time → answered correctly with "Q"');
    console.log('3. Pill marked status="played" (after Player B submits)');
    console.log('4. AFTER pill marked "played": Player A opens SAME pill (20:39:02)');
    console.log('   → This should have been BLOCKED by POST /api/pills/open check:');
    console.log('     if (pill.status === "played") { return 409 }');
    console.log('');
    console.log('QUESTION: Did Player A get charged?');
    console.log(`  Player A balance: ₦0`);
    console.log(`  Player B balance: ₦58730 (won ₦15000 x 4 pills = ₦60000, minus some plays)`);
    console.log('');

    // Check if Player A was charged
    const { data: playerATransactions } = await supabase
      .from('transactions')
      .select('type, amount, description')
      .eq('player_id', PLAYER_A)
      .order('created_at', { ascending: true });

    if (playerATransactions.length > 0) {
      console.log('Player A transactions:');
      playerATransactions.forEach(t => {
        console.log(`  ${t.type}: ${t.amount} — ${t.description}`);
      });
    } else {
      console.log('No transactions for Player A');
    }

    console.log('');
    console.log('═'.repeat(80));
    console.log('CONCLUSION:');
    console.log('═'.repeat(80));
    console.log('');
    console.log('The data shows Player A was able to OPEN pill #1 AFTER it was marked "played".');
    console.log('This means either:');
    console.log('  A) POST /api/pills/open did NOT check status="played" at that time, OR');
    console.log('  B) The check was bypassed somehow (e.g., resume path), OR');
    console.log('  C) The pill was not actually in "played" state when Player A opened it');
    console.log('');
    console.log('Evidence Player A opened it after "played":');
    console.log(`  - Player B submitted at 20:41:28`);
    console.log(`  - Player A opened at 20:39:02 (BUT locked_at is null — never submitted)`);
    console.log(`  - This means Player A was allowed to create a pill_plays entry`);
    console.log(`  - WITHOUT the UNIQUE constraint preventing it`);
    console.log('');

  } catch (err) {
    console.error('Error:', err.message, err.code);
  }
}

analyzeIssue();
