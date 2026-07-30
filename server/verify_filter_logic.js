/**
 * Verify the includeInactive filter logic by querying real pack data
 */
require('dotenv').config({ path: '.env' });
const supabase = require('./src/db/supabase');

(async () => {
  console.log('=== PACK FILTER VERIFICATION ===\n');

  // Get all packs
  const { data: allPacks, error: allErr } = await supabase
    .from('pill_packs')
    .select('id, name, status, created_at')
    .order('created_at', { ascending: false });

  if (allErr) {
    console.log('ERROR fetching packs:', allErr.message);
    return;
  }

  console.log(`Total packs in DB: ${allPacks?.length || 0}`);
  console.log();

  // For each pack, count available pills
  const packDetails = [];
  for (const pack of (allPacks || [])) {
    const { count: availCount } = await supabase
      .from('pills')
      .select('id', { count: 'exact', head: true })
      .eq('pack_id', pack.id)
      .eq('status', 'available')
      .is('deleted_at', null);

    packDetails.push({
      ...pack,
      available_count: availCount || 0,
    });
  }

  // Show all packs with their status and available count
  console.log('All packs:');
  console.log('-'.repeat(100));
  for (const p of packDetails) {
    const isArchived = p.status === 'inactive' && p.available_count === 0;
    const statusStr = p.status.padEnd(8);
    const availStr = String(p.available_count).padStart(2);
    const archivedStr = isArchived ? 'YES' : 'NO';
    const name = p.name.substring(0, 30).padEnd(30);
    console.log(`  ${name} | status: ${statusStr} | available: ${availStr} | ARCHIVED: ${archivedStr}`);
  }

  console.log('-'.repeat(100));
  console.log();

  // Count archived packs
  const archivedPacks = packDetails.filter(p => p.status === 'inactive' && p.available_count === 0);
  console.log(`Packs matching status='inactive' AND available_count=0: ${archivedPacks.length}`);

  if (archivedPacks.length > 0) {
    console.log('Archived packs:');
    for (const p of archivedPacks) {
      console.log(`  - ${p.name} (id: ${p.id.substring(0, 8)}...)`);
    }
  } else {
    console.log('(No archived packs found)');
  }

  console.log();
  console.log('Expected behavior:');
  console.log('  GET /api/admin/pills/packs (default or ?includeInactive=false)');
  console.log(`    Should return: ${packDetails.length - archivedPacks.length} packs`);
  console.log('  GET /api/admin/pills/packs?includeInactive=true');
  console.log(`    Should return: ${packDetails.length} packs`);

  console.log();
  console.log('=== Filter logic verification ===');
  console.log();

  // Simulate the query param parsing
  console.log('Query param parsing test:');
  const testCases = [
    { param: undefined, expected: 'false' },
    { param: 'false', expected: 'false' },
    { param: 'true', expected: 'true' },
    { param: 'False', expected: 'false' },
    { param: 'True', expected: 'false' },
    { param: '1', expected: 'false' },
    { param: '0', expected: 'false' },
  ];

  for (const tc of testCases) {
    const includeInactive = tc.param !== undefined ? tc.param : 'false';
    const shouldIncludeInactive = includeInactive === 'true';
    const result = shouldIncludeInactive ? 'INCLUDE archived' : 'EXCLUDE archived';
    const correct = (shouldIncludeInactive ? 'true' : 'false') === tc.expected;
    const status = correct ? '✓' : '✗';
    console.log(`  ${status} ?includeInactive=${tc.param} → ${result}`);
  }

  console.log();
  console.log('=== DONE ===');
})().catch(console.error);
