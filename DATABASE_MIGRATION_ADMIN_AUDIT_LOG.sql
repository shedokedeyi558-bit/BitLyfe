-- Migration: Admin Audit Log Table
-- Run this in your Supabase SQL editor before deploying the resolve-stuck-entry endpoint.
--
-- Records deliberate admin actions that touch real money or player state after-the-fact.
-- Currently used by POST /api/admin/predictions/:id/resolve-stuck-entry.

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id      UUID NOT NULL,                  -- references admins.id or players.id (unified system)
  admin_email   TEXT NOT NULL,                  -- denormalised for legibility in queries
  action        TEXT NOT NULL,                  -- e.g. 'resolve_stuck_prediction_entry'
  entity_type   TEXT NOT NULL,                  -- e.g. 'prediction_participation'
  entity_id     UUID,                           -- the row that was mutated
  player_id     UUID REFERENCES players(id),    -- the player affected
  resolution    TEXT,                           -- 'record_answer' | 'refund'
  notes         TEXT,                           -- free-form admin note (required for money ops)
  payload       JSONB,                          -- full before/after snapshot for audit trail
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin_id   ON admin_audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_player_id  ON admin_audit_log(player_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action     ON admin_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log(created_at DESC);
