# PILLS & PREDICTIONS Setup Guide

## 🗄️ Step 1: Create Database Tables in Supabase

Go to **Supabase → SQL Editor** and run this SQL:

```sql
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
```

Click **Run** to execute all table creations.

---

## 📋 Step 2: Seed Sample Data (Optional)

Run this SQL to create sample pills and predictions:

```sql
-- Insert sample pills
INSERT INTO pills (admin_id, question, category, entry_fee, prize, format, options, correct_answer, timer_seconds, status)
VALUES 
  ('YOUR_ADMIN_ID_HERE', 'What is the capital of France?', 'Geography', 100, 500, 'multiple_choice', '["Paris", "London", "Berlin", "Madrid"]'::jsonb, 'Paris', 30, 'available'),
  ('YOUR_ADMIN_ID_HERE', 'What is 5 + 3?', 'Math', 50, 200, 'multiple_choice', '["7", "8", "9", "10"]'::jsonb, '8', 30, 'available'),
  ('YOUR_ADMIN_ID_HERE', 'What is the largest planet in our solar system?', 'Science', 100, 500, 'multiple_choice', '["Jupiter", "Saturn", "Neptune", "Earth"]'::jsonb, 'Jupiter', 30, 'available');

-- Insert sample predictions
INSERT INTO predictions (admin_id, question, category, entry_fee, prize_per_winner, max_participants, countdown_seconds, countdown_end_time, status)
VALUES 
  ('YOUR_ADMIN_ID_HERE', 'Will Liverpool win the next match?', 'Football', 200, 2000, 10, 3600, NOW() + INTERVAL '1 hour', 'active'),
  ('YOUR_ADMIN_ID_HERE', 'What color jersey will Man City wear?', 'Football', 100, 1000, 5, 1800, NOW() + INTERVAL '30 minutes', 'active');
```

**Replace `YOUR_ADMIN_ID_HERE`** with the actual admin UUID from your admins table.

To find your admin ID, run:
```sql
SELECT id, email FROM admins LIMIT 1;
```

---

## 🚀 All Endpoints Ready

After the tables are created, all endpoints are live:

### Player Endpoints (Require Auth)

**PILLS:**
- `GET /api/pills/available` — Get all available pills
- `POST /api/pills/open` — Open and deduct entry fee
- `POST /api/pills/submit` — Submit answer

**PREDICTIONS:**
- `GET /api/predictions/active` — Get active predictions
- `POST /api/predictions/enter` — Join a prediction
- `POST /api/predictions/submit` — Submit prediction answer
- `GET /api/predictions/result/:id` — Get prediction result

### Admin Endpoints (Require Admin Auth)

**PILLS MANAGEMENT:**
- `GET /api/admin/pills` — List all pills
- `POST /api/admin/pills` — Create a new pill
- `PUT /api/admin/pills/:id` — Update a pill
- `DELETE /api/admin/pills/:id` — Mark pill as expired
- `GET /api/admin/pills/stats` — Pill statistics

**PREDICTIONS MANAGEMENT:**
- `GET /api/admin/predictions` — List all predictions
- `POST /api/admin/predictions` — Create a new prediction
- `PUT /api/admin/predictions/:id` — Update a prediction
- `POST /api/admin/predictions/:id/mark-answer` — Mark correct answer and credit winners
- `POST /api/admin/predictions/:id/cancel` — Cancel and refund prediction
- `GET /api/admin/predictions/:id/participations` — View prediction entries
- `GET /api/admin/predictions/stats` — Prediction statistics

---

## 📊 API Examples

### Create a Pill (Admin)
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/admin/pills \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "What is 2+2?",
    "category": "Math",
    "entry_fee": 500,
    "prize": 2000,
    "format": "multiple_choice",
    "options": ["3", "4", "5", "6"],
    "correct_answer": "4",
    "timer_seconds": 30
  }'
```

### Open a Pill (Player)
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/pills/open \
  -H "Authorization: Bearer YOUR_PLAYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pillId": "UUID_HERE"}'
```

### Submit Pill Answer (Player)
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/pills/submit \
  -H "Authorization: Bearer YOUR_PLAYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pillId": "UUID_HERE", "answer": "4"}'
```

### Create a Prediction (Admin)
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/admin/predictions \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "How many goals will Chelsea score?",
    "category": "Football",
    "entry_fee": 500,
    "prize_per_winner": 5000,
    "max_participants": 10,
    "countdown_seconds": 3600
  }'
```

### Enter a Prediction (Player)
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/predictions/enter \
  -H "Authorization: Bearer YOUR_PLAYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"predictionId": "UUID_HERE"}'
```

### Submit Prediction (Player)
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/predictions/submit \
  -H "Authorization: Bearer YOUR_PLAYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"predictionId": "UUID_HERE", "answer": "2"}'
```

### Mark Prediction Answer (Admin)
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/admin/predictions/UUID_HERE/mark-answer \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"correctAnswer": "2"}'
```

---

## ✅ Features Implemented

### PILLS Game
✅ Create, update, delete pills  
✅ Multiple choice & type answer formats  
✅ Entry fee deduction on open  
✅ Prize distribution on correct answer  
✅ Status tracking (available, played, expired)  
✅ Timer support  
✅ Case sensitivity option for type answers  

### PREDICTIONS Game
✅ Create predictions with countdown  
✅ Auto-lock when max participants reached  
✅ Admin marks correct answer after countdown  
✅ Auto-credit all winners  
✅ Refund on cancellation  
✅ Participation tracking  
✅ Entry fee & prize management  
✅ Result visibility (only after answer marked)  

### Security & Validation
✅ Bearer token authentication required  
✅ Admin-only endpoints protected  
✅ Balance validation before any deduction  
✅ Idempotency checks (can't play same pill twice, can't submit answer twice)  
✅ Error handling with proper HTTP status codes  
✅ Rate limiting on game endpoints (30 requests/minute)  

---

## 🎯 Ready to Deploy!

Your backend is now completely ready with all three games:
1. **3-Door Quiz** (GET /api/game/doors)
2. **PILLS** (POST /api/pills/open)
3. **PREDICTIONS** (POST /api/predictions/enter)

Frontend can now integrate all endpoints and connect to `https://bitlyfe-production.up.railway.app`
