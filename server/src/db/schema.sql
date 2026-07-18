-- Triple Threat Quiz Game Database Schema
-- Run this in your Supabase SQL editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Players table
CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE,
  password_hash TEXT,
  phone TEXT UNIQUE,
  name TEXT,
  balance INT DEFAULT 0,
  bonus_balance INT DEFAULT 0,
  games_played INT DEFAULT 0,
  games_won INT DEFAULT 0,
  total_won INT DEFAULT 0,
  is_admin BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'active',
  referral_code TEXT UNIQUE,
  token_version INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add bonus_balance and referral_code to existing players table
ALTER TABLE players ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
ALTER TABLE players ADD COLUMN IF NOT EXISTS bonus_balance INT DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS token_version INT DEFAULT 0;

-- Questions table
CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  door_id INT,
  text TEXT NOT NULL,
  format TEXT CHECK (format IN ('multiple_choice', 'type_answer')) NOT NULL,
  difficulty TEXT,
  prize INT NOT NULL,
  time_limit INT DEFAULT 10,
  options JSONB,
  correct_answer TEXT NOT NULL,
  case_sensitive BOOLEAN DEFAULT false,
  spelling_tolerance TEXT DEFAULT 'strict',
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Doors table
CREATE TABLE IF NOT EXISTS doors (
  id INT PRIMARY KEY,
  status TEXT DEFAULT 'active',
  question_id UUID REFERENCES questions(id),
  prize INT,
  entry_fee INT DEFAULT 500
);

-- Seed 3 doors
INSERT INTO doors (id, status, prize, entry_fee)
VALUES (1, 'active', 1000, 500),
       (2, 'active', 2000, 500),
       (3, 'active', 5000, 500)
ON CONFLICT (id) DO NOTHING;

-- Game sessions table
CREATE TABLE IF NOT EXISTS game_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID REFERENCES players(id),
  phone TEXT,
  door_id INT REFERENCES doors(id),
  question_id UUID REFERENCES questions(id),
  status TEXT DEFAULT 'pending',
  player_answer TEXT,
  correct_answer TEXT,
  prize INT,
  entry_fee INT,
  played_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Transactions table
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID REFERENCES players(id),
  type TEXT NOT NULL,
  amount INT NOT NULL,
  description TEXT,
  reference TEXT,
  bonus_used INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add bonus_used to existing transactions table
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS bonus_used INT DEFAULT 0;

-- Withdrawal requests table
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID REFERENCES players(id),
  phone TEXT,
  amount INT NOT NULL,
  method TEXT,
  account_number TEXT,
  bank_name TEXT,                    -- display only (e.g. "GTBank")
  bank_code TEXT,                    -- Paystack numeric bank code (e.g. "058") — required for transfers
  recipient_code TEXT,               -- Paystack transfer recipient code — stored to avoid duplicate recipients
  transfer_reference TEXT,           -- idempotency key for the Paystack transfer
  transfer_failed_reason TEXT,       -- Paystack error message when status = transfer_failed
  -- status values:
  --   pending          — submitted by player, awaiting admin action
  --   transfer_failed  — admin approved but Paystack transfer failed; use retry-transfer or reject
  --   approved         — Paystack transfer succeeded; money is in transit
  --   rejected         — rejected by admin; balance refunded to player
  status TEXT DEFAULT 'pending',
  reject_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- App settings table (single row)
CREATE TABLE IF NOT EXISTS app_settings (
  id INT PRIMARY KEY DEFAULT 1,
  entry_fee INT DEFAULT 500,
  min_withdrawal INT DEFAULT 1000,
  max_daily_plays INT DEFAULT 20,
  new_user_bonus INT DEFAULT 0,
  auto_rotate BOOLEAN DEFAULT false,
  auto_rotate_interval INT DEFAULT 30,
  auto_approve_withdrawals BOOLEAN DEFAULT false,
  auto_approve_limit INT DEFAULT 1000,
  game_name TEXT DEFAULT 'Triple Threat',
  primary_color TEXT DEFAULT '#00FF66',
  game_kill_switch BOOLEAN DEFAULT false,
  payout_bank_name TEXT,
  payout_account_name TEXT,
  payout_account_number TEXT
);

-- Seed default settings
INSERT INTO app_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Admins table
CREATE TABLE IF NOT EXISTS admins (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);

