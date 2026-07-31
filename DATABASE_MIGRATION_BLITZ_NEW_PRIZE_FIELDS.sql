-- Add first_place_percent and third_place_discount_percent to blitz_tournaments
-- first_place_percent: integer 1-100, % of actual entry revenue paid to 1st place
-- third_place_discount_percent: integer 1-99, % discount on next entry for 3rd place
-- Both nullable — NULL means tournament uses legacy payout_distribution system

ALTER TABLE blitz_tournaments
  ADD COLUMN IF NOT EXISTS first_place_percent INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS third_place_discount_percent INTEGER DEFAULT NULL;
