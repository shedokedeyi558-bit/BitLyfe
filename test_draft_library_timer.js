/**
 * Test TASK 4: Draft Library Timer Optional
 * Tests that POST /api/admin/specials-bank/library accepts requests WITHOUT timer_seconds
 */

const http = require('http');

// Admin auth middleware returns admin object on valid request
// For testing, we'll bypass actual auth and just test the route logic

async function testLibraryEndpoint() {
  console.log('=== Testing Draft Library Timer Optional (TASK 4) ===\n');

  // Step 0: Get admin token
  console.log('Step 0: Admin login to get token...');
  const loginBody = JSON.stringify({
    email: 'shedokedeyi558@gmail.com',
    password: 'Sapphire558'
  });

  const loginOptions = {
    hostname: 'localhost',
    port: 5000,
    path: '/api/auth/admin-login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(loginBody)
    }
  };

  let adminToken;
  try {
    const loginRes = await makeRequest(loginOptions, loginBody);
    if (loginRes.statusCode === 200 && loginRes.body.data?.token) {
      adminToken = loginRes.body.data.token;
      console.log(`✓ Got admin token: ${adminToken.substring(0, 30)}...\n`);
    } else {
      console.log(`✗ Admin login failed: ${loginRes.statusCode}`);
      console.log(JSON.stringify(loginRes.body, null, 2));
      process.exit(1);
    }
  } catch (err) {
    console.log(`✗ Login error: ${err.message}`);
    process.exit(1);
  }

  // Scenario 1: POST library question WITHOUT timer
  console.log('Scenario 1: Create library question WITHOUT timer_seconds');
  const body1 = JSON.stringify({
    question: 'What is 2 + 2?',
    correct_answer: '4',
    format: 'type_answer',
    case_sensitive: false,
    color: '#8B5CF6'
  });

  const options1 = {
    hostname: 'localhost',
    port: 5000,
    path: '/api/admin/specials-bank/library',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body1),
      'Authorization': `Bearer ${adminToken}`
    }
  };

  try {
    const res1 = await makeRequest(options1, body1);
    console.log(`Status: ${res1.statusCode}`);
    console.log(`Response: ${JSON.stringify(res1.body, null, 2)}`);
    
    if (res1.statusCode === 201) {
      const data = res1.body.data.question;
      console.log(`✓ Question created: ID=${data.id}`);
      console.log(`  timer_seconds in response: ${data.timer_seconds}`);
      if (data.timer_seconds === null) {
        console.log('  ✓ Timer correctly stored as NULL (not defaulted to 30)');
      } else if (data.timer_seconds === undefined) {
        console.log('  ✓ Timer correctly omitted from response');
      }
    } else {
      console.log('✗ Failed to create question');
    }
  } catch (err) {
    console.log(`✗ Error: ${err.message}`);
  }

  console.log('\n---\n');

  // Scenario 2: POST library question WITH timer (backward compatibility)
  console.log('Scenario 2: Create library question WITH timer_seconds (backward compat)');
  const body2 = JSON.stringify({
    question: 'What is the capital of France?',
    correct_answer: 'Paris',
    format: 'multiple_choice',
    timer_seconds: 45,
    case_sensitive: false
  });

  const options2 = {
    hostname: 'localhost',
    port: 5000,
    path: '/api/admin/specials-bank/library',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body2),
      'Authorization': `Bearer ${adminToken}`
    }
  };

  try {
    const res2 = await makeRequest(options2, body2);
    console.log(`Status: ${res2.statusCode}`);
    console.log(`Response: ${JSON.stringify(res2.body, null, 2)}`);
    
    if (res2.statusCode === 201) {
      const data = res2.body.data.question;
      console.log(`✓ Question created: ID=${data.id}`);
      console.log(`  timer_seconds in response: ${data.timer_seconds}`);
      if (data.timer_seconds === 45) {
        console.log('  ✓ Timer correctly stored as 45 (not overwritten)');
      }
    } else {
      console.log('✗ Failed to create question');
    }
  } catch (err) {
    console.log(`✗ Error: ${err.message}`);
  }

  console.log('\n=== Test Complete ===');
  process.exit(0);
}

function makeRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Run after a short delay to ensure server is ready
setTimeout(testLibraryEndpoint, 1000);
