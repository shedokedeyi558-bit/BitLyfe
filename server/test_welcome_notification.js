/**
 * Test Script: Welcome Notification on Player Registration
 * 
 * This script:
 * 1. Registers a NEW test account
 * 2. Immediately queries the notifications table for that player_id
 * 3. Reports if a welcome notification exists
 */

const { createClient } = require('@supabase/supabase-js');

// Supabase credentials from .env
const SUPABASE_URL = 'https://fgwqzhhhcyqfpvlquyxc.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZnd3F6aGhoY3lxZnB2bHF1eXhjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjkyMDQwOSwiZXhwIjoyMDk4NDk2NDA5fQ.DBdul1yvVBEYeYRdIT87V89vLE2xOMxivoZiQmK_SMk';
const BACKEND_URL = 'http://localhost:5000'; // Backend server URL

// Create Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function runTest() {
  try {
    console.log('🧪 Starting Welcome Notification Test\n');

    // Generate unique test data
    const timestamp = Date.now();
    const testPhone = `+234810577580${String(timestamp).slice(-4)}`;
    const testName = `TestPlayer_${timestamp}`;
    const testPassword = 'test123456';

    console.log(`📝 Test Account Details:`);
    console.log(`   Phone: ${testPhone}`);
    console.log(`   Name: ${testName}`);
    console.log(`   Password: ${testPassword}\n`);

    // Step 1: Register new player via API
    console.log(`🔑 Step 1: Registering new player via POST /api/auth/register...`);
    const registerResponse = await fetch(`${BACKEND_URL}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phone: testPhone,
        name: testName,
        password: testPassword,
      }),
    });

    const registerData = await registerResponse.json();
    console.log(`   Response Status: ${registerResponse.status}`);
    console.log(`   Response Body:`, JSON.stringify(registerData, null, 2));

    if (!registerData.success) {
      throw new Error(`Registration failed: ${JSON.stringify(registerData)}`);
    }

    const playerId = registerData.data.player.id;
    console.log(`   ✅ Player registered successfully!`);
    console.log(`   Player ID: ${playerId}\n`);

    // Step 2: Wait a moment for any async operations
    console.log(`⏳ Waiting 1 second for async operations...\n`);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Step 3: Query notifications table directly
    console.log(`🔍 Step 2: Querying notifications table for player_id = '${playerId}'...`);
    const { data: notifications, error: notifError } = await supabase
      .from('notifications')
      .select('*')
      .eq('player_id', playerId);

    if (notifError) {
      throw new Error(`Notifications query failed: ${notifError.message}`);
    }

    console.log(`   Total notifications found: ${notifications.length}`);

    if (notifications.length === 0) {
      console.log(`   ❌ NO NOTIFICATIONS FOUND!\n`);

      // Verify account exists
      console.log(`📋 Verifying account exists in players table...`);
      const { data: player, error: playerError } = await supabase
        .from('players')
        .select('*')
        .eq('phone', testPhone);

      if (playerError) {
        throw new Error(`Players query failed: ${playerError.message}`);
      }

      if (player && player.length > 0) {
        console.log(`   ✅ Account exists in players table:`);
        console.log(`      ID: ${player[0].id}`);
        console.log(`      Phone: ${player[0].phone}`);
        console.log(`      Name: ${player[0].name}`);
        console.log(`      Created: ${player[0].created_at}\n`);
      } else {
        console.log(`   ❌ Account NOT found in players table!\n`);
      }

      console.log(`⚠️  RESULT: Welcome notification was NOT created for the new player.`);
    } else {
      console.log(`   ✅ NOTIFICATIONS FOUND!\n`);
      console.log(`📋 Notification Details:`);
      
      notifications.forEach((notif, index) => {
        console.log(`\n   Notification ${index + 1}:`);
        console.log(`      ID: ${notif.id}`);
        console.log(`      Type: ${notif.type}`);
        console.log(`      Title: ${notif.title}`);
        console.log(`      Message: ${notif.message}`);
        console.log(`      Read: ${notif.read}`);
        console.log(`      Created At: ${notif.created_at}`);
      });

      console.log(`\n✅ RESULT: Welcome notification WAS created for the new player.`);
    }

    console.log(`\n📊 Test Complete\n`);

  } catch (error) {
    console.error(`❌ ERROR: ${error.message}`);
    process.exit(1);
  }
}

// Run the test
runTest().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
