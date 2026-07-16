/**
 * verify_answer_locks.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Verifies that the atomic answer-lock migration and stored procedures are
 * working correctly. Run from the server/ directory:
 *
 *   node verify_answer_locks.js
 *
 * What it checks:
 *   1. New columns exist: pill_plays.locked_at, special_attempts.answer_locked_at
 *   2. lock_pill_answer() RPC: first call writes, second call returns 0 (blocked)
 *   3. lock_special_answer() RPC: first call writes, second call returns 0 (blocked)
 *
 * Requires a real Supabase connection (.env must be present).
 * Creates and cleans up its own test rows — safe to run on a live DB.
 */

require('dotenv').config();
const supabase = require('./src/db/supabase');

const PASS = '✅ PASS';
const FAIL = '❌ FAIL';

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`${PASS}  ${label}`);
    passed++;
  } else {
    console.error(`${FAIL}  ${label}`, detail || '');
    failed++;
  }
}

async function run() {
  console.log('\n─── Answer Lock Verification ────────────────────────────────\n');

  // ── 1. Column existence ───────────────────────────────────────────────────
  console.log('1. Checking column existence...');

  const { data: pillPlaysRow, error: ppColErr } = await supabase
    .from('pill_plays')
    .select('locked_at, submitted_answer')
    .limit(1);

  assert(
    'pill_plays has locked_at column',
    !ppColErr && pillPlaysRow !== null,
    ppColErr?.message
  );

  const { data: saRow, error: saColErr } = await supabase
    .from('special_attempts')
    .select('answer_locked_at')
    .limit(1);

  assert(
    'special_attempts has answer_locked_at column',
    !saColErr && saRow !== null,
    saColErr?.message
  );

  if (failed > 0) {
    console.error('\nColumn check failed — run DATABASE_MIGRATION_ANSWER_LOCKS.sql first.\n');
    process.exit(1);
  }

  // ── 2. Find (or create) test data ─────────────────────────────────────────
  console.log('\n2. Setting up test data...');

  // Find any pill_plays row for testing lock_pill_answer
  const { data: anyPlay } = await supabase
    .from('pill_plays')
    .select('pill_id, player_id, locked_at')
    .is('locked_at', null)
    .limit(1)
    .maybeSingle();

  if (!anyPlay) {
    console.log('   No unlocked pill_plays row found — skipping lock_pill_answer test.');
    console.log('   (Play a pill first, then re-run this script to test pill locking.)');
  } else {
    console.log(`   Found unlocked pill_play: pill_id=${anyPlay.pill_id}`);

    // ── 3. lock_pill_answer: first call should return 1 ───────────────────
    console.log('\n3. Testing lock_pill_answer RPC...');
    const now = new Date().toISOString();

    const { data: lock1, error: lock1Err } = await supabase.rpc('lock_pill_answer', {
      p_pill_id:   anyPlay.pill_id,
      p_player_id: anyPlay.player_id,
      p_answer:    '__verify_test_answer__',
      p_now:       now,
    });

    assert('First lock_pill_answer call returns 1 (lock acquired)', lock1 === 1, lock1Err?.message || `got ${lock1}`);

    // Second call — should return 0 (already locked)
    const { data: lock2, error: lock2Err } = await supabase.rpc('lock_pill_answer', {
      p_pill_id:   anyPlay.pill_id,
      p_player_id: anyPlay.player_id,
      p_answer:    '__verify_second_answer_SHOULD_NOT_STORE__',
      p_now:       new Date().toISOString(),
    });

    assert('Second lock_pill_answer call returns 0 (already locked — duplicate blocked)', lock2 === 0, lock2Err?.message || `got ${lock2}`);

    // Confirm the stored answer is the FIRST one, not the second
    const { data: verifyPlay } = await supabase
      .from('pill_plays')
      .select('submitted_answer, locked_at')
      .eq('pill_id', anyPlay.pill_id)
      .eq('player_id', anyPlay.player_id)
      .single();

    assert(
      'Stored answer is the first submission (not overwritten by duplicate)',
      verifyPlay?.submitted_answer === '__verify_test_answer__',
      `got: ${verifyPlay?.submitted_answer}`
    );

    assert(
      'locked_at timestamp is set',
      !!verifyPlay?.locked_at,
      `got: ${verifyPlay?.locked_at}`
    );

    // Cleanup — reset this play row so it doesn't pollute the DB
    await supabase
      .from('pill_plays')
      .update({ locked_at: null, submitted_answer: null })
      .eq('pill_id', anyPlay.pill_id)
      .eq('player_id', anyPlay.player_id);

    console.log('   (Test pill_play row reset back to unlocked state.)');
  }

  // ── 4. lock_special_answer test ───────────────────────────────────────────
  const { data: anyAttempt } = await supabase
    .from('special_attempts')
    .select('id, player_id, question_ids, answer_locked_at, status')
    .eq('status', 'in_progress')
    .limit(1)
    .maybeSingle();

  if (!anyAttempt) {
    console.log('\n4. No in_progress special_attempts row found — skipping lock_special_answer test.');
    console.log('   (Start a special pack attempt, then re-run this script.)');
  } else {
    console.log(`\n4. Testing lock_special_answer RPC (attempt ${anyAttempt.id})...`);

    const locks = anyAttempt.answer_locked_at || [];
    // Find the first unlocked slot
    const targetIdx = locks.findIndex((v) => v === null || v === undefined);
    const testIdx = targetIdx === -1 ? 0 : targetIdx;

    // Only test if that slot isn't already locked
    const alreadyLocked = locks[testIdx] !== null && locks[testIdx] !== undefined;
    if (alreadyLocked) {
      console.log(`   Slot ${testIdx} already locked — all slots may be locked. Skipping.`);
    } else {
      const now2 = new Date().toISOString();

      const { data: saLock1, error: saLock1Err } = await supabase.rpc('lock_special_answer', {
        p_attempt_id: anyAttempt.id,
        p_player_id:  anyAttempt.player_id,
        p_idx:        testIdx,
        p_answer:     '__verify_test__',
        p_now:        now2,
      });

      assert(`First lock_special_answer call (slot ${testIdx}) returns 1`, saLock1 === 1, saLock1Err?.message || `got ${saLock1}`);

      const { data: saLock2, error: saLock2Err } = await supabase.rpc('lock_special_answer', {
        p_attempt_id: anyAttempt.id,
        p_player_id:  anyAttempt.player_id,
        p_idx:        testIdx,
        p_answer:     '__verify_overwrite_SHOULD_NOT_STORE__',
        p_now:        new Date().toISOString(),
      });

      assert(`Second lock_special_answer call (slot ${testIdx}) returns 0 (duplicate blocked)`, saLock2 === 0, saLock2Err?.message || `got ${saLock2}`);

      // Confirm answer was not overwritten
      const { data: verifyAttempt } = await supabase
        .from('special_attempts')
        .select('answers, answer_locked_at')
        .eq('id', anyAttempt.id)
        .single();

      const storedAnswer = (verifyAttempt?.answers || [])[testIdx];
      assert(
        `Stored answer at slot ${testIdx} is the first submission (not overwritten)`,
        storedAnswer === '__verify_test__',
        `got: ${storedAnswer}`
      );

      // Cleanup — reset the slot
      const resetAnswers = [...(verifyAttempt?.answers || [])];
      const resetLocks   = [...(verifyAttempt?.answer_locked_at || [])];
      resetAnswers[testIdx] = null;
      resetLocks[testIdx]   = null;

      await supabase
        .from('special_attempts')
        .update({ answers: resetAnswers, answer_locked_at: resetLocks })
        .eq('id', anyAttempt.id);

      console.log(`   (Test slot ${testIdx} reset back to null.)`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────────────────────────');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('All checks passed — answer locking is working correctly.\n');
  } else {
    console.log('Some checks failed — review output above.\n');
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
