#!/usr/bin/env node
/**
 * Query 6 audit: "repeated questions" reported in a Standard Pills pack
 *
 * 1. Check pill_plays for ANY pill_id appearing more than once
 *    (structurally impossible under correct design — one pill → one global play)
 * 2. Check the pills.js open() gate: does it still reject status='played' before charging?
 *    (verify the recent getAnswerInputMode / empty-answer / timeout additions didn't move/remove it)
 * 3. Check for duplicate question TEXT across different pills in the same pack
 *    (content/authoring overlap — looks like repeat but is actually different pill_ids)
 * 4. Report with real database output
 */

require('dotenv').config();
const supabase = require('./src/db/supabase');
const fs = require('fs');
const path = require('path');

async function run() {
  console.log('═'.repeat(80));
  console.log('QUERY 6 AUDIT: Repeated Questions in Standard Pills Pack');
  console.log('═'.repeat(80));
  console.log();

  // ── CHECK 1: pill_plays duplicates across ENTIRE database ─────────────────
  console.log('CHECK 1: pill_plays — any pill_id appearing more than once (global, all time)');
  console.log('─'.repeat(80));

  const { data: allPlays, error: playsErr } = await supabase
    .from('pill_plays')
    .select('id, pill_id, player_id, won, locked_at, created_at')
    .order('created_at', { ascending: false });

  if (playsErr) {
    console.error('  ❌ pill_plays query error:', playsErr.message);
  } else {
    const totalRows = (allPlays || []).length;
    console.log(`  Total pill_plays rows in database: ${totalRows}`);

    // Group by pill_id — count appearances
    const byPill = {};
    for (const row of allPlays || []) {
      if (!byPill[row.pill_id]) byPill[row.pill_id] = [];
      byPill[row.pill_id].push(row);
    }

    const duplicates = Object.entries(byPill).filter(([, rows]) => rows.length > 1);

    if (duplicates.length === 0) {
      console.log('  ✓ ZERO duplicates — no pill_id appears more than once in pill_plays');
      console.log('  This means NO Standard Pill was ever served to two different players.');
    } else {
      console.log(`  ❌ DUPLICATES FOUND: ${duplicates.length} pill_id(s) appear more than once`);
      console.log();
      for (const [pillId, rows] of duplicates) {
        console.log(`  Pill ID: ${pillId}`);
        console.log(`  Play count: ${rows.length}`);
        for (const row of rows) {
          console.log(`    - play_id=${row.id}`);
          console.log(`      player_id=${row.player_id}`);
          console.log(`      won=${row.won}  locked_at=${row.locked_at}  created_at=${row.created_at}`);
        }
        console.log();
      }
    }
  }

  console.log();

  // ── CHECK 2: duplicate question TEXT in Standard Pill packs ───────────────
  console.log('CHECK 2: Duplicate question TEXT across pills in the same Standard pack');
  console.log('─'.repeat(80));
  console.log('  (Content overlap — same text, different pill_id — looks like repeat but is not)');
  console.log();

  const { data: allPills, error: pillsErr } = await supabase
    .from('pills')
    .select('id, pack_id, question, status')
    .order('pack_id', { ascending: true });

  if (pillsErr) {
    console.error('  ❌ pills query error:', pillsErr.message);
  } else {
    // Group by pack_id, then check for duplicate question text within each pack
    const byPack = {};
    for (const pill of allPills || []) {
      if (!pill.pack_id) continue; // skip standalone pills
      if (!byPack[pill.pack_id]) byPack[pill.pack_id] = [];
      byPack[pill.pack_id].push(pill);
    }

    let anyTextDupes = false;
    for (const [packId, pills] of Object.entries(byPack)) {
      const seen = {};
      const dupes = [];
      for (const pill of pills) {
        const key = (pill.question || '').trim().toLowerCase();
        if (seen[key]) {
          dupes.push({ a: seen[key], b: pill });
        } else {
          seen[key] = pill;
        }
      }
      if (dupes.length > 0) {
        anyTextDupes = true;
        console.log(`  ⚠️  Pack ${packId} has ${dupes.length} duplicate question text(s):`);
        for (const { a, b } of dupes) {
          console.log(`    Pill A: ${a.id} (status=${a.status})`);
          console.log(`    Pill B: ${b.id} (status=${b.status})`);
          console.log(`    Question: "${(a.question || '').substring(0, 80)}"`);
        }
        console.log();
      }
    }

    if (!anyTextDupes) {
      console.log('  ✓ No duplicate question text found within any pack.');
      console.log('  Each pill in every pack has a unique question.');
    }
  }

  console.log();

  // ── CHECK 3: Inspect pills.js open() gate for status='played' ─────────────
  console.log('CHECK 3: Verify pills.js POST /api/pills/open still rejects status=\'played\'');
  console.log('─'.repeat(80));
  console.log('  (Ensure recent Specials changes did not move/remove the payment gate)');
  console.log();

  const pillsJsPath = path.join(__dirname, 'src/routes/pills.js');
  const pillsJs = fs.readFileSync(pillsJsPath, 'utf8');
  const lines = pillsJs.split('\n');

  // Find the open route
  let inOpenRoute = false;
  let openRouteStart = -1;
  let openRouteLines = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("router.post('/open'")) {
      inOpenRoute = true;
      openRouteStart = i + 1;
      depth = 0;
    }
    if (inOpenRoute) {
      openRouteLines.push({ lineNo: i + 1, text: lines[i] });
      depth += (lines[i].match(/\{/g) || []).length;
      depth -= (lines[i].match(/\}/g) || []).length;
      if (depth === 0 && openRouteLines.length > 5) break; // end of route
    }
  }

  const openRouteContent = openRouteLines.map(l => l.text).join('\n');

  // 1. Does it check for status='played' BEFORE billing?
  const playedCheckIdx   = openRouteContent.indexOf("status === 'played'");
  const billingIdx       = openRouteContent.indexOf('deductEntryFee');
  const atomicClaimIdx   = openRouteContent.indexOf('claim_pill_for_opening');

  if (playedCheckIdx === -1) {
    console.log('  ❌ REGRESSION: No status=\'played\' check found in open() route!');
  } else {
    console.log('  ✓ status=\'played\' check IS present in open() route');

    if (billingIdx > -1 && playedCheckIdx < billingIdx) {
      console.log('  ✓ played check comes BEFORE deductEntryFee — payment gate is intact');
    } else if (billingIdx > -1) {
      console.log('  ⚠️  played check comes AFTER deductEntryFee — gate may be bypassed!');
    }
  }

  if (atomicClaimIdx === -1) {
    console.log('  ⚠️  claim_pill_for_opening RPC call NOT found in open() — atomic fix not present');
  } else {
    console.log('  ✓ claim_pill_for_opening RPC call IS present (atomic race-condition fix in code)');
    if (atomicClaimIdx > billingIdx && billingIdx > -1) {
      console.log('  ❌ PROBLEM: RPC claim comes AFTER billing — race condition NOT fixed correctly!');
    } else {
      console.log('  ✓ RPC claim comes BEFORE billing — correct order');
    }
  }

  // 2. Check for status='opening' check (second guard before atomic claim)
  const openingCheckIdx = openRouteContent.indexOf("status === 'opening'");
  if (openingCheckIdx > -1) {
    console.log('  ✓ status=\'opening\' check IS present (fast-path rejection before RPC call)');
  }

  // Print the relevant lines for evidence
  console.log();
  console.log('  Evidence — exact lines from open() that handle status checks and billing:');
  console.log('  (Line numbers are 1-indexed from pills.js)');
  console.log();
  for (const { lineNo, text } of openRouteLines) {
    const t = text.trim();
    if (
      t.includes("status === 'played'") ||
      t.includes("status === 'opening'") ||
      t.includes('claim_pill_for_opening') ||
      t.includes('deductEntryFee') ||
      t.includes('PILL_ALREADY_PLAYED') ||
      t.includes('PILL_BEING_OPENED') ||
      t.includes('revert_pill_from_opening')
    ) {
      console.log(`    Line ${lineNo}: ${text.trimEnd()}`);
    }
  }

  // ── CHECK 4: pills status breakdown for Standard pack ─────────────────────
  console.log();
  console.log('CHECK 4: Current pill status distribution (Standard packs only)');
  console.log('─'.repeat(80));

  const { data: statusRows } = await supabase
    .from('pills')
    .select('pack_id, status')
    .not('pack_id', 'is', null);

  if (statusRows) {
    const statusMap = {};
    for (const row of statusRows) {
      statusMap[row.status] = (statusMap[row.status] || 0) + 1;
    }
    console.log('  Status    | Count');
    console.log('  ─────────────────');
    for (const [s, c] of Object.entries(statusMap)) {
      console.log(`  ${s.padEnd(10)}| ${c}`);
    }

    const played = statusMap['played'] || 0;
    const available = statusMap['available'] || 0;
    const opening = statusMap['opening'] || 0;

    console.log();
    if (opening > 0) {
      console.log(`  ⚠️  ${opening} pill(s) currently in 'opening' state (mid-open, should clear soon)`);
    } else {
      console.log('  ✓ 0 pills in \'opening\' state');
    }
    console.log(`  Summary: ${available} available, ${played} played, ${opening} opening`);
  }

  // ── CONCLUSION ─────────────────────────────────────────────────────────────
  console.log();
  console.log('═'.repeat(80));
  console.log('CONCLUSION');
  console.log('═'.repeat(80));
  console.log();
  console.log('The Standard Pills model guarantees:');
  console.log('  - A pill with status=\'played\' is REJECTED in open() before any charge.');
  console.log('  - A pill_plays row with a given pill_id should only exist once globally.');
  console.log();
  console.log('If a player saw "repeated questions":');
  console.log('  CASE A — pill_plays has duplicates: pill was served twice (data bug).');
  console.log('  CASE B — no duplicates, but same question TEXT in two different pills:');
  console.log('           authoring/content overlap — the same question text was added to');
  console.log('           the pack twice by admin as two separate pills (different IDs).');
  console.log('           This is NOT a system bug; it\'s a content-authoring duplicate.');
  console.log('  CASE C — player memory/perception: different questions felt similar.');
  console.log();
}

run().catch(err => {
  console.error('Script error:', err.message);
  process.exit(1);
});
