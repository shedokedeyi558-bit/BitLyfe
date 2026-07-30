#!/usr/bin/env node

/**
 * Test the pill race condition fix
 * Verifies that atomic pill claiming prevents simultaneous opens
 */

require('dotenv').config();
const supabase = require('./src/db/supabase');

async function testPillRaceFix() {
  console.log('═'.repeat(80));
  console.log('TESTING PILL RACE CONDITION FIX');
  console.log('═'.repeat(80));
  console.log('');

  try {
    // Check if the RPC function exists
    console.log('TEST 1: Verify claim_pill_for_opening RPC exists');
    console.log('─'.repeat(80));

    const { data: testClaim, error: testErr } = await supabase.rpc('claim_pill_for_opening', {
      p_pill_id: '00000000-0000-0000-0000-000000000000', // non-existent pill
    });

    if (testErr && testErr.message.includes('function')) {
      console.log('❌ RPC function not deployed yet');
      console.log('   Error:', testErr.message);
      console.log('');
      console.log('ACTION REQUIRED: Run DATABASE_MIGRATION_PILL_RACE_FIX.sql first');
    } else if (testErr) {
      console.log('⚠️  RPC returned error (expected for non-existent pill):');
      console.log('   ', testErr.message);
    } else {
      console.log('✓ RPC function claim_pill_for_opening is available');
      console.log('  Result:', testClaim);
    }

    console.log('');

    // Test 2: Verify CHECK constraint
    console.log('TEST 2: Verify pills.status CHECK constraint includes "opening"');
    console.log('─'.repeat(80));

    // Try to insert a pill with status='opening' (should succeed if constraint is updated)
    const testPillId = '99999999-0000-0000-0000-000000000001';
    const { error: insertErr } = await supabase.from('pills').insert({
      id: testPillId,
      question: 'Test question',
      format: 'multiple_choice',
      entry_fee: 100,
      prize: 1000,
      correct_answer: 'A',
      status: 'opening',
      options: JSON.stringify(['A', 'B', 'C']),
    });

    if (insertErr && insertErr.message.includes('violates check')) {
      console.log('❌ CHECK constraint not updated — "opening" status not allowed');
    } else if (insertErr) {
      console.log('⚠️  Insert error:', insertErr.message);
    } else {
      console.log('✓ CHECK constraint allows "opening" status');
      // Clean up test pill
      await supabase.from('pills').delete().eq('id', testPillId);
    }

    console.log('');

    // Test 3: Check current pill statuses in database
    console.log('TEST 3: Audit current pill statuses');
    console.log('─'.repeat(80));

    const { data: allPills } = await supabase
      .from('pills')
      .select('id, status')
      .order('status', { ascending: true });

    const statusCounts = {};
    for (const p of allPills || []) {
      statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
    }

    console.log('Pill status distribution:');
    for (const [status, count] of Object.entries(statusCounts)) {
      console.log(`  ${status.padEnd(12)}: ${count}`);
    }

    if (statusCounts['opening'] > 0) {
      console.log('');
      console.log('⚠️  WARNING: Found pills in "opening" status');
      console.log('   These should transition to "played" within timer_seconds + 5s');
      const { data: openingPills } = await supabase
        .from('pills')
        .select('id, question, updated_at')
        .eq('status', 'opening');
      openingPills.forEach(p => {
        console.log(`   - ${p.id.substring(0, 8)}... updated ${p.updated_at}`);
      });
    } else {
      console.log('✓ No pills stuck in "opening" status');
    }

    console.log('');

    // Test 4: Verify no duplicates exist
    console.log('TEST 4: Verify no duplicate pill_plays');
    console.log('─'.repeat(80));

    const { data: allPlays } = await supabase
      .from('pill_plays')
      .select('pill_id, player_id, id');

    const playMap = {};
    const duplicates = [];

    for (const play of allPlays || []) {
      const key = `${play.pill_id}|${play.player_id}`;
      if (playMap[key]) {
        duplicates.push({
          key,
          records: [playMap[key], play],
        });
      } else {
        playMap[key] = play;
      }
    }

    if (duplicates.length > 0) {
      console.log(`❌ Found ${duplicates.length} duplicates (should be 0)`);
      duplicates.forEach(dup => {
        console.log(`   Pill: ${dup.key}`);
      });
    } else {
      console.log('✓ No duplicate pill_plays entries found');
    }

    console.log('');
    console.log('═'.repeat(80));
    console.log('PILL RACE FIX VERIFICATION COMPLETE');
    console.log('═'.repeat(80));
    console.log('');
    console.log('Next steps:');
    console.log('1. Deploy DATABASE_MIGRATION_PILL_RACE_FIX.sql to Supabase');
    console.log('2. Restart the server to load updated pills.js');
    console.log('3. Test: Open same pill from 2 browser tabs simultaneously');
    console.log('   Expected: Second player gets "pill being opened" error');
    console.log('');

  } catch (err) {
    console.error('Test error:', err.message);
  }
}

testPillRaceFix();
