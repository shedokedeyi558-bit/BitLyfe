/**
 * Diagnostic: Verify bonus_balance availability for Pills/Specials entry
 * 
 * Player reported: bonus_balance cannot be used to enter Pills or Specials packs.
 * This script:
 *   1. Queries the specific player's real_balance and bonus_balance directly
 *   2. Confirms what GET /api/wallet/balance actually returns
 *   3. Simulates the exact affordability check used in pills.js and pillsVip.js
 */

require('dotenv').config();
const supabase = require('./src/db/supabase');

async function main() {
  console.log('=== BONUS BALANCE BUG DIAGNOSTIC ===\n');

  // 1. All players with bonus_balance > 0 — find the real affected player
  console.log('--- 1. All players with bonus_balance > 0 ---');
  const { data: bonusPlayers, error: bonusErr } = await supabase
    .from('players')
    .select('id, phone, name, balance, bonus_balance, status')
    .gt('bonus_balance', 0)
    .order('bonus_balance', { ascending: false });

  if (bonusErr) {
    console.error('Query error:', bonusErr.message);
  } else if (!bonusPlayers || bonusPlayers.length === 0) {
    console.log('  ⚠️  NO players have bonus_balance > 0 in the database!');
    console.log('  This means either: referral bonuses were never credited, or the column is always 0/null.');
  } else {
    console.log(`  Found ${bonusPlayers.length} player(s) with bonus balance:\n`);
    for (const p of bonusPlayers) {
      console.log(`  Player: ${p.name || '(no name)'} | phone: ${p.phone}`);
      console.log(`    id:            ${p.id}`);
      console.log(`    balance:       ₦${p.balance}`);
      console.log(`    bonus_balance: ₦${p.bonus_balance}`);
      console.log(`    total:         ₦${(p.balance || 0) + (p.bonus_balance || 0)}`);
      console.log(`    status:        ${p.status}`);
      console.log();
    }
  }

  // Use the first player with bonus balance for the simulation, or fall back to any player
  const authPlayer = bonusPlayers?.[0] || null;

  // If no player has bonus balance, just grab any player to prove schema works
  let samplePlayer = authPlayer;
  if (!samplePlayer) {
    const { data: any } = await supabase
      .from('players')
      .select('id, phone, name, balance, bonus_balance, status')
      .limit(1)
      .maybeSingle();
    samplePlayer = any;
    if (samplePlayer) {
      console.log('  (Using first player for simulation since no one has bonus_balance > 0)');
      console.log(`  Player: ${samplePlayer.name} | phone: ${samplePlayer.phone}`);
      console.log(`    balance: ₦${samplePlayer.balance} | bonus_balance: ₦${samplePlayer.bonus_balance}\n`);
    }
  }

  // 2. Wallet balance API simulation for the player
  if (samplePlayer) {
    console.log('--- 2. GET /api/wallet/balance response simulation ---');
    const walletResponse = {
      success: true,
      data: {
        balance: samplePlayer.balance,
        bonus_balance: samplePlayer.bonus_balance || 0,
        total: (samplePlayer.balance || 0) + (samplePlayer.bonus_balance || 0),
      },
    };
    console.log('  Response body:', JSON.stringify(walletResponse, null, 2));
    console.log();
  }

  // 3. Simulate affordability checks for both routes
  console.log('--- 3. Affordability check simulation ---');
  if (samplePlayer) {
    const balance      = samplePlayer.balance || 0;
    const bonusBalance = samplePlayer.bonus_balance || 0;
    const total        = balance + bonusBalance;

    // Test various entry fees
    const testFees = [50, 100, 200, 500];
    for (const fee of testFees) {
      // pills.js line 539: (player.balance || 0) + (player.bonus_balance || 0) < entryFee
      const pillsCheck   = total < fee ? 'REJECTED (402)' : 'ALLOWED ✓';
      // pillsVip.js line 516: entryFee > 0 && (player.balance || 0) + (player.bonus_balance || 0) < entryFee
      const specialsCheck = (fee > 0 && total < fee) ? 'REJECTED (402)' : 'ALLOWED ✓';

      console.log(`  Entry fee ₦${fee}:`);
      console.log(`    Pills:    ${pillsCheck}  (balance=₦${balance} bonus=₦${bonusBalance} total=₦${total})`);
      console.log(`    Specials: ${specialsCheck}`);
    }
  }

  console.log();

  // 4. Check if bonus_balance column exists in schema
  console.log('--- 4. Schema verification: does players table have bonus_balance? ---');
  const { data: schemaCheck, error: schemaErr } = await supabase
    .from('players')
    .select('bonus_balance')
    .limit(1);

  if (schemaErr) {
    console.error('  Schema check ERROR:', schemaErr.message);
    console.error('  ⚠️  This means bonus_balance column may NOT exist in the players table!');
  } else {
    console.log('  ✓ bonus_balance column exists in players table');
    console.log('  Sample row bonus_balance:', schemaCheck?.[0]?.bonus_balance);
  }

  console.log();

  // 5. List all pack entry fees to check what's affordable
  console.log('--- 5. Available pill packs and their entry fees ---');
  const { data: packs, error: packsErr } = await supabase
    .from('pill_packs')
    .select('id, name, entry_fee')
    .order('entry_fee', { ascending: true });

  if (packsErr) {
    console.error('Packs query error:', packsErr.message);
  } else {
    if (!packs || packs.length === 0) {
      console.log('  No active packs found');
    } else {
      const playerTotal = (authPlayer?.bonus_balance || 0) + (authPlayer?.balance || 0);
      for (const p of packs) {
        const fee = p.entry_fee || 0;
        const canAfford = playerTotal >= fee;
        console.log(`  [${p.type || 'pill'}] "${p.name}" — fee: ₦${fee} — ${canAfford ? 'AFFORDABLE ✓' : 'TOO EXPENSIVE ✗'}`);
      }
    }
  }

  console.log('\n=== DONE ===');
}

main().catch(console.error);