-- Challenges table
CREATE TABLE IF NOT EXISTS challenges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  question_type TEXT CHECK (question_type IN ('prediction', 'trivia', 'live_event')) NOT NULL,
  correct_answer TEXT,
  stake_amount INT NOT NULL,
  prize_pool INT,
  max_participants INT NOT NULL DEFAULT 10,
  current_participants INT DEFAULT 0,
  status TEXT CHECK (status IN ('draft', 'active', 'paused', 'locked', 'ended', 'closed')) DEFAULT 'draft',
  starts_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  countdown_duration INT DEFAULT 60,
  ends_at TIMESTAMP WITH TIME ZONE,
  answer_reveal_at TIMESTAMP WITH TIME ZONE,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Challenge participations table
CREATE TABLE IF NOT EXISTS challenge_participations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  challenge_id UUID REFERENCES challenges(id),
  player_id UUID REFERENCES players(id),
  player_answer TEXT NOT NULL,
  is_correct BOOLEAN,
  amount_won INT DEFAULT 0,
  participated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(challenge_id, player_id)
);

-- Indexes for challenges
CREATE INDEX IF NOT EXISTS idx_challenges_status ON challenges(status);
CREATE INDEX IF NOT EXISTS idx_challenges_created_by ON challenges(created_by);
CREATE INDEX IF NOT EXISTS idx_challenges_ends_at ON challenges(ends_at);
CREATE INDEX IF NOT EXISTS idx_challenge_participations_challenge_id ON challenge_participations(challenge_id);
CREATE INDEX IF NOT EXISTS idx_challenge_participations_player_id ON challenge_participations(player_id);

