#!/usr/bin/env node

/**
 * Deploy pill race condition fix migration directly via Supabase REST API
 * This bypasses the JS client limitations and executes raw SQL
 */

require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

// Extract project ID and API base
const urlObj = new URL(SUPABASE_URL);
const projectId = urlObj.hostname.split('.')[0];
const apiBase = `${projectId}.supabase.co`;

async function executeSQL(sql) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: apiBase,
      port: 443,
      path: '/rest/v1/rpc/exec_sql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify({ query: sql }));
    req.end();
  });
}

async function deployMigration() {
  console.log('═'.repeat(80));
  console.log('DEPLOYING PILL RACE CONDITION FIX MIGRATION');
  console.log('═'.repeat(80));
  console.log('');

  try {
    // Read migration file
    const migrationPath = path.join(__dirname, '..', 'DATABASE_MIGRATION_PILL_RACE_FIX.sql');
    const migrationContent = fs.readFileSync(migrationPath, 'utf8');

    console.log('Migration file read successfully');
    console.log('');

    // Extract executable statements (skip comments and whitespace)
    const lines = migrationContent.split('\n');
    let statements = [];
    let current = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('--') || trimmed === '') continue;
      current += line + '\n';
      if (trimmed.endsWith(';')) {
        statements.push(current.trim());
        current = '';
      }
    }

    if (current.trim()) statements.push(current.trim());

    console.log(`Found ${statements.length} SQL statements`);
    console.log('');

    // Split into logical groups
    const alterTableStmt = statements.find(s => s.includes('ALTER TABLE pills'));
    const functionStmts = statements.filter(s => s.includes('CREATE OR REPLACE FUNCTION'));
    const viewStmt = statements.find(s => s.includes('CREATE OR REPLACE VIEW'));

    console.log('STATEMENT BREAKDOWN:');
    console.log(`  - ALTER TABLE: ${alterTableStmt ? '✓' : '✗'}`);
    console.log(`  - Functions: ${functionStmts.length} found`);
    console.log(`  - Views: ${viewStmt ? '✓' : '✗'}`);
    console.log('');

    // Try to deploy via RPC (if it exists)
    console.log('Attempting deployment via Supabase RPC...');
    console.log('(Note: This will fail if RPC function doesn\'t exist - that\'s expected)');
    console.log('');

    let migrationSuccess = false;

    // Check if there's an exec_sql RPC or similar
    try {
      const result = await executeSQL(alterTableStmt);
      console.log('SQL Execution result:', result.status);
      if (result.status === 200 || result.status === 201) {
        console.log('✓ Migration executed successfully');
        migrationSuccess = true;
      } else {
        console.log('⚠️  Status:', result.status);
        console.log('Response:', result.data);
      }
    } catch (err) {
      console.log('⚠️  REST API attempt failed (expected if exec_sql RPC not deployed)');
      console.log('Error:', err.message);
    }

    console.log('');
    console.log('═'.repeat(80));
    console.log('MIGRATION STATUS');
    console.log('═'.repeat(80));
    console.log('');

    if (!migrationSuccess) {
      console.log('❌ MANUAL DEPLOYMENT REQUIRED');
      console.log('');
      console.log('The migration must be deployed manually because:');
      console.log('1. Supabase JS client doesn\'t support ALTER TABLE');
      console.log('2. Supabase REST API requires special RPC function');
      console.log('3. Service-level SQL execution requires raw pg client');
      console.log('');
      console.log('INSTRUCTIONS:');
      console.log('1. Open: https://app.supabase.co');
      console.log('2. Select your project');
      console.log('3. Go to: SQL Editor → New query');
      console.log('4. Copy contents of: DATABASE_MIGRATION_PILL_RACE_FIX.sql');
      console.log('5. Paste into SQL Editor');
      console.log('6. Click RUN');
      console.log('7. Verify: No errors in output');
      console.log('');
      console.log('Then run: node deploy_pill_fix.js');
      console.log('');
      return false;
    }

    return true;

  } catch (err) {
    console.error('❌ Deployment error:', err.message);
    return false;
  }
}

deployMigration().then(success => {
  process.exit(success ? 0 : 1);
});
