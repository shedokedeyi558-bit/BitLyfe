const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase
const supabase = createClient(
  'https://fgwqzhhhcyqfpvlquyxc.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZnd3F6aGhoY3lxZnB2bHF1eXhjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjkyMDQwOSwiZXhwIjoyMDk4NDk2NDA5fQ.DBdul1yvVBEYeYRdIT87V89vLE2xOMxivoZiQmK_SMk'
);

async function investigatePillIssue() {
  console.log('='.repeat(80));
  console.log('INVESTIGATING TYPE-ANSWER PILL ISSUE');
  console.log('='.repeat(80));
  console.log();

  try {
    // Step 1: Query pills table for type_answer pills with "name" in question
    console.log('STEP 1: Querying pills table for type_answer format with "name" in question');
    console.log('-'.repeat(80));
    
    const { data: pills, error: pillsError } = await supabase
      .from('pills')
      .select('id, question, format, timer_seconds, entry_fee, prize, status, created_at, updated_at')
      .eq('format', 'type_answer')
      .ilike('question', '%name%')
      .order('created_at', { ascending: false })
      .limit(20);

    if (pillsError) {
      console.error('ERROR querying pills:', pillsError);
    } else {
      console.log(`Found ${pills.length} pills matching criteria:`);
      console.log(JSON.stringify(pills, null, 2));
    }
    console.log();

    // Step 2: Query pill_plays table for the specific pill ID we found
    console.log('STEP 2: Querying pill_plays for the "What is my name" pill');
    console.log('-'.repeat(80));
    
    const targetPillId = '7ec486af-3df2-4d33-a1eb-31c30de20f14';
    const { data: targetPlays, error: targetPlaysError } = await supabase
      .from('pill_plays')
      .select(`
        id, 
        pill_id, 
        player_id, 
        won, 
        created_at
      `)
      .eq('pill_id', targetPillId)
      .order('created_at', { ascending: false });

    if (targetPlaysError) {
      console.error('ERROR querying target pill_plays:', targetPlaysError);
    } else {
      console.log(`Found ${targetPlays.length} plays for pill "${targetPillId}":`);
      console.log(JSON.stringify(targetPlays, null, 2));
    }
    console.log();

    // Step 3: Get all recent pill_plays to show context
    console.log('STEP 3: Querying last 30 pill_plays (any format) for context');
    console.log('-'.repeat(80));
    
    const { data: allPlays, error: allPlaysError } = await supabase
      .from('pill_plays')
      .select(`
        id, 
        pill_id, 
        player_id, 
        won, 
        created_at,
        pills (id, question, format, timer_seconds)
      `)
      .order('created_at', { ascending: false })
      .limit(30);

    if (allPlaysError) {
      console.error('ERROR querying all pill_plays:', allPlaysError);
    } else {
      console.log(`Last 30 pill_plays (all formats):`);
      console.log(JSON.stringify(allPlays, null, 2));
    }
    console.log();

    // Step 4: Check the pill_plays table structure by getting raw RPC info
    console.log('STEP 4: Checking pills table for related timeout/submission data');
    console.log('-'.repeat(80));
    
    // Let's get info on all type_answer pills to see which ones exist
    const { data: allTypePills, error: allTypeError } = await supabase
      .from('pills')
      .select('id, question, format, timer_seconds, status, entry_fee, prize, created_at')
      .eq('format', 'type_answer')
      .order('created_at', { ascending: false })
      .limit(10);

    if (allTypeError) {
      console.error('ERROR querying all type_answer pills:', allTypeError);
    } else {
      console.log(`All type_answer pills in database (last 10):`);
      console.log(JSON.stringify(allTypePills, null, 2));
    }

    console.log();
    console.log('='.repeat(80));
    console.log('INVESTIGATION COMPLETE');
    console.log('='.repeat(80));

  } catch (error) {
    console.error('Unexpected error:', error);
  }
}

investigatePillIssue();
