# 🌱 Seed Data Endpoint Guide

## Overview
The `POST /api/admin/seed` endpoint creates comprehensive sample data for testing the admin dashboard. It generates pill packs, predictions, and blitz tournaments with realistic data.

---

## Endpoint Details

**URL**: `POST https://bitlyfe-production.up.railway.app/api/admin/seed`

**Authentication**: Required (Bearer token from admin login)

**Method**: POST

**Request Body**: None (empty body is fine)

---

## What Gets Created

### 1. Pill Packs (3 total)

#### Pack 1: General Knowledge Pack (Active)
- **Status**: `active` (visible to players)
- **3 Pills** with different colors:
  - Capital of France? → ₦200 entry, ₦1000 prize
  - Largest planet? → ₦200 entry, ₦1000 prize
  - Titanic sinking year? → ₦200 entry, ₦1000 prize

#### Pack 2: Sports Pack (Draft)
- **Status**: `draft` (not visible to players yet)
- **2 Pills**:
  - Soccer team players? → ₦500 entry, ₦2000 prize
  - 2022 FIFA World Cup winner? → ₦500 entry, ₦2000 prize

#### Pack 3: Entertainment Pack (Active)
- **Status**: `active`
- **4 Pills**:
  - Inception director? → ₦100 entry, ₦500 prize
  - Starry Night artist? → ₦100 entry, ₦500 prize
  - Best-selling video game? → ₦100 entry, ₦500 prize
  - 2023 Emmy drama series? → ₦100 entry, ₦500 prize

---

### 2. Predictions / Time Machine (3 total)

#### Prediction 1: Active (in progress)
- **Question**: "How many goals will Manchester United score?"
- **Status**: `active`
- **Entry fee**: ₦500
- **Prize per winner**: ₦2000
- **Max players**: 50
- **Current registrations**: 15
- **Countdown**: 2 hours from now
- **Dummy entries**: 15 placeholder participations

#### Prediction 2: Locked (fully booked)
- **Question**: "Will Bitcoin reach $50,000?"
- **Status**: `locked`
- **Entry fee**: ₦1000
- **Prize per winner**: ₦5000
- **Max players**: 100
- **Current registrations**: 30
- **Countdown**: Already passed (1 hour ago)
- **Dummy entries**: 30 placeholder participations

#### Prediction 3: Draft (not launched)
- **Question**: "Who will win the next election?"
- **Status**: `draft`
- **Entry fee**: ₦2000
- **Prize per winner**: ₦10000
- **Max players**: 200
- **Countdown**: 24 hours from now
- **No registrations yet**

---

### 3. Blitz Tournaments (3 total)

#### Tournament 1: Registration Phase
- **Title**: "Speed Quiz Challenge"
- **Status**: `registration`
- **Entry fee**: ₦500
- **Questions**: 10
- **Time limit**: 2 minutes
- **Registrations**: 25 players
- **Prize pool**: ₦12,500
- **Starts**: 30 minutes from now

#### Tournament 2: Active (Running)
- **Title**: "Football Legends"
- **Status**: `active`
- **Entry fee**: ₦1000
- **Questions**: 20
- **Time limit**: 3 minutes
- **Registrations**: 100 players
- **Prize pool**: ₦100,000
- **Running for**: ~3 hours (started 10 mins ago)

#### Tournament 3: Completed (with results)
- **Title**: "Crypto Quiz Showdown"
- **Status**: `completed`
- **Entry fee**: ₦1000
- **Questions**: 15
- **Time limit**: 2.5 minutes
- **Final registrations**: 80 players
- **Prize pool**: ₦80,000
- **Prize distribution**:
  - 1st: ₦40,000 (cash)
  - 2nd: ₦24,000 (cash)
  - 3rd: ₦16,000 (cash)
  - 4th-10th: Free ticket each
- **Dummy leaderboard**: 80 player attempts with varied scores

---

## Example Request

### Using cURL

```bash
# First, get admin token
ADMIN_TOKEN=$(curl -X POST https://bitlyfe-production.up.railway.app/api/auth/admin-login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "shedokedeyi558@gmail.com",
    "password": "Sapphire558"
  }' | jq -r '.data.token')

# Then create seed data
curl -X POST https://bitlyfe-production.up.railway.app/api/admin/seed \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Using Postman

1. Set request type to **POST**
2. URL: `https://bitlyfe-production.up.railway.app/api/admin/seed`
3. Header: `Authorization: Bearer <admin-token>`
4. Body: Empty or `{}`
5. Click **Send**

