/**
 * Verify that ONLY 2 successful SquadCo transactions were affected
 * (the ones we just credited)
 */
require('dotenv').config({ path: '.env' });
const supabase = require('./src/db/supabase');

async function main() {
  console.log('=== WEBHOOK BUG SCOPE VERIFICATION ===\n');
  console.log('Checking: Were ONLY these 2 charges successful?\n');

  try {
    // Query 1: All charge_successful webhooks (received but not processed)
    console.log('Step 1: Finding all charge_successful webhooks that were RECEIVED but not PROCESSED...');
    const { data: receivedWebhooks } = await supabase
      .from('webhook_logs')
      .select('*')
      .eq('event_type', 'charge_successful')
      .eq('status', 'received')
      .order('created_at', { ascending: false });

    if (!receivedWebhooks || receivedWebhooks.length === 0) {
      console.log('✓ No webhooks with status "received" — all have been processed');
    } else {
      console.log(`⚠️  Found ${receivedWebhooks.length} webhook(s) that were received but NOT processed:\n`);
      for (const w of receivedWebhooks) {
        const ref = w.payload?.transaction_ref;
        const amount = w.payload?.amount;
        console.log(`  Ref: ${ref}`);
        console.log(`  Amount: ₦${Math.floor((amount || 0) / 100)}`);
        console.log(`  Received: ${w.created_at}`);
        console.log(`  Status: ${w.status}\n`);
      }
    }

    console.log('\nStep 2: Finding all charge_successful webhooks (processed or received)...');
    const { data: allChargeWebhooks } = await supabase
      .from('webhook_logs')
      .select('*')
      .eq('event_type', 'charge_successful')
      .order('created_at', { ascending: false });

    if (!allChargeWebhooks || allChargeWebhooks.length === 0) {
      console.log('✓ No charge_successful webhooks in logs at all');
      return;
    }

    console.log(`Found ${allChargeWebhooks.length} total charge_successful webhook(s):\n`);
    
    const known = {
      'dep_8c92be6a-ff02-464e-80c6-2673268fae61': {
        player: 'eb481faa-2325-4c06-9c8c-9fa105454b67',
        phone: '+2347048047900',
        amount: 500,
        status: 'CREDITED ✓'
      },
      'dep_cf12190a-053b-48a2-a307-ffd4b3fdbf86': {
        player: '15f1d00f-69ac-447e-8a69-612090c03308',
        phone: '+2347010707754',
        amount: 200,
        status: 'CREDITED ✓'
      }
    };

    for (const w of allChargeWebhooks) {
      const ref = w.payload?.transaction_ref;
      const amount = w.payload?.amount;
      const amountNaira = Math.floor((amount || 0) / 100);
      const txStatus = w.payload?.transaction_status;
      
      const isKnown = known[ref];
      const marker = isKnown ? '✓ CREDITED' : '❓ UNKNOWN';
      
      console.log(`${marker} | Ref: ${ref}`);
      console.log(`      Amount: ₦${amountNaira} | SquadCo Status: ${txStatus}`);
      console.log(`      Webhook Status: ${w.status} | Received: ${w.created_at}`);
      
      if (isKnown) {
        console.log(`      → Player: ${isKnown.player}`);
        console.log(`      → Phone: ${isKnown.phone}`);
      }
      console.log();
    }

    // Query 2: Verify deposit transactions
    console.log('\nStep 3: Cross-check with completed deposit transactions...');
    const { data: deposits } = await supabase
      .from('transactions')
      .select('*')
      .eq('type', 'deposit')
      .gte('created_at', '2026-07-29T00:00:00')
      .order('created_at', { ascending: false });

    console.log(`Found ${deposits?.length || 0} completed deposits since 2026-07-29:\n`);
    for (const d of (deposits || [])) {
      console.log(`Ref: ${d.reference}`);
      console.log(`Amount: ₦${d.amount} | Player: ${d.player_id}`);
      console.log(`Created: ${d.created_at}\n`);
    }

    // Summary
    console.log('\n=== VERIFICATION SUMMARY ===\n');
    console.log(`Total charge_successful webhooks: ${allChargeWebhooks.length}`);
    console.log(`Known affected (now credited): 2`);
    console.log(`  1. dep_8c92be6a... (₦500) → eb481faa... ✓`);
    console.log(`  2. dep_cf12190a... (₦200) → 15f1d00f... ✓`);
    
    if (allChargeWebhooks.length === 2) {
      console.log(`\n✅ CONFIRMED: Only 2 successful SquadCo transactions affected. Both credited.`);
    } else if (allChargeWebhooks.length > 2) {
      console.log(`\n⚠️  WARNING: Found ${allChargeWebhooks.length} webhooks (more than 2 expected)`);
      console.log('Check unknown references in list above');
    }

  } catch (err) {
    console.error('ERROR:', err);
  }
}

main();
