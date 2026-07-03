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
  games_played INT DEFAULT 0,
  games_won INT DEFAULT 0,
  total_won INT DEFAULT 0,
  is_admin BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

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
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Withdrawal requests table
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID REFERENCES players(id),
  phone TEXT,
  amount INT NOT NULL,
  method TEXT,
  account_number TEXT,
  bank_name TEXT,
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

-- ─── PREDICTIONS TABLE ────────────────────────────────────────────────────────

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
  answer TEXT NOT NULL,
  is_correct BOOLEAN,
  amount_won DECIMAL(10, 2) DEFAULT 0,
  submitted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(prediction_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_prediction_participations_prediction_id ON prediction_participations(prediction_id);
CREATE INDEX IF NOT EXISTS idx_prediction_participations_player_id ON prediction_participations(player_id);
CREATE INDEX IF NOT EXISTS idx_prediction_participations_is_correct ON prediction_participations(is_correct);