---

## Response Format

**Success Response (201)**:
```json
{
  "success": true,
  "data": {
    "packs_created": 3,
    "predictions_created": 3,
    "blitz_created": 3,
    "message": "Seed data created successfully",
    "details": {
      "packs": [
        { "id": "uuid-1", "name": "General Knowledge Pack", "status": "active" },
        { "id": "uuid-2", "name": "Sports Pack", "status": "draft" },
        { "id": "uuid-3", "name": "Entertainment Pack", "status": "active" }
      ],
      "predictions": [
        { "id": "uuid-1", "question": "How many goals will...", "status": "active" },
        { "id": "uuid-2", "question": "Will Bitcoin reach...", "status": "locked" },
        { "id": "uuid-3", "question": "Who will win...", "status": "draft" }
      ],
      "tournaments": [
        { "id": "uuid-1", "title": "Speed Quiz Challenge", "status": "registration" },
        { "id": "uuid-2", "title": "Football Legends", "status": "active" },
        { "id": "uuid-3", "title": "Crypto Quiz Showdown", "status": "completed" }
      ]
    }
  }
}
```

**Error Response (401)**:
```json
{
  "success": false,
  "error": "Admin authentication required"
}
```

**Error Response (500)**:
```json
{
  "success": false,
  "error": "Failed to create seed data: [details]"
}
```

---

## Testing Workflow

1. **Get admin token**:
   ```bash
   POST /api/auth/admin-login
   {"email": "shedokedeyi558@gmail.com", "password": "Sapphire558"}
   ```

2. **Create seed data**:
   ```bash
   POST /api/admin/seed
   Headers: Authorization: Bearer <token>
   ```

3. **View in dashboard**:
   - **Pills**: `GET /api/admin/pills/packs` → See all 3 packs with pills
   - **Predictions**: `GET /api/admin/predictions` → See 3 predictions in different statuses
   - **Tournaments**: `GET /api/admin/blitz` → See 3 tournaments with leaderboards

4. **Player view**:
   - **Pill packs**: `GET /api/pills/packs` → Only active packs visible
   - **Active predictions**: `GET /api/predictions/active` → See available predictions
   - **Browse tournaments**: `GET /api/blitz` → See registration/active tournaments

---

## Safe to Call Multiple Times

✅ **Safe**: You can call this endpoint multiple times. Each call creates fresh data (seeds don't prevent duplicates).

💡 **Tip**: If you want to clear and reseed, run the database cleanup SQL first, then call `/api/admin/seed`.

---

## What's Included in Dummy Data

### Pill Colors
Each pill has a unique hex color for UI representation:
- `#FF4444` - Red
- `#44FF88` - Green
- `#8844FF` - Purple
- `#FFD700` - Gold
- `#FF69B4` - Hot Pink
- `#00CED1` - Dark Turquoise
- `#32CD32` - Lime Green
- `#FF8C00` - Dark Orange
- `#9370DB` - Medium Purple

### Prediction Participations
- Prediction 1 (active): 15 dummy entries with random answers
- Prediction 2 (locked): 30 dummy entries from the past
- Prediction 3 (draft): No entries yet

### Blitz Leaderboard (Completed Tournament)
- 80 attempts with scores 0-2 (number of correct answers)
- Random completion times (0-150 seconds)
- Ranked by score then time taken
- Prize distribution for top 10:
  - Cash: Top 3
  - Free tickets: 4th-10th

---

## Admin Credentials

- **Email**: `shedokedeyi558@gmail.com`
- **Password**: `Sapphire558`

---

## Backend URL

- **Production**: `https://bitlyfe-production.up.railway.app`
- **Health Check**: `GET /health`

---

## Next Steps

After seeding:
1. ✅ Login to admin dashboard
2. ✅ View pills, predictions, and tournaments
3. ✅ Test filtering by status
4. ✅ Check leaderboard for completed tournament
5. ✅ View countdown timers for active predictions
6. ✅ Test player-side visibility of games

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| 401 Unauthorized | Make sure you have a valid admin token |
| 500 Error | Check server logs, database connection |
| No data created | Verify admin auth middleware is active |
| Duplicate data | Clear database with cleanup SQL, then reseed |

