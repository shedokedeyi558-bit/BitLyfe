# BitLyfe - Backend

A complete Node.js/Express backend for BitLyfe with integrated Paystack payments, Supabase database, and unified games management system.

## 🚀 Features

### Core Game Features
- **3-Door Quiz Game**: Players answer questions to win prizes
- **Pills Game**: Grouped pills with colors, entry fees, and prizes
- **Predictions (Time Machine)**: Countdown-based predictions with auto-lock
- **Blitz Tournaments**: Multi-player tournaments with ranking and prize distribution
- **Wallet System**: Manage player balances with Paystack deposits and withdrawals

### Administration
- **Admin Dashboard API**: Comprehensive endpoints for all game management
- **Seed Data Endpoint**: `POST /api/admin/seed` - Create 3 packs, 3 predictions, 3 tournaments instantly
- **Statistics & Analytics**: Detailed game performance metrics
- **Player Management**: View, search, and manage all players
- **Withdrawal Management**: Process withdrawal requests with auto-approval options

### Authentication
- **Triple Auth**: Email/password, phone/OTP, and phone/password signin
- **JWT Tokens**: Secure 30-day token expiration
- **Admin System**: Dedicated admin accounts with role-based access
- **Password Security**: Bcrypt hashing with 10 salt rounds

### Database
- **Supabase PostgreSQL**: Cloud database with RLS policies
- **20+ Tables**: Full schema for all game modes
- **Relationship Integrity**: Foreign keys and constraints
- **Performance**: Optimized indexes for fast queries

---

## 🛠️ Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js |
| Framework | Express.js |
| Database | Supabase PostgreSQL |
| ORM/Query | Supabase JS Client |
| Authentication | JWT + Bcrypt |
| Payments | Paystack API |
| Port | 5000 |

---

## 📋 Installation

### Prerequisites
- Node.js 16+ and npm
- Supabase account with database
- Paystack account with API keys

### Setup Steps

1. **Clone repository**
```
git clone https://github.com/shedokedeyi558-bit/BitLyfe.git
cd BitLyfe/server
```

2. **Install dependencies**
```bash
npm install
```

3. **Configure environment**
```bash
cp .env.example .env
# Edit .env with your Supabase and Paystack keys
```

4. **Initialize database**
```bash
# Run schema.sql in Supabase SQL editor
# Update status constraints if needed
```

5. **Start server**
```bash
# Development with nodemon
npm run dev

# Production
npm start
```

Server runs on `http://localhost:5000`

---

## 🔑 Environment Variables

```env
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_KEY=your-service-key

# Paystack
PAYSTACK_PUBLIC_KEY=pk_test_...
PAYSTACK_SECRET_KEY=sk_test_...

# JWT
JWT_SECRET=your-secret-key

# Server
PORT=5000
FRONTEND_URL=http://localhost:3000
NODE_ENV=development
```

---

## 🔌 API Endpoints

### Authentication
- `POST /api/auth/signup` - Register with email/password
- `POST /api/auth/signin` - Login with email/password
- `POST /api/auth/register` - Phone registration (legacy OTP)
- `POST /api/auth/verify-otp` - Verify OTP (legacy)
- `POST /api/auth/admin-login` - Admin login

### Games
- `GET /api/game/doors` - List active doors
- `POST /api/game/play` - Start a game session
- `POST /api/game/submit` - Submit answer
- `GET /api/game/recent-winners` - Recent winners list

### Challenges
- `GET /api/challenges` - List active challenges
- `POST /api/challenges/:id/join` - Join challenge
- `POST /api/admin/challenges` - Create challenge (admin)
- `POST /api/admin/challenges/:id/reveal-answer` - Reveal answer (admin)

### Unified Games Management (Task 10)
- `GET /api/admin/games` - List all games
- `POST /api/admin/games/create` - Create game
- `GET /api/admin/games/:id` - Get game details
- `PUT /api/admin/games/:id` - Update game
- `DELETE /api/admin/games/:id` - Delete game
- `POST /api/admin/games/:id/activate` - Activate
- `POST /api/admin/games/:id/pause` - Pause
- `POST /api/admin/games/:id/resume` - Resume
- `POST /api/admin/games/:id/end` - End game
- `GET /api/admin/games/:id/stats` - Get statistics
- `GET /api/admin/games/:id/participants` - List participants
- `POST /api/admin/games/:id/reveal-answer` - Reveal answer & payout

### Wallet
- `GET /api/wallet/balance` - Check balance
- `POST /api/wallet/deposit` - Initialize deposit
- `POST /api/wallet/verify-payment` - Verify deposit
- `GET /api/wallet/transactions` - Transaction history

### Admin
- `GET /api/admin/stats` - Dashboard statistics
- `GET /api/admin/questions` - List questions
- `POST /api/admin/questions` - Create question
- `POST /api/admin/questions/bulk-import` - Bulk import
- `POST /api/admin/seed` - Create seed data (3 packs, 3 predictions, 3 tournaments)
- `GET /api/admin/pills/packs` - List pill packs
- `GET /api/admin/predictions` - List predictions
- `GET /api/admin/blitz` - List tournaments
- And 30+ more endpoints...

