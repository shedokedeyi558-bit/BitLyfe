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
      .select('id, question, format, timer_seconds, created_at, updated_at')
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

    // Step 2: Query pill_plays table for recent type_answer entries
    console.log('STEP 2: Querying pill_plays table for recent type_answer plays');
    console.log('-'.repeat(80));
    
    const { data: plays, error: playsError } = await supabase
      .from('pill_plays')
      .select(`
        id, 
        pill_id, 
        player_id, 
        locked_at, 
        submitted_answer, 
        won, 
        created_at, 
        updated_at,
        pills (id, question, format, timer_seconds)
      `)
      .eq('pills.format', 'type_answer')
      .ilike('pills.question', '%name%')
      .order('created_at', { ascending: false })
      .limit(20);

    if (playsError) {
      console.error('ERROR querying pill_plays:', playsError);
    } else {
      console.log(`Found ${plays.length} pill_plays matching criteria:`);
      console.log(JSON.stringify(plays, null, 2));
    }
    console.log();

    // Step 3: Get all recent pill_plays to show context
    console.log('STEP 3: Querying last 20 pill_plays (any format) for context');
    console.log('-'.repeat(80));
    
    const { data: allPlays, error: allPlaysError } = await supabase
      .from('pill_plays')
      .select(`
        id, 
        pill_id, 
        player_id, 
        locked_at, 
        submitted_answer, 
        won, 
        created_at, 
        updated_at,
        pills (id, question, format, timer_seconds)
      `)
      .order('created_at', { ascending: false })
      .limit(20);

    if (allPlaysError) {
      console.error('ERROR querying all pill_plays:', allPlaysError);
    } else {
      console.log(`Last 20 pill_plays (all formats):`);
      console.log(JSON.stringify(allPlays, null, 2));
    }
    console.log();

    // Step 4: Search for plays where submitted_answer is not null but should be anomalous
    console.log('STEP 4: Querying pill_plays with specific anomaly patterns');
    console.log('-'.repeat(80));
    
    const { data: anomalies, error: anomaliesError } = await supabase
      .from('pill_plays')
      .select(`
        id, 
        pill_id, 
        player_id, 
        locked_at, 
        submitted_answer, 
        won, 
        created_at, 
        updated_at,
        pills (id, question, format, timer_seconds)
      `)
      .not('submitted_answer', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(30);

    if (anomaliesError) {
      console.error('ERROR querying anomalies:', anomaliesError);
    } else {
      console.log(`Found ${anomalies.length} pill_plays with submitted_answer NOT NULL:`);
      console.log(JSON.stringify(anomalies, null, 2));
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
