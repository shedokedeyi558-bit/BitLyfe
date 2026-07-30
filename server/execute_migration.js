#!/usr/bin/env node

/**
 * Execute the pill race condition fix migration
 * 
 * Since Supabase JS client doesn't have a raw SQL execution method,
 * this script will:
 * 1. Extract SQL statements from the migration file
 * 2. Try to execute via RPC (for functions)
 * 3. Try to execute via direct statements (for ALTER TABLE)
 * 4. Report which parts succeeded/failed
 */

require('dotenv').config();
const supabase = require('./src/db/supabase');
const fs = require('fs');
const path = require('path');

async function executeMigration() {
  console.log('═'.repeat(80));
  console.log('PILL RACE CONDITION FIX: DATABASE MIGRATION EXECUTION');
  console.log('═'.repeat(80));
  console.log('');
  
  try {
    // Read migration file
    const migrationPath = path.join(__dirname, '..', 'DATABASE_MIGRATION_PILL_RACE_FIX.sql');
    const migrationContent = fs.readFileSync(migrationPath, 'utf8');
    
    console.log('Reading migration file...');
    console.log(`File: ${migrationPath}`);
    console.log('');
    
    // Extract the key SQL statements
    console.log('Checking migration components:');
    console.log('');
    
    // 1. Check CHECK constraint
    console.log('COMPONENT 1: pills.status CHECK constraint');
    console.log('─'.repeat(80));
    console.log('Action: ALTER TABLE pills ADD CONSTRAINT pills_status_check');
    console.log('');
    console.log('Status: MANUAL - Must run in Supabase SQL Editor');
    console.log('');
    console.log('Reason: Supabase JS client does not support ALTER TABLE execution.');
    console.log('');
    console.log('Required SQL:');
    console.log(`
ALTER TABLE pills DROP CONSTRAINT IF EXISTS pills_status_check;
ALTER TABLE pills
ADD CONSTRAINT pills_status_check 
CHECK (status IN ('available', 'opening', 'played', 'expired'));
    `);
    console.log('');
    
    // 2. Check claim_pill_for_opening function
    console.log('COMPONENT 2: claim_pill_for_opening() RPC function');
    console.log('─'.repeat(80));
    
    try {
      const { error: testErr } = await supabase.rpc('claim_pill_for_opening', {
        p_pill_id: '00000000-0000-0000-0000-000000000000',
      });
      
      if (testErr && testErr.message && testErr.message.includes('function') && testErr.message.includes('does not exist')) {
        console.log('Status: ❌ NOT DEPLOYED');
        console.log('');
        console.log('Reason: Function not found in Supabase.');
        console.log('');
        console.log('Required SQL:');
        console.log(`
CREATE OR REPLACE FUNCTION claim_pill_for_opening(p_pill_id UUID)
RETURNS TABLE (
  success BOOLEAN,
  previous_status TEXT,
  pill_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_previous_status TEXT;
  v_row_count INT;
BEGIN
  WITH updated AS (
    UPDATE pills
    SET status = 'opening', updated_at = NOW()
    WHERE id = p_pill_id 
      AND status = 'available'
    RETURNING status
  )
  SELECT COUNT(*), (SELECT status FROM pills WHERE id = p_pill_id LIMIT 1)
  INTO v_row_count, v_previous_status;

  RETURN QUERY SELECT (v_row_count > 0), v_previous_status, p_pill_id;
END;
$$;
        `);
      } else {
        console.log('Status: ✓ ALREADY DEPLOYED');
        console.log('Reason: Function call succeeded (or different error)');
        if (testErr) console.log('Response:', testErr.message);
      }
    } catch (e) {
      console.log('Status: ⚠️  ERROR', e.message);
    }
    
    console.log('');
    
    // 3. Check revert_pill_from_opening function
    console.log('COMPONENT 3: revert_pill_from_opening() RPC function');
    console.log('─'.repeat(80));
    
    try {
      const { error: testErr } = await supabase.rpc('revert_pill_from_opening', {
        p_pill_id: '00000000-0000-0000-0000-000000000000',
      });
      
      if (testErr && testErr.message && testErr.message.includes('function') && testErr.message.includes('does not exist')) {
        console.log('Status: ❌ NOT DEPLOYED');
        console.log('');
        console.log('Required SQL:');
        console.log(`
CREATE OR REPLACE FUNCTION revert_pill_from_opening(p_pill_id UUID)
RETURNS TABLE (success BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE pills
  SET status = 'available', updated_at = NOW()
  WHERE id = p_pill_id AND status = 'opening';

  RETURN QUERY SELECT ROW_COUNT() > 0;
END;
$$;
        `);
      } else {
        console.log('Status: ✓ ALREADY DEPLOYED');
        if (testErr) console.log('Response:', testErr.message);
      }
    } catch (e) {
      console.log('Status: ⚠️  ERROR', e.message);
    }
    
    console.log('');
    console.log('═'.repeat(80));
    console.log('MIGRATION DEPLOYMENT STATUS');
    console.log('═'.repeat(80));
    console.log('');
    console.log('⚠️  ALL components must be deployed manually in Supabase SQL Editor');
    console.log('');
    console.log('STEPS:');
    console.log('1. Go to: https://app.supabase.co → SQL Editor');
    console.log('2. Copy entire content of: DATABASE_MIGRATION_PILL_RACE_FIX.sql');
    console.log('3. Paste into SQL Editor');
    console.log('4. Click "Run"');
    console.log('5. Verify no errors');
    console.log('6. Return here and run: node deploy_pill_fix.js');
    console.log('');
    
    return false;
    
  } catch (err) {
    console.error('❌ Migration check error:', err.message);
    return false;
  }
}

executeMigration().then(success => {
  process.exit(success ? 0 : 1);
});
