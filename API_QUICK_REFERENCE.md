# Unified Games Management API - Quick Reference

## Base URL
```
http://localhost:5000/api/admin/games
```

## Authentication
All endpoints require Bearer token in Authorization header:
```
Authorization: Bearer <jwt_token>
```

---

## 📋 Endpoints

### 1. List All Games
```http
GET /api/admin/games
Query Parameters:
  - type: "door_game" | "challenge_game" (optional)
  - status: "draft" | "active" | "paused" | "locked" | "ended" | "closed" (optional)
  - search: string (searches title/description, optional)
  - page: number (default: 1)
  - limit: number (default: 20)

Response:
{
  "success": true,
  "data": {
    "games": [...],
    "total": 6,
    "page": 1,
    "limit": 20,
    "totalPages": 1
  }
}
```

### 2. Create Game
```http
POST /api/admin/games/create
Content-Type: application/json

Door Game Request:
{
  "game_type": "door_game",
  "door_id": 1,
  "entry_fee": 500,
  "prize": 1000,
  "question_id": "uuid-string"
}

Challenge Game Request:
{
  "game_type": "challenge_game",
  "title": "Premier League Final",
  "description": "Predict the winner",
  "category": "Football",
  "question_type": "prediction",
  "stake_amount": 500,
  "max_participants": 50,
  "countdown_duration": 120
}

Response (201):
{
  "success": true,
  "data": {
    "game": {...}
  }
}
```

### 3. Get Game Details
```http
GET /api/admin/games/:id

Response:
{
  "success": true,
  "data": {
    "game": {
      "id": "uuid",
      "game_type": "door_game" | "challenge_game",
      "title": string,
      "status": string,
      "entry_fee": number (doors only),
      "prize": number (doors only),
      "stake_amount": number (challenges only),
      "prize_pool": number (challenges only)
    }
  }
}
```

### 4. Update Game
```http
PUT /api/admin/games/:id
Content-Type: application/json

Door Game Update:
{
  "entry_fee": 750,
  "prize": 1500,
  "question_id": "uuid"
}

Challenge Game Update (draft only):
{
  "title": "New Title",
  "description": "New description",
  "stake_amount": 1000
}

Response:
{
  "success": true,
  "data": { "game": {...} }
}
```

### 5. Delete Game
```http
DELETE /api/admin/games/:id
(Only works for challenges in draft status)

Response:
{
  "success": true,
  "data": { "message": "Challenge deleted" }
}
```

---

## 🔄 Status Transitions

### 6. Activate (draft → active)
```http
POST /api/admin/games/:id/activate

Response:
{
  "success": true,
  "data": { "game": {...} }
}
```

### 7. Pause (active → paused)
```http
POST /api/admin/games/:id/pause

Response:
{
  "success": true,
  "data": { "game": {...} }
}
```

### 8. Resume (paused → active)
```http
POST /api/admin/games/:id/resume

Response:
{
  "success": true,
  "data": { "game": {...} }
}
```

### 9. End (→ ended)
```http
POST /api/admin/games/:id/end

Response:
{
  "success": true,
  "data": { "game": {...} }
}
```

---

## 📊 Analytics

### 10. Get Game Statistics
```http
GET /api/admin/games/:id/stats

Door Game Response:
{
  "success": true,
  "data": {
    "game_type": "door_game",
    "total_players": 3,
    "total_won": 1,
    "total_lost": 2,
    "total_revenue": 1500,
    "total_prizes_paid": 500,
    "app_profit": 1000
  }
}

Challenge Game Response:
{
  "success": true,
  "data": {
    "game_type": "challenge_game",
    "total_participants": 10,
    "total_correct": 3,
    "total_incorrect": 7,
    "total_stake_collected": 10000,
    "total_prize_paid": 2400,
    "app_fee": 2000
  }
}
```

### 11. Get Participants
```http
GET /api/admin/games/:id/participants
Query Parameters:
  - page: number (default: 1)
  - limit: number (default: 20)

Response:
{
  "success": true,
  "data": {
    "participants": [
      {
        "id": "uuid",
        "player_id": "uuid",
        "player_answer": "answer",
        "is_correct": true,
        "amount_won": 400,
        "participated_at": "2026-07-02T...",
        "players": {
          "id": "uuid",
          "phone": "08012345678",
          "name": "John Doe"
        }
      }
    ],
    "total": 10,
    "page": 1,
    "limit": 20
  }
}
```

---

## 🎯 Challenge-Specific

### 12. Reveal Answer & Process Payouts
```http
POST /api/admin/games/:id/reveal-answer
Content-Type: application/json

Request:
{
  "correct_answer": "2"
}

Response:
{
  "success": true,
  "data": {
    "message": "Answer revealed and winners paid",
    "total_participants": 10,
    "total_correct": 3,
    "total_incorrect": 7,
    "prize_per_winner": 2666,
    "total_paid": 8000
  }
}
```

---

## 🔍 Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success (GET, PUT, POST) |
| 201 | Created (POST) |
| 400 | Bad Request |
| 401 | Unauthorized |
| 403 | Forbidden (not admin) |
| 404 | Game not found |
| 500 | Server error |

---

## 💡 Common Workflows

### Create and Activate Challenge
```bash
# 1. Create
curl -X POST http://localhost:5000/api/admin/games/create \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "game_type": "challenge_game",
    "title": "My Challenge",
    "stake_amount": 500,
    "max_participants": 20
  }'

# Save the returned game ID

# 2. Activate
curl -X POST http://localhost:5000/api/admin/games/{GAME_ID}/activate \
  -H "Authorization: Bearer TOKEN"

# 3. Players join and answer...

# 4. Reveal answer
curl -X POST http://localhost:5000/api/admin/games/{GAME_ID}/reveal-answer \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"correct_answer": "correct_value"}'
```

### Check Game Statistics
```bash
curl -X GET "http://localhost:5000/api/admin/games/{GAME_ID}/stats" \
  -H "Authorization: Bearer TOKEN"
```

### List All Active Games
```bash
curl -X GET "http://localhost:5000/api/admin/games?status=active" \
  -H "Authorization: Bearer TOKEN"
```

---

## 🧮 Prize Calculation

For challenges:
```
Prize Pool = max_participants × stake_amount × 0.8
(20% app fee is automatically deducted)

Per Winner Payout = Prize Pool / number_of_winners
```

Example:
```
10 participants × ₦1000 stake = ₦10,000 total
App Fee (20%) = ₦2,000
Prize Pool (80%) = ₦8,000

If 4 winners:
Per winner = ₦8,000 / 4 = ₦2,000
```

---

## 🚀 Frontend Integration

### Auth Token
```javascript
// From login/signup response
const token = response.data.token;
const headers = {
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json'
};
```

### Example Fetch
```javascript
// Create challenge
const response = await fetch('http://localhost:5000/api/admin/games/create', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    game_type: 'challenge_game',
    title: 'My Challenge',
    stake_amount: 500,
    max_participants: 20
  })
});

const data = await response.json();
```

---

## 📝 Notes

- All timestamps are in ISO 8601 format with timezone
- Prize calculations use integer division (no decimals)
- Pagination is 1-indexed (page 1 = first page)
- Status transitions are validated server-side
- All endpoints are admin-only (require Bearer token)
- Door IDs are numeric (1, 2, 3)
- Challenge IDs are UUIDs

---

**Last Updated:** July 2, 2026  
**API Version:** 1.0  
**Status:** Production Ready ✅