### Webhooks
- `POST /api/webhooks/paystack` - Paystack payment webhook

---

## 📊 Database Schema

### Players
```sql
- id (UUID)
- email (UNIQUE)
- password_hash
- phone
- name
- balance
- games_played
- games_won
- total_won
- is_admin
- status
```

### Game Sessions
```sql
- id (UUID)
- player_id (FK: players)
- door_id (FK: doors)
- question_id (FK: questions)
- status (pending/won/lost)
- player_answer
- correct_answer
- prize
```

### Challenges
```sql
- id (UUID)
- title
- status (draft/active/paused/locked/ended/closed)
- stake_amount
- prize_pool
- max_participants
- current_participants
- correct_answer
- created_by (FK: players/admins)
```

### Transactions
```sql
- id (UUID)
- player_id (FK: players)
- type (entry_fee/prize/deposit/withdrawal/challenge_entry/challenge_win)
- amount
- description
- reference
```

---

## 🎮 Game Logic

### 3-Door Game
1. Player selects door (₦500 entry fee deducted)
2. Question is displayed
3. Player submits answer
4. Answer validated and prize awarded if correct
5. Recent winners (last 10) displayed with masked phone

### Challenge System
1. Admin creates challenge with countdown
2. Auto-locks when max participants reached or timer expires
3. Players join by submitting answer + stake
4. Admin reveals correct answer
5. Winners calculated (case-insensitive match)
6. Payouts: (total_stake × 0.8) / winner_count
7. Challenge closed and marked as complete

### Prize Calculation
```
Total Stake = participants × stake_amount
App Fee = 20% of Total Stake
Prize Pool = 80% of Total Stake
Per Winner = Prize Pool / number_of_winners
```

---

## 🔐 Security Features

- **Passwords**: Bcrypt hashing (10 salt rounds)
- **Tokens**: JWT with 30-day expiration
- **Database**: Row-level security policies
- **Validation**: Input validation on all endpoints
- **Authorization**: Admin-only endpoints protected
- **Webhooks**: Paystack signature verification
- **Sensitive Data**: Environment variables for secrets

---

## 📝 Logs

All requests logged with timestamp:
```
[2026-07-02T15:50:15.545Z] GET /health
[2026-07-02T15:50:26.863Z] POST /api/auth/admin-login
[2026-07-02T15:50:36.904Z] GET /api/admin/games
```

---

## 🧪 Testing

### Create Challenge
```bash
curl -X POST http://localhost:5000/api/admin/games/create \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "game_type": "challenge_game",
    "title": "Test Challenge",
    "stake_amount": 500,
    "max_participants": 20
  }'
```

### Activate Challenge
```bash
curl -X POST http://localhost:5000/api/admin/games/{GAME_ID}/activate \
  -H "Authorization: Bearer TOKEN"
```

### Check Health
```bash
curl http://localhost:5000/health
```

---

## 📚 Documentation

- [Implementation Summary](./IMPLEMENTATION_SUMMARY.md) - Complete feature breakdown
- [Task 10 Completion](./TASK_10_COMPLETION.md) - Unified Games API details
- [API Quick Reference](./API_QUICK_REFERENCE.md) - Endpoint reference guide

---

## 🚀 Deployment

### Heroku
```bash
git push heroku main
```

### Docker
```bash
docker build -t triple-threat .
docker run -p 5000:5000 triple-threat
```

### Environment Setup
```bash
export NODE_ENV=production
export PORT=5000
npm install --production
npm start
```

---

## 📧 Support

For issues or questions:
- Email: dev@triplethreat.com
- GitHub: https://github.com/shedokedeyi558-bit/BitLyfe

---

## 📄 License

Private - Triple Threat Game

---

## 👨‍💻 Development

### Scripts
```bash
npm start          # Production server
npm run dev        # Development with nodemon
npm test           # Run tests (if configured)
```

### Project Structure
```
server/
├── src/
│   ├── index.js              # Main entry point
│   ├── db/
│   │   ├── schema.sql        # Database schema
│   │   └── supabase.js       # Supabase client
│   ├── middleware/
│   │   ├── auth.js           # Player auth
│   │   └── adminAuth.js      # Admin auth
│   ├── routes/
│   │   ├── auth.js           # Authentication
│   │   ├── game.js           # 3-door game
│   │   ├── games.js          # Unified API
│   │   ├── challenges.js     # Challenges
│   │   ├── wallet.js         # Wallet
│   │   ├── admin.js          # Admin
│   │   └── withdrawals.js    # Withdrawals
│   └── services/
│       ├── gameLogic.js      # Game utilities
│       └── paystack.js       # Paystack service
├── package.json
└── .env.example
```

---

**Last Updated**: July 2, 2026  
**Status**: Production Ready ✅
