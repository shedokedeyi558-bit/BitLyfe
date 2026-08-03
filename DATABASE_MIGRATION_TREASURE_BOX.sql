-- Treasure Box game mode settings (single row, id=1)
-- rtp is NOT stored — computed on read as (pop_limit / total_slots) * payout_multiplier

CREATE TABLE IF NOT EXISTS treasure_box_settings (
  id                INTEGER PRIMARY KEY DEFAULT 1,
  total_slots       INTEGER NOT NULL DEFAULT 25,      -- total boxes/balloons to reveal from
  pop_limit         INTEGER NOT NULL DEFAULT 3,       -- max pops a player gets per attempt
  payout_multiplier NUMERIC(6,2) NOT NULL DEFAULT 6,  -- win pays stake * payout_multiplier
  min_stake         INTEGER NOT NULL DEFAULT 100,
  max_stake         INTEGER NOT NULL DEFAULT 1000,
  is_available      BOOLEAN NOT NULL DEFAULT false    -- manual on/off switch
);

INSERT INTO treasure_box_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Verify
SELECT * FROM treasure_box_settings WHERE id = 1;
