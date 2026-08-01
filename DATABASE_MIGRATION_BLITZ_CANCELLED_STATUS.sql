-- Add 'cancelled' to blitz_tournaments.status CHECK constraint
-- Required for POST /api/admin/blitz/:id/cancel endpoint

ALTER TABLE blitz_tournaments
  DROP CONSTRAINT IF EXISTS blitz_tournaments_status_check;

ALTER TABLE blitz_tournaments
  ADD CONSTRAINT blitz_tournaments_status_check
  CHECK (status IN ('draft', 'registration', 'active', 'scoring', 'completed', 'cancelled'));
