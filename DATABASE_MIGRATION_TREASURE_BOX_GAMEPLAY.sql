-- Treasure Box gameplay tables
-- treasure_box_settings already exists from previous migration

-- ─── treasure_boxes ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS treasure_boxes (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  total_slots          INTEGER NOT NULL,           -- snapshotted from settings at creation
  pop_limit            INTEGER NOT NULL,           -- snapshotted
  payout_multiplier    NUMERIC(6,2) NOT NULL,       -- snapshotted
  treasure_slot_index  INTEGER NOT NULL,           -- hidden — NEVER in player-facing responses until completed
  status               TEXT NOT NULL CHECK (status IN ('draft', 'available', 'claimed', 'completed'))
                         DEFAULT 'available',
  claimed_by           UUID REFERENCES players(id) ON DELETE SET NULL,
  stake                INTEGER DEFAULT NULL,       -- set at claim time
  payout               INTEGER DEFAULT NULL,       -- set only on win
  outcome              TEXT CHECK (outcome IN ('won', 'lost')),   -- null until completed
  created_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  claimed_at           TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  completed_at         TIMESTAMP WITH TIME ZONE DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_tb_status     ON treasure_boxes(status);
CREATE INDEX IF NOT EXISTS idx_tb_claimed_by ON treasure_boxes(claimed_by);

-- ─── treasure_box_pops ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS treasure_box_pops (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  box_id       UUID NOT NULL REFERENCES treasure_boxes(id) ON DELETE CASCADE,
  pop_number   INTEGER NOT NULL,     -- 1, 2, 3 ... pop_limit
  slot_index   INTEGER NOT NULL,     -- which slot the player chose
  was_treasure BOOLEAN NOT NULL,     -- true if slot_index === treasure_slot_index
  popped_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(box_id, pop_number),        -- one pop per number per box
  UNIQUE(box_id, slot_index)         -- one pop per slot per box (no repeats)
);

CREATE INDEX IF NOT EXISTS idx_tbp_box_id ON treasure_box_pops(box_id);

-- Verification
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('treasure_boxes', 'treasure_box_pops');
