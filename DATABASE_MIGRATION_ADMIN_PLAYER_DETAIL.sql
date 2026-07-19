-- Migration: Admin player detail expansion
-- Run in Supabase SQL editor.

-- ─── 1. player_admin_notes ──────────────────────────────────────────────────
-- Free-text notes on a player. Append-only (never edited/deleted by design).
-- Multiple notes per player, each stamped with admin and timestamp.

CREATE TABLE IF NOT EXISTS player_admin_notes (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id  UUID REFERENCES players(id) ON DELETE CASCADE NOT NULL,
  admin_id   UUID NOT NULL,
  admin_email TEXT NOT NULL,
  note       TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_admin_notes_player_id ON player_admin_notes(player_id);
CREATE INDEX IF NOT EXISTS idx_player_admin_notes_created_at ON player_admin_notes(created_at DESC);

-- ─── 2. admin_audit_log already exists ──────────────────────────────────────
-- Ban/unban actions will be logged to admin_audit_log (action = 'ban' | 'unban')
-- using the same pattern as resolve_stuck_prediction_entry.
-- No new table needed.

-- Verify
SELECT column_name FROM information_schema.columns
WHERE table_name = 'player_admin_notes'
ORDER BY ordinal_position;