-- Site content table (for terms of service, etc.)
CREATE TABLE IF NOT EXISTS site_content (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key TEXT UNIQUE NOT NULL,
  content TEXT NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Seed default terms of service
INSERT INTO site_content (key, content)
VALUES ('terms', 'Welcome to BitLyfe! By using our platform, you agree to the following terms and conditions:

1. ELIGIBILITY: You must be at least 18 years old to use BitLyfe.

2. ACCOUNT SECURITY: You are responsible for maintaining the security of your account credentials.

3. GAME RULES: All game outcomes are final. BitLyfe reserves the right to void fraudulent plays.

4. WALLET & PAYMENTS: Deposits and withdrawals are processed through Paystack. Minimum withdrawal is ₦1,000.

5. FAIR PLAY: Any attempt to cheat, exploit bugs, or manipulate the system will result in account suspension and forfeiture of funds.

6. PRIVACY: We collect and store your phone number and transaction history. We do not share your data with third parties without consent.

7. REFUNDS: Entry fees for completed games are non-refundable.

8. SERVICE AVAILABILITY: BitLyfe may be temporarily unavailable for maintenance. We are not liable for losses due to downtime.

9. MODIFICATIONS: We reserve the right to modify these terms at any time. Continued use constitutes acceptance.

10. CONTACT: For support, contact us at support@bitlyfe.com.

Last updated: 2026-07-03')
ON CONFLICT (key) DO NOTHING;

-- Webhook logs table
CREATE TABLE IF NOT EXISTS webhook_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT DEFAULT 'received',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Error logs table
CREATE TABLE IF NOT EXISTS error_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  message TEXT NOT NULL,
  stack TEXT,
  route TEXT,
  method TEXT,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_webhook_logs_event_type ON webhook_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_error_logs_timestamp ON error_logs(timestamp);

-- ─── PILL PACKS TABLE ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pill_packs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  category VARCHAR(50),
  status TEXT CHECK (status IN ('active', 'inactive', 'draft')) DEFAULT 'draft',
  entry_fee DECIMAL(10,2),   -- pack-level fee: all pills in this pack share this price
  prize DECIMAL(10,2),       -- pack-level prize: all pills in this pack share this reward
  is_vip BOOLEAN DEFAULT false,  -- legacy VIP flag — superseded by pack_type
  pack_type TEXT DEFAULT 'standard', -- 'standard' | 'special' (special = exam-style)
  question_count INTEGER,    -- special only: how many questions to draw per attempt (5-20)
  total_time_seconds INTEGER, -- special only: one shared timer for the whole exam
  required_correct INTEGER,  -- special only: pass threshold (must be <= question_count)
  entry_window_end TIMESTAMP WITH TIME ZONE, -- special only: when entries close
  is_featured BOOLEAN DEFAULT false, -- only one standard pack featured at a time
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Migration: add new columns to existing pill_packs table
ALTER TABLE pill_packs ADD COLUMN IF NOT EXISTS entry_fee DECIMAL(10,2);
ALTER TABLE pill_packs ADD COLUMN IF NOT EXISTS prize DECIMAL(10,2);
ALTER TABLE pill_packs ADD COLUMN IF NOT EXISTS is_vip BOOLEAN DEFAULT false;
ALTER TABLE pill_packs ADD COLUMN IF NOT EXISTS pack_type TEXT DEFAULT 'standard';
ALTER TABLE pill_packs ADD COLUMN IF NOT EXISTS question_count INTEGER;
ALTER TABLE pill_packs ADD COLUMN IF NOT EXISTS total_time_seconds INTEGER;
ALTER TABLE pill_packs ADD COLUMN IF NOT EXISTS required_correct INTEGER;
ALTER TABLE pill_packs ADD COLUMN IF NOT EXISTS entry_window_end TIMESTAMP WITH TIME ZONE;
ALTER TABLE pill_packs ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_pill_packs_status ON pill_packs(status);

-- Add pack_id and color to pills (run once)
ALTER TABLE pills ADD COLUMN IF NOT EXISTS pack_id UUID REFERENCES pill_packs(id) ON DELETE SET NULL;
ALTER TABLE pills ADD COLUMN IF NOT EXISTS color VARCHAR(20) DEFAULT '#00FF66';

-- ─── PILL PLAYS TABLE (per-player tracking) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS pill_plays (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pill_id UUID REFERENCES pills(id) ON DELETE CASCADE,
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  won BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(pill_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_pill_plays_player_id ON pill_plays(player_id);
CREATE INDEX IF NOT EXISTS idx_pill_plays_pill_id ON pill_plays(pill_id);

-- ─── BLITZ TOURNAMENTS ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS blitz_tournaments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  description TEXT,
  entry_fee INTEGER NOT NULL,
  question_count INTEGER NOT NULL,
  time_limit_seconds INTEGER NOT NULL,
  registration_start TIMESTAMP WITH TIME ZONE NOT NULL,
  tournament_start TIMESTAMP WITH TIME ZONE NOT NULL,
  tournament_end TIMESTAMP WITH TIME ZONE NOT NULL,
  status TEXT CHECK (status IN ('draft', 'registration', 'active', 'scoring', 'completed')) DEFAULT 'draft',
  total_registered INTEGER DEFAULT 0,
  max_participants INTEGER NOT NULL DEFAULT 100,
  min_participants INTEGER DEFAULT 1,
  prize_pool INTEGER DEFAULT 0,
  cash_winner_count INTEGER DEFAULT 1,
  payout_distribution JSONB NOT NULL DEFAULT '[100]',
  total_payout_percent DECIMAL(5,2) DEFAULT 40.00,
  ticket_tier_percent DECIMAL(5,2) DEFAULT 10.00,
  guaranteed_minimum INTEGER,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blitz_tournaments_status ON blitz_tournaments(status);

CREATE TABLE IF NOT EXISTS blitz_questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tournament_id UUID REFERENCES blitz_tournaments(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  format TEXT CHECK (format IN ('multiple_choice', 'type_answer')) NOT NULL,
  options JSONB,
  correct_answer TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blitz_questions_tournament_id ON blitz_questions(tournament_id);

CREATE TABLE IF NOT EXISTS blitz_registrations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tournament_id UUID REFERENCES blitz_tournaments(id) ON DELETE CASCADE,
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  entry_fee_paid INTEGER NOT NULL,
  ticket TEXT,
  registered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(tournament_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_blitz_registrations_tournament_id ON blitz_registrations(tournament_id);
CREATE INDEX IF NOT EXISTS idx_blitz_registrations_player_id ON blitz_registrations(player_id);

CREATE TABLE IF NOT EXISTS blitz_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tournament_id UUID REFERENCES blitz_tournaments(id) ON DELETE CASCADE,
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  answers JSONB NOT NULL,
  score INTEGER NOT NULL,
  total_time_ms INTEGER NOT NULL,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL,
  completed_at TIMESTAMP WITH TIME ZONE,
  status TEXT CHECK (status IN ('in_progress', 'completed')) DEFAULT 'in_progress',
  UNIQUE(tournament_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_blitz_attempts_tournament_id ON blitz_attempts(tournament_id);
CREATE INDEX IF NOT EXISTS idx_blitz_attempts_player_id ON blitz_attempts(player_id);
CREATE INDEX IF NOT EXISTS idx_blitz_attempts_score ON blitz_attempts(tournament_id, score DESC, total_time_ms ASC);

CREATE TABLE IF NOT EXISTS blitz_prizes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tournament_id UUID REFERENCES blitz_tournaments(id) ON DELETE CASCADE,
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  prize_type TEXT CHECK (prize_type IN ('cash', 'free_ticket')) NOT NULL,
  amount INTEGER DEFAULT 0,
  ticket_code TEXT,
  distributed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blitz_prizes_tournament_id ON blitz_prizes(tournament_id);
CREATE INDEX IF NOT EXISTS idx_blitz_prizes_player_id ON blitz_prizes(player_id);
CREATE INDEX IF NOT EXISTS idx_blitz_prizes_ticket_code ON blitz_prizes(ticket_code);

-- ─── BLITZ TICKETS TABLE ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS blitz_tickets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  source_tournament_id UUID REFERENCES blitz_tournaments(id) ON DELETE SET NULL,
  ticket_code TEXT UNIQUE NOT NULL,
  awarded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  status TEXT CHECK (status IN ('unused', 'used', 'expired')) DEFAULT 'unused',
  used_on_tournament_id UUID REFERENCES blitz_tournaments(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blitz_tickets_player_id ON blitz_tickets(player_id);
CREATE INDEX IF NOT EXISTS idx_blitz_tickets_ticket_code ON blitz_tickets(ticket_code);
CREATE INDEX IF NOT EXISTS idx_blitz_tickets_status ON blitz_tickets(status);
CREATE INDEX IF NOT EXISTS idx_blitz_tickets_expires_at ON blitz_tickets(expires_at);

-- ─── PILLS TABLE ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pills (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id UUID REFERENCES admins(id),
  question TEXT NOT NULL,
  category VARCHAR(50),
  entry_fee DECIMAL(10, 2) NOT NULL,
  prize DECIMAL(10, 2) NOT NULL,
  format TEXT CHECK (format IN ('multiple_choice', 'type_answer')) NOT NULL,
  options JSONB,
  correct_answer TEXT NOT NULL,
  timer_seconds INTEGER DEFAULT 30,
  case_sensitive BOOLEAN DEFAULT false,
  status TEXT CHECK (status IN ('available', 'played', 'expired')) DEFAULT 'available',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pills_status ON pills(status);
CREATE INDEX IF NOT EXISTS idx_pills_admin_id ON pills(admin_id);
CREATE INDEX IF NOT EXISTS idx_pills_category ON pills(category);

-- ─── NOTIFICATIONS TABLE ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  type TEXT CHECK (type IN ('win', 'loss', 'new_event', 'withdrawal_approved', 'withdrawal_rejected', 'blitz_starting', 'prediction_result')) NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_player_id ON notifications(player_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(player_id, read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);

-- ─── PLAYER SPEND LIMITS TABLE ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS player_limits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE UNIQUE,
  daily_limit INTEGER,
  weekly_limit INTEGER,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_limits_player_id ON player_limits(player_id);


CREATE TABLE IF NOT EXISTS predictions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id UUID REFERENCES admins(id),
  question TEXT NOT NULL,
  category VARCHAR(50),
  entry_fee DECIMAL(10, 2) NOT NULL,
  prize_per_winner DECIMAL(10, 2) NOT NULL,
  max_participants INTEGER DEFAULT 10,
  current_participants INTEGER DEFAULT 0,
  countdown_seconds INTEGER NOT NULL,
  countdown_end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  event_date TIMESTAMP WITH TIME ZONE,
  correct_answer TEXT,
  status TEXT CHECK (status IN ('active', 'locked', 'completed', 'cancelled')) DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_predictions_status ON predictions(status);
CREATE INDEX IF NOT EXISTS idx_predictions_admin_id ON predictions(admin_id);
CREATE INDEX IF NOT EXISTS idx_predictions_category ON predictions(category);
CREATE INDEX IF NOT EXISTS idx_predictions_countdown_end_time ON predictions(countdown_end_time);

-- ─── PREDICTION PARTICIPATION TABLE ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS prediction_participations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  prediction_id UUID REFERENCES predictions(id) ON DELETE CASCADE,
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  answer TEXT,
  is_correct BOOLEAN,
  amount_won DECIMAL(10, 2) DEFAULT 0,
  submitted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(prediction_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_prediction_participations_prediction_id ON prediction_participations(prediction_id);
CREATE INDEX IF NOT EXISTS idx_prediction_participations_player_id ON prediction_participations(player_id);
CREATE INDEX IF NOT EXISTS idx_prediction_participations_is_correct ON prediction_participations(is_correct);

-- ─── REFERRALS TABLE ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  referrer_id UUID REFERENCES players(id) ON DELETE CASCADE NOT NULL,
  referee_id UUID REFERENCES players(id) ON DELETE CASCADE NOT NULL,
  status TEXT CHECK (status IN ('pending', 'completed')) DEFAULT 'pending',
  first_deposit_done BOOLEAN DEFAULT false,
  first_game_done BOOLEAN DEFAULT false,
  first_deposit_amount INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(referee_id)  -- one referral row per referee
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referee_id ON referrals(referee_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);

-- ─── PILL TICKETS TABLE ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pill_tickets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE NOT NULL,
  source TEXT NOT NULL DEFAULT 'referral',   -- 'referral' for now, extensible later
  ticket_code TEXT UNIQUE NOT NULL,
  awarded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  status TEXT CHECK (status IN ('unused', 'used', 'expired')) DEFAULT 'unused',
  used_on_pack_id UUID REFERENCES pill_packs(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pill_tickets_player_id ON pill_tickets(player_id);
CREATE INDEX IF NOT EXISTS idx_pill_tickets_ticket_code ON pill_tickets(ticket_code);
CREATE INDEX IF NOT EXISTS idx_pill_tickets_status ON pill_tickets(status);
CREATE INDEX IF NOT EXISTS idx_pill_tickets_expires_at ON pill_tickets(expires_at);

-- ─── REFERRAL MILESTONES TABLE ────────────────────────────────────────────────
-- Tracks which one-time milestones each player has already received

CREATE TABLE IF NOT EXISTS referral_milestones (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE NOT NULL,
  milestone INTEGER NOT NULL,   -- 5, 15, etc.
  credited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(player_id, milestone)
);

CREATE INDEX IF NOT EXISTS idx_referral_milestones_player_id ON referral_milestones(player_id);

-- ─── VIP PILL ATTEMPTS TABLE ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vip_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE NOT NULL,
  pack_id UUID REFERENCES pill_packs(id) ON DELETE CASCADE NOT NULL,
  current_question_index INTEGER NOT NULL DEFAULT 0,
  status TEXT CHECK (status IN ('in_progress', 'won', 'failed')) DEFAULT 'in_progress',
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(player_id, pack_id)   -- one active attempt per player per pack
);

CREATE INDEX IF NOT EXISTS idx_vip_attempts_player_id ON vip_attempts(player_id);
CREATE INDEX IF NOT EXISTS idx_vip_attempts_pack_id ON vip_attempts(pack_id);
CREATE INDEX IF NOT EXISTS idx_vip_attempts_status ON vip_attempts(status);

-- ─── SPECIAL ATTEMPTS TABLE ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS special_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID REFERENCES players(id) ON DELETE CASCADE NOT NULL,
  pack_id UUID REFERENCES pill_packs(id) ON DELETE CASCADE NOT NULL,
  question_ids JSONB NOT NULL DEFAULT '[]',   -- ordered array of pill IDs drawn for this player
  current_question_index INTEGER NOT NULL DEFAULT 0,
  answers JSONB NOT NULL DEFAULT '[]',        -- array of submitted answers in order
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  total_time_seconds INTEGER NOT NULL,        -- copied from pack at attempt creation
  status TEXT CHECK (status IN ('in_progress', 'passed', 'failed')) DEFAULT 'in_progress',
  correct_count INTEGER DEFAULT 0,
  completed_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(player_id, pack_id)  -- one attempt per player per pack — DB-enforced
);

CREATE INDEX IF NOT EXISTS idx_special_attempts_player_id ON special_attempts(player_id);
CREATE INDEX IF NOT EXISTS idx_special_attempts_pack_id ON special_attempts(pack_id);
CREATE INDEX IF NOT EXISTS idx_special_attempts_status ON special_attempts(status);
