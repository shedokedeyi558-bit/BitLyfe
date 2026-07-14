require('dotenv').config({ path: '.env' });
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 5; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const { data } = await supabase.from('players').select('id').eq('referral_code', code).maybeSingle();
    if (!data) return code;
  }
  return uuidv4().replace(/-/g, '').substring(0, 8).toUpperCase();
}

async function main() {
  console.log('\n=== PHASE 2 RE-VERIFICATION (post schema reload) ===\n');

  const ts = Date.now();
  const referrerCode = await generateReferralCode();
  const refereeCode  = await generateReferralCode();

  // Create referrer
  const { data: referrer, error: e1 } = await supabase
    .from('players')
    .insert({ email: `referrer_${ts}@test.bitlyfe`, password_hash: 'x', phone: `+234800${ts}`, name: 'Referrer', balance: 0, is_admin: false, referral_code: referrerCode })
    .select('id, referral_code').single();
  if (e1) { console.log('✗ Referrer insert failed:', e1.message); return; }
  console.log(`✓ Referrer created  id=${referrer.id}  code=${referrer.referral_code}`);

  // Create referee
  const { data: referee, error: e2 } = await supabase
    .from('players')
    .insert({ email: `referee_${ts}@test.bitlyfe`, password_hash: 'x', phone: `+234801${ts}`, name: 'Referee', balance: 0, is_admin: false, referral_code: refereeCode })
    .select('id').single();
  if (e2) { console.log('✗ Referee insert failed:', e2.message); return; }
  console.log(`✓ Referee created   id=${referee.id}`);

  // Create referral row
  const { data: refRow, error: e3 } = await supabase
    .from('referrals')
    .insert({ referrer_id: referrer.id, referee_id: referee.id, status: 'pending', first_deposit_done: false, first_game_done: false, first_deposit_amount: 0 })
    .select('referrer_id, referee_id, status, first_deposit_done, first_game_done').single();
  if (e3) { console.log('✗ Referral row failed:', e3.message); }
  else {
    console.log(`✓ Referral row created`);
    console.log(`    referrer_id:        ${refRow.referrer_id}`);
    console.log(`    referee_id:         ${refRow.referee_id}`);
    console.log(`    status:             ${refRow.status}`);
    console.log(`    first_deposit_done: ${refRow.first_deposit_done}`);
    console.log(`    first_game_done:    ${refRow.first_game_done}`);
  }

  // Cleanup
  await supabase.from('referrals').delete().eq('referee_id', referee.id);
  await supabase.from('players').delete().eq('id', referee.id);
  await supabase.from('players').delete().eq('id', referrer.id);
  console.log('\n✓ Cleanup done\n');

  if (!e3) {
    console.log('=== PHASE 2: PASS — ready for Phase 3 ===\n');
  } else {
    console.log('=== PHASE 2: FAIL — referrals table still not accessible ===\n');
  }
}

main().catch(console.error);
