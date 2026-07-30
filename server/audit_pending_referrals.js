#!/usr/bin/env node
/**
 * Audit: Why are there 3 pending referrals?
 *
 * A referral is "pending" when the referred user has signed up (used referral link)
 * but has NOT yet completed both conditions: (1) first deposit AND (2) first game.
 * Once both are done, the referral completes and the referrer earns the bonus.
 *
 * This script:
 * 1. Finds the referrer shown in the screenshot (ref code 7T96YU)
 * 2. Pulls all their referrals (pending + completed)
 * 3. For each pending one: shows what condition is missing (no deposit / no game / both)
 * 4. Checks the referrals table schema to confirm what "pending" means in the data
 */

require('dotenv').config();
const supabase = require('./src/db/supabase');

async function run() {
  console.log('═'.repeat(80));
  console.log('PENDING REFERRALS AUDIT');
  console.log('═'.repeat(80));
  console.log();

  // Step 1: Find referrer by code 7T96YU
  console.log('STEP 1: Find referrer with code 7T96YU');
  console.log('─'.repeat(80));

  const { data: referrer, error: refErr } = await supabase
    .from('players')
    .select('id, name, email, referral_code, balance, bonus_balance, created_at')
    .eq('referral_code', '7T96YU')
    .maybeSingle();

  if (refErr || !referrer) {
    console.log('  ❌ Referrer not found by code. Trying players table for ref code field...');
    console.log('  Error:', refErr?.message);

    // Maybe stored differently — show all columns on players table
    const { data: sample } = await supabase.from('players').select('*').limit(1);
    if (sample?.[0]) {
      console.log('  Players table columns:', Object.keys(sample[0]).join(', '));
    }
    return;
  }

  console.log('  Referrer found:');
  console.log(`    id:            ${referrer.id}`);
  console.log(`    name:          ${referrer.name || '(none)'}`);
  console.log(`    email:         ${referrer.email || '(none)'}`);
  console.log(`    referral_code: ${referrer.referral_code}`);
  console.log(`    balance:       ₦${referrer.balance}`);
  console.log(`    bonus_balance: ₦${referrer.bonus_balance}`);
  console.log(`    created_at:    ${referrer.created_at}`);
  console.log();

  // Step 2: Pull all referrals for this referrer
  console.log('STEP 2: All referrals for this referrer');
  console.log('─'.repeat(80));

  const { data: referrals, error: rErr } = await supabase
    .from('referrals')
    .select('*')
    .eq('referrer_id', referrer.id)
    .order('created_at', { ascending: false });

  if (rErr) {
    console.log('  ❌ referrals query error:', rErr.message);

    // Try alternate column name
    const { data: alt, error: altErr } = await supabase
      .from('referrals')
      .select('*')
      .limit(5);
    if (alt?.[0]) {
      console.log('  referrals table columns:', Object.keys(alt[0]).join(', '));
    } else {
      console.log('  alt error:', altErr?.message);
    }
    return;
  }

  if (!referrals || referrals.length === 0) {
    console.log('  No referrals found for this referrer.');
    return;
  }

  console.log(`  Total referrals: ${referrals.length}`);
  const pending   = referrals.filter(r => r.status === 'pending');
  const completed = referrals.filter(r => r.status === 'completed');
  const other     = referrals.filter(r => r.status !== 'pending' && r.status !== 'completed');

  console.log(`  Pending:   ${pending.length}`);
  console.log(`  Completed: ${completed.length}`);
  console.log(`  Other:     ${other.length} ${other.map(r => r.status).join(', ')}`);
  console.log();

  // Step 3: For each pending referral, check what's missing
  console.log('STEP 3: Pending referral breakdown — what condition is blocking each one?');
  console.log('─'.repeat(80));
  console.log();

  for (let i = 0; i < pending.length; i++) {
    const r = pending[i];
    const referredId = r.referred_id || r.referee_id;

    console.log(`  [${i + 1}] Referral ID: ${r.id}`);
    console.log(`      referred player: ${referredId}`);
    console.log(`      referral created: ${r.created_at}`);
    console.log(`      status: ${r.status}`);

    // Show all columns on this referral row (to see what flags exist)
    const cols = Object.keys(r);
    for (const col of cols) {
      if (!['id', 'referrer_id', 'referred_id', 'referee_id', 'status', 'created_at'].includes(col)) {
        console.log(`      ${col}: ${JSON.stringify(r[col])}`);
      }
    }

    if (!referredId) {
      console.log('      ⚠️  No referred_id / referee_id found — cannot check player');
      console.log();
      continue;
    }

    // Check referred player's profile
    const { data: rPlayer } = await supabase
      .from('players')
      .select('id, name, email, balance, bonus_balance, created_at')
      .eq('id', referredId)
      .maybeSingle();

    if (!rPlayer) {
      console.log('      ❌ Referred player not found in players table (may have been deleted)');
      console.log();
      continue;
    }

    console.log(`      referred name:     ${rPlayer.name || '(none)'}`);
    console.log(`      referred email:    ${rPlayer.email || '(none)'}`);
    console.log(`      referred balance:  ₦${rPlayer.balance}`);
    console.log(`      referred joined:   ${rPlayer.created_at}`);

    // Check if they have made a deposit
    const { data: deposits } = await supabase
      .from('transactions')
      .select('id, amount, type, created_at')
      .eq('player_id', referredId)
      .in('type', ['deposit', 'credit', 'top_up', 'topup', 'fund'])
      .order('created_at', { ascending: true })
      .limit(5);

    const hasDeposit = deposits && deposits.length > 0;
    console.log(`      has_deposit: ${hasDeposit ? '✓ YES' : '✗ NO'}`);
    if (hasDeposit) {
      const first = deposits[0];
      console.log(`        first deposit: ₦${first.amount} on ${first.created_at} (type=${first.type})`);
    }

    // Check if they have played any game (pill_plays, special_attempts, blitz_registrations)
    const { data: pillPlays } = await supabase
      .from('pill_plays')
      .select('id, created_at')
      .eq('player_id', referredId)
      .limit(3);

    const { data: specialPlays } = await supabase
      .from('special_attempts')
      .select('id, created_at')
      .eq('player_id', referredId)
      .limit(3);

    const hasPillPlay    = pillPlays    && pillPlays.length > 0;
    const hasSpecialPlay = specialPlays && specialPlays.length > 0;
    const hasAnyGame     = hasPillPlay || hasSpecialPlay;

    console.log(`      has_game:    ${hasAnyGame ? '✓ YES' : '✗ NO'}`);
    if (hasPillPlay)    console.log(`        pill_plays: ${pillPlays.length} row(s)`);
    if (hasSpecialPlay) console.log(`        special_attempts: ${specialPlays.length} row(s)`);

    // Diagnosis
    console.log();
    if (!hasDeposit && !hasAnyGame) {
      console.log('      🔴 BLOCKING: No deposit AND no game — just signed up, nothing else');
    } else if (!hasDeposit && hasAnyGame) {
      console.log('      🟡 BLOCKING: Played a game but has NOT made a deposit yet');
    } else if (hasDeposit && !hasAnyGame) {
      console.log('      🟡 BLOCKING: Made a deposit but has NOT played any game yet');
    } else {
      console.log('      🟠 UNEXPECTED: Has both deposit and game — referral should be completed!');
      console.log('         This may indicate a bug in checkReferralCompletion()');
    }

    console.log();
  }

  // Step 4: Show completed referrals for comparison
  console.log('STEP 4: Completed referral (for comparison)');
  console.log('─'.repeat(80));
  console.log();

  for (const r of completed) {
    const referredId = r.referred_id || r.referee_id;
    console.log(`  Referral ID: ${r.id}`);
    console.log(`  referred player: ${referredId}`);
    console.log(`  completed_at: ${r.completed_at || r.updated_at || '(no timestamp field)'}`);
    const cols = Object.keys(r);
    for (const col of cols) {
      if (!['id', 'referrer_id', 'referred_id', 'referee_id', 'status', 'created_at'].includes(col)) {
        console.log(`  ${col}: ${JSON.stringify(r[col])}`);
      }
    }
    console.log();
  }

  // Step 5: Check checkReferralCompletion logic in code
  console.log('STEP 5: Code gate — how does checkReferralCompletion() decide to complete?');
  console.log('─'.repeat(80));

  const fs = require('fs');
  const path = require('path');
  const refFile = path.join(__dirname, 'src/routes/referrals.js');

  if (!fs.existsSync(refFile)) {
    console.log('  ❌ referrals.js not found at', refFile);
  } else {
    const content = fs.readFileSync(refFile, 'utf8');
    const lines = content.split('\n');

    // Find checkReferralCompletion function
    let inFn = false;
    let depth = 0;
    let fnLines = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('checkReferralCompletion')) {
        inFn = true;
        depth = 0;
      }
      if (inFn) {
        fnLines.push(`  ${i + 1}: ${lines[i]}`);
        depth += (lines[i].match(/\{/g) || []).length;
        depth -= (lines[i].match(/\}/g) || []).length;
        if (depth === 0 && fnLines.length > 3) break;
      }
    }

    if (fnLines.length > 0) {
      console.log('  checkReferralCompletion() source:');
      console.log();
      fnLines.forEach(l => console.log(l));
    } else {
      console.log('  checkReferralCompletion not found in referrals.js');
    }
  }

  console.log();
  console.log('═'.repeat(80));
  console.log('AUDIT COMPLETE');
  console.log('═'.repeat(80));
}

run().catch(err => {
  console.error('Script error:', err.message);
  process.exit(1);
});
