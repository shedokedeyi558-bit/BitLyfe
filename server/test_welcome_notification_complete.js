#!/usr/bin/env node
/**
 * Complete Test: Welcome Notification End-to-End Flow
 * 
 * Tests:
 * 1. Register a new player
 * 2. Query database to confirm notification row exists
 * 3. Call GET /api/notifications endpoint as the player to verify it's returned
 * 4. Verify the notification matches expected values
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://fgwqzhhhcyqfpvlquyxc.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZnd3F6aGhoY3lxZnB2bHF1eXhjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjkyMDQwOSwiZXhwIjoyMDk4NDk2NDA5fQ.DBdul1yvVBEYeYRdIT87V89vLE2xOMxivoZiQmK_SMk';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function runTest() {
  try {
    console.log('🧪 Welcome Notification End-to-End Test\n');

    // Generate unique test data
    const timestamp = Date.now();
    const testPhone = `+234810577580${String(timestamp).slice(-4)}`;
    const testName = `TestPlayer_${timestamp}`;
    const testPassword = 'test123456';

    console.log('📝 Test Account:');
    console.log(`   Phone: ${testPhone}`);
    console.log(`   Name: ${testName}\n`);

    // ── STEP 1: Register via API ──────────────────────────────────────────────
    console.log('📌 STEP 1: Register new player');
    console.log('-'.repeat(60));
    
    const registerResponse = await fetch(`${BACKEND_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: testPhone,
        name: testName,
        password: testPassword,
      }),
    });

    const registerData = await registerResponse.json();
    
    if (!registerData.success) {
      throw new Error(`Registration failed: ${registerData.error}`);
    }

    const playerId = registerData.data.player.id;
    const token = registerData.data.token;

    console.log(`✅ Registration successful`);
    console.log(`   Player ID: ${playerId}`);
    console.log(`   Token length: ${token.length} chars\n`);

    // ── STEP 2: Wait for async operations ──────────────────────────────────────
    console.log('⏳ Waiting 1 second for notification creation...\n');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // ── STEP 3: Query database directly (as service) ──────────────────────────
    console.log('📌 STEP 2: Query database for welcome notification');
    console.log('-'.repeat(60));
    
    const { data: dbNotifications, error: dbError } = await supabase
      .from('notifications')
      .select('*')
      .eq('player_id', playerId);

    if (dbError) {
      throw new Error(`Database query failed: ${dbError.message}`);
    }

    console.log(`   Query: SELECT * FROM notifications WHERE player_id = '${playerId}'`);
    console.log(`   Results: ${dbNotifications.length} row(s) found`);

    if (dbNotifications.length === 0) {
      console.log(`   ❌ NO NOTIFICATION IN DATABASE!\n`);
      return false;
    }

    console.log(`   ✅ Notification found in database`);
    const dbNotif = dbNotifications[0];
    console.log(`      Type: ${dbNotif.type}`);
    console.log(`      Title: ${dbNotif.title}`);
    console.log(`      Read: ${dbNotif.read}\n`);

    // ── STEP 4: Call /api/notifications as the player ──────────────────────────
    console.log('📌 STEP 3: Fetch notifications via API (as player)');
    console.log('-'.repeat(60));
    
    const apiResponse = await fetch(`${BACKEND_URL}/api/notifications`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const apiData = await apiResponse.json();

    console.log(`   Endpoint: GET /api/notifications`);
    console.log(`   Status: ${apiResponse.status}`);
    console.log(`   Success: ${apiData.success}`);
    console.log(`   Notifications returned: ${(apiData.data?.notifications || []).length}`);
    console.log(`   Unread count: ${apiData.data?.unread_count}\n`);

    if (!apiData.success) {
      console.log(`   ❌ API call failed: ${apiData.error}\n`);
      return false;
    }

    if (!apiData.data?.notifications || apiData.data.notifications.length === 0) {
      console.log(`   ❌ NO NOTIFICATIONS RETURNED BY API!\n`);
      console.log(`   Database has notification, but API didn't return it.\n`);
      console.log(`   Possible causes:`);
      console.log(`   - Authentication middleware issue`);
      console.log(`   - Query filtering issue`);
      console.log(`   - Permissions/RLS policy blocking access\n`);
      return false;
    }

    const apiNotif = apiData.data.notifications[0];
    console.log(`   ✅ Notification returned by API`);
    console.log(`      Type: ${apiNotif.type}`);
    console.log(`      Title: ${apiNotif.title}`);
    console.log(`      Message: ${apiNotif.message}`);
    console.log(`      Read: ${apiNotif.read}\n`);

    // ── STEP 5: Verify match ──────────────────────────────────────────────────
    console.log('📌 STEP 4: Verification');
    console.log('-'.repeat(60));

    const isWelcomeNotification = 
      apiNotif.type === 'announcement' &&
      apiNotif.title === 'Welcome to BitLyfe! 🎉' &&
      apiNotif.read === false;

    if (isWelcomeNotification) {
      console.log(`✅ Welcome notification verified!`);
      console.log(`   - Type is 'announcement': YES`);
      console.log(`   - Title is correct: YES`);
      console.log(`   - Not marked read: YES\n`);
      return true;
    } else {
      console.log(`⚠️  Notification returned but doesn't match expected welcome notification`);
      console.log(`   Expected title: 'Welcome to BitLyfe! 🎉'`);
      console.log(`   Got title: '${apiNotif.title}'`);
      console.log(`   Expected type: 'announcement'`);
      console.log(`   Got type: '${apiNotif.type}'\n`);
      return false;
    }

  } catch (error) {
    console.error(`\n❌ ERROR: ${error.message}\n`);
    return false;
  }
}

// Run test
runTest().then((success) => {
  console.log('📊 Test Summary:');
  console.log('-'.repeat(60));
  if (success) {
    console.log(`✅ PASS: Welcome notification flow is working correctly`);
    console.log(`   1. Notification created in database on registration`);
    console.log(`   2. Notification returned by API endpoint`);
    console.log(`   3. Notification has correct type and title\n`);
    process.exit(0);
  } else {
    console.log(`❌ FAIL: Welcome notification flow has issues`);
    console.log(`   See details above\n`);
    process.exit(1);
  }
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
