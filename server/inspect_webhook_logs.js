/**
 * Inspect raw webhook_logs to see what was actually stored
 */
require('dotenv').config({ path: '.env' });
const supabase = require('./src/db/supabase');

async function main() {
  console.log('=== INSPECTING WEBHOOK LOGS ===\n');

  try {
    const { data: logs } = await supabase
      .from('webhook_logs')
      .select('*')
      .eq('event_type', 'charge_successful')
      .order('created_at', { ascending: false });

    console.log(`Found ${logs?.length || 0} charge_successful webhooks:\n`);

    for (const log of (logs || [])) {
      console.log(`─────────────────────────────────────────`);
      console.log(`Created: ${log.created_at}`);
      console.log(`Status: ${log.status}`);
      console.log(`Payload:`, JSON.stringify(log.payload, null, 2));
      console.log();
    }

  } catch (err) {
    console.error('ERROR:', err);
  }
}

main();
