-- Migration: Repair drifted current_participants counters on predictions
-- Run this in Supabase SQL editor.
--
-- current_participants is a denormalized counter that can drift from the real
-- participation count if the application had bugs (e.g. the race condition where
-- the participation insert failed silently after the counter was already incremented,
-- or the reverse). This sets every prediction's counter to the exact live count.

UPDATE predictions p
SET current_participants = (
  SELECT COUNT(*)
  FROM prediction_participations pp
  WHERE pp.prediction_id = p.id
);

-- Verify: show any predictions where the counter was wrong
-- (non-zero diff means the counter was repaired)
SELECT
  p.id,
  p.question,
  p.current_participants AS repaired_count,
  COUNT(pp.id) AS live_count,
  p.current_participants - COUNT(pp.id) AS was_off_by
FROM predictions p
LEFT JOIN prediction_participations pp ON pp.prediction_id = p.id
GROUP BY p.id, p.question, p.current_participants
HAVING p.current_participants != COUNT(pp.id)
ORDER BY ABS(p.current_participants - COUNT(pp.id)) DESC;

-- If that SELECT returns no rows, all counters were already correct.
