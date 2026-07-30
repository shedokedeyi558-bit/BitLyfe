-- ════════════════════════════════════════════════════════════════════════════════
-- CRITICAL AUDIT: Check for repeated pill_plays (same pill_id for same player)
-- This should be structurally impossible due to UNIQUE(pill_id, player_id) constraint
-- ════════════════════════════════════════════════════════════════════════════════

-- REQUIREMENT 1: Find all pills that have MORE than one play record
-- (This should return 0 rows if the constraint is working)
SELECT 
  pill_id,
  COUNT(*) as play_count,
  ARRAY_AGG(player_id) as player_ids,
  ARRAY_AGG(id) as play_record_ids,
  ARRAY_AGG(won) as won_values,
  ARRAY_AGG(created_at) as created_times,
  ARRAY_AGG(locked_at) as locked_times
FROM pill_plays
GROUP BY pill_id
HAVING COUNT(*) > 1
ORDER BY play_count DESC;

-- REQUIREMENT 2: For the specific pack/player mentioned:
-- Find all pills in a "Standard Pills pack with 4 pills" 
-- Identify packs matching the profile and check their pills
SELECT 
  p.id as pack_id,
  p.name as pack_name,
  p.pack_type,
  COUNT(pi.id) as pill_count,
  STRING_AGG(DISTINCT pi.id::text, ', ') as pill_ids
FROM pill_packs p
LEFT JOIN pills pi ON pi.pack_id = p.id
WHERE p.pack_type = 'standard' 
  AND p.status = 'active'
GROUP BY p.id, p.name, p.pack_type
HAVING COUNT(pi.id) = 4;

-- REQUIREMENT 3: Check played status integrity
-- Find pills marked as 'played' and count how many distinct players have pill_plays entries for them
SELECT 
  pi.id as pill_id,
  pi.question,
  pi.pack_id,
  pi.status as pill_status,
  COUNT(DISTINCT pp.player_id) as distinct_players_with_entry,
  STRING_AGG(DISTINCT pp.player_id::text, ', ') as player_ids
FROM pills pi
LEFT JOIN pill_plays pp ON pp.pill_id = pi.id
WHERE pi.status = 'played'
GROUP BY pi.id, pi.question, pi.pack_id, pi.status
HAVING COUNT(DISTINCT pp.player_id) = 0
  OR COUNT(pp.id) != COUNT(DISTINCT pp.player_id)
ORDER BY pill_id;

-- REQUIREMENT 4: Check for pills that were played more than once by same player
-- (UNIQUE constraint should prevent this — this query should return 0)
SELECT 
  pp.pill_id,
  pp.player_id,
  COUNT(*) as duplicate_count,
  STRING_AGG(pp.id::text, ', ') as record_ids,
  MIN(pp.created_at) as first_play,
  MAX(pp.created_at) as last_play
FROM pill_plays pp
GROUP BY pp.pill_id, pp.player_id
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC;

-- REQUIREMENT 5: Check for integrity issue — does pill status match pill_plays reality?
-- Find pills with status='played' that have NO pill_plays entries
SELECT 
  pi.id,
  pi.question,
  pi.status,
  COUNT(pp.id) as play_count,
  pi.created_at
FROM pills pi
LEFT JOIN pill_plays pp ON pp.pill_id = pi.id
WHERE pi.status = 'played'
GROUP BY pi.id, pi.question, pi.status, pi.created_at
HAVING COUNT(pp.id) = 0;

-- REQUIREMENT 6: Reverse check — find pills with pill_plays entries but status != 'played'
SELECT 
  pi.id,
  pi.question,
  pi.status as current_status,
  COUNT(pp.id) as play_count,
  MIN(pp.created_at) as first_play_time,
  MAX(pp.locked_at) as last_submission_time
FROM pills pi
INNER JOIN pill_plays pp ON pp.pill_id = pi.id
WHERE pi.status != 'played'
GROUP BY pi.id, pi.question, pi.status
ORDER BY pi.id;

-- REQUIREMENT 7: Check money integrity — verify paid but answered pills
-- Players who opened a pill, had it charged, but may not have properly submitted
SELECT 
  pp.id,
  pp.pill_id,
  pp.player_id,
  pp.won,
  pp.locked_at,
  pp.submitted_answer,
  pi.status as pill_status,
  pi.question
FROM pill_plays pp
LEFT JOIN pills pi ON pi.id = pp.pill_id
WHERE pp.locked_at IS NULL  -- opened but never submitted
ORDER BY pp.created_at DESC
LIMIT 20;

-- REQUIREMENT 8: Summary report
SELECT 
  'Total unique pill_ids with plays' as metric,
  COUNT(DISTINCT pill_id) as count
FROM pill_plays

UNION ALL

SELECT 
  'Total pill_plays records',
  COUNT(*)
FROM pill_plays

UNION ALL

SELECT 
  'Pills marked as played',
  COUNT(*)
FROM pills
WHERE status = 'played'

UNION ALL

SELECT 
  'Pills with status=played but no plays records',
  COUNT(*)
FROM pills p
WHERE p.status = 'played'
  AND NOT EXISTS (SELECT 1 FROM pill_plays pp WHERE pp.pill_id = p.id)

UNION ALL

SELECT 
  'Plays records where locked_at IS NULL (opened but not answered)',
  COUNT(*)
FROM pill_plays
WHERE locked_at IS NULL;
