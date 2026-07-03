# 🚀 BitLyfe Backend - Quick Start & Testing Guide

**Backend**: `https://bitlyfe-production.up.railway.app`

---

## 📋 Table of Contents
1. [Get Auth Tokens](#1-get-auth-tokens)
2. [Test Public Endpoints](#2-test-public-endpoints)
3. [Create Sample Data](#3-create-sample-data)
4. [Test Player Flows](#4-test-player-flows)
5. [Test Admin Functions](#5-test-admin-functions)
6. [Common Curl Commands](#6-common-curl-commands)

---

## 1️⃣ Get Auth Tokens

First, get a player and admin token for testing.

### Register Player
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "08012345678",
    "password": "test123"
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "message": "Player registered",
    "player": {
      "id": "uuid-here",
      "phone": "08012345678"
    }
  }
}
```

### Login Player
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "08012345678",
    "password": "test123"
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "player": {
      "id": "uuid",
      "phone": "08012345678",
      "balance": 0
    }
  }
}
```

**Save the token as `PLAYER_TOKEN`**

### Admin Login
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/auth/admin-login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@bitlyfe.com",
    "password": "admin123"
  }'
```

**Save the token as `ADMIN_TOKEN`**

---

## 2️⃣ Test Public Endpoints

### Health Check
```bash
curl https://bitlyfe-production.up.railway.app/health
```

Response:
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "version": "1.0.0",
    "uptime": 12345.67,
    "timestamp": "2026-07-03T08:00:00Z"
  }
}
```

### Get Terms
```bash
curl https://bitlyfe-production.up.railway.app/api/terms
```

### Game Stats
```bash
curl https://bitlyfe-production.up.railway.app/api/game/stats
```

### Get Available Doors
```bash
curl https://bitlyfe-production.up.railway.app/api/game/doors
```

Response:
```json
{
  "success": true,
  "data": {
    "doors": [
      {
        "id": 1,
        "status": "active",
        "prize": 1000,
        "entry_fee": 500,
        "question": {
          "id": "uuid",
          "text": "What is the capital of Nigeria?",
          "format": "multiple_choice",
          "options": ["Lagos", "Abuja", "Port Harcourt", "Kano"],
          "difficulty": "easy",
          "time_limit": 10
        }
      }
    ]
  }
}
```

---

## 3️⃣ Create Sample Data

### Add Balance to Player (Via Deposit)

**Step 1: Initialize deposit**
```bash
PLAYER_TOKEN="your-token-here"

curl -X POST https://bitlyfe-production.up.railway.app/api/wallet/deposit \
  -H "Authorization: Bearer $PLAYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 10000
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "authorizationUrl": "https://checkout.paystack.com/...",
    "reference": "dep_uuid",
    "amount": 10000
  }
}
```

**For testing: Manually add balance to player in Supabase**
```sql
UPDATE players SET balance = 10000 WHERE phone = '08012345678';
```

### Create Sample Pills (Admin)

```bash
ADMIN_TOKEN="your-admin-token-here"

curl -X POST https://bitlyfe-production.up.railway.app/api/admin/pills \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
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

Response:
```json
{
  "success": true,
  "data": {
    "pill": {
      "id": "pill-uuid-1",
      "question": "What is 2+2?",
      "category": "Math",
      "entry_fee": 500,
      "prize": 2000,
      "status": "available"
    }
  }
}
```

**Create More Pills**
```bash
# Geography Pill
curl -X POST https://bitlyfe-production.up.railway.app/api/admin/pills \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "What is the capital of France?",
    "category": "Geography",
    "entry_fee": 750,
    "prize": 3000,
    "format": "multiple_choice",
    "options": ["London", "Paris", "Berlin", "Madrid"],
    "correct_answer": "Paris"
  }'

# Science Pill (Type Answer)
curl -X POST https://bitlyfe-production.up.railway.app/api/admin/pills \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "What year did Nigeria gain independence?",
    "category": "History",
    "entry_fee": 1000,
    "prize": 5000,
    "format": "type_answer",
    "correct_answer": "1960"
  }'
```

### Create Sample Predictions (Admin)

```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/admin/predictions \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "How many goals will Chelsea score this weekend?",
    "category": "Football",
    "entry_fee": 500,
    "prize_per_winner": 5000,
    "max_participants": 10,
    "countdown_seconds": 3600
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "prediction": {
      "id": "pred-uuid-1",
      "question": "How many goals will Chelsea score?",
      "status": "active",
      "countdown_end_time": "2026-07-03T09:00:00Z"
    }
  }
}
```

---

## 4️⃣ Test Player Flows

### Flow 1: Play 3-Door Quiz

**Step 1: Get doors**
```bash
curl https://bitlyfe-production.up.railway.app/api/game/doors
```

**Step 2: Play door**
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/game/play \
  -H "Authorization: Bearer $PLAYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "doorId": 1
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "sessionId": "session-uuid",
    "question": {
      "id": "q-uuid",
      "text": "What is the capital of Nigeria?",
      "format": "multiple_choice",
      "options": ["Lagos", "Abuja", "Port Harcourt", "Kano"],
      "time_limit": 10
    },
    "entryFee": 500,
    "newBalance": 9500
  }
}
```

**Step 3: Submit answer**
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/game/submit \
  -H "Authorization: Bearer $PLAYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "session-uuid-from-step-2",
    "answer": "Abuja"
  }'
```

Response (if correct):
```json
{
  "success": true,
  "data": {
    "correct": true,
    "prize": 1000,
    "correctAnswer": "Abuja",
    "message": "Correct! You won ₦1000"
  }
}
```

### Flow 2: Play Pills Game

**Step 1: Get available pills**
```bash
curl https://bitlyfe-production.up.railway.app/api/pills/available \
  -H "Authorization: Bearer $PLAYER_TOKEN"
```

Response:
```json
{
  "success": true,
  "data": {
    "pills": [
      {
        "id": "pill-uuid-1",
        "question": "What is 2+2?",
        "category": "Math",
        "price": 500,
        "prize": 2000,
        "format": "multiple_choice",
        "timer": 30
      }
    ]
  }
}
```

**Step 2: Open pill**
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/pills/open \
  -H "Authorization: Bearer $PLAYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "pillId": "pill-uuid-1"
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "question": "What is 2+2?",
    "category": "Math",
    "format": "multiple_choice",
    "options": ["3", "4", "5", "6"],
    "timer": 30,
    "prize": 2000,
    "entryFee": 500,
    "newBalance": 9500
  }
}
```

**Step 3: Submit pill answer**
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/pills/submit \
  -H "Authorization: Bearer $PLAYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "pillId": "pill-uuid-1",
    "answer": "4"
  }'
```

Response (if correct):
```json
{
  "success": true,
  "data": {
    "won": true,
    "correctAnswer": "4",
    "prize": 2000,
    "newBalance": 11500
  }
}
```

### Flow 3: Play Predictions Game

**Step 1: Get active predictions**
```bash
curl https://bitlyfe-production.up.railway.app/api/predictions/active \
  -H "Authorization: Bearer $PLAYER_TOKEN"
```

Response:
```json
{
  "success": true,
  "data": {
    "predictions": [
      {
        "id": "pred-uuid-1",
        "question": "How many goals will Chelsea score?",
        "category": "Football",
        "fee": 500,
        "prize_per_winner": 5000,
        "slots_filled": 0,
        "max_slots": 10,
        "countdown_remaining_seconds": 3600,
        "status": "active"
      }
    ]
  }
}
```

**Step 2: Enter prediction**
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/predictions/enter \
  -H "Authorization: Bearer $PLAYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "predictionId": "pred-uuid-1"
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "prediction": {
      "id": "pred-uuid-1",
      "slots_filled": 1,
      "status": "active"
    },
    "newBalance": 11000
  }
}
```

**Step 3: Submit prediction**
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/predictions/submit \
  -H "Authorization: Bearer $PLAYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "predictionId": "pred-uuid-1",
    "answer": "2"
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "message": "Prediction submitted"
  }
}
```

**Step 4: Get result (after admin marks answer)**
```bash
curl https://bitlyfe-production.up.railway.app/api/predictions/result/pred-uuid-1 \
  -H "Authorization: Bearer $PLAYER_TOKEN"
```

Response (if correct):
```json
{
  "success": true,
  "data": {
    "won": true,
    "correctAnswer": "2",
    "yourAnswer": "2",
    "prize": 5000,
    "newBalance": 16000
  }
}
```

### Check Balance
```bash
curl https://bitlyfe-production.up.railway.app/api/wallet/balance \
  -H "Authorization: Bearer $PLAYER_TOKEN"
```

Response:
```json
{
  "success": true,
  "data": {
    "balance": 11500
  }
}
```

### Get Transactions
```bash
curl https://bitlyfe-production.up.railway.app/api/wallet/transactions \
  -H "Authorization: Bearer $PLAYER_TOKEN"
```

---

## 5️⃣ Test Admin Functions

### View All Pills
```bash
curl https://bitlyfe-production.up.railway.app/api/admin/pills \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### View All Predictions
```bash
curl https://bitlyfe-production.up.railway.app/api/admin/predictions \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Mark Prediction Answer (Credit Winners)

```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/admin/predictions/pred-uuid-1/mark-answer \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "correctAnswer": "2"
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "message": "Prediction marked and winners credited",
    "prediction": {
      "id": "pred-uuid-1",
      "correctAnswer": "2",
      "status": "completed",
      "totalParticipants": 5,
      "winners": 2,
      "totalPrizeDistributed": 10000
    }
  }
}
```

### Admin Dashboard Stats
```bash
curl https://bitlyfe-production.up.railway.app/api/admin/stats \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### View Prediction Participations
```bash
curl https://bitlyfe-production.up.railway.app/api/admin/predictions/pred-uuid-1/participations \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## 6️⃣ Common Curl Commands

### Save tokens to file for easy reuse
```bash
PLAYER_TOKEN="eyJhbGciOiJIUzI1NiIs..."
ADMIN_TOKEN="eyJhbGciOiJIUzI1NiIs..."
```

### Quick player balance check
```bash
curl https://bitlyfe-production.up.railway.app/api/wallet/balance \
  -H "Authorization: Bearer $PLAYER_TOKEN" | jq
```

### Quick available pills
```bash
curl https://bitlyfe-production.up.railway.app/api/pills/available \
  -H "Authorization: Bearer $PLAYER_TOKEN" | jq
```

### Quick active predictions
```bash
curl https://bitlyfe-production.up.railway.app/api/predictions/active \
  -H "Authorization: Bearer $PLAYER_TOKEN" | jq
```

---

## 📝 Testing Checklist

Use this checklist to ensure everything works:

### Authentication ✅
- [ ] Register player
- [ ] Login player (get token)
- [ ] Admin login (get token)
- [ ] Token-based requests work

### Public Endpoints ✅
- [ ] GET /health returns status
- [ ] GET /api/game/doors returns 3 doors
- [ ] GET /api/game/stats returns stats

### Pills Game ✅
- [ ] Admin can create pills
- [ ] Player can list available pills
- [ ] Player can open pill (entry fee deducted)
- [ ] Player can submit correct answer (prize credited)
- [ ] Player can submit wrong answer
- [ ] Pill cannot be played twice

### Predictions Game ✅
- [ ] Admin can create prediction
- [ ] Player can see active predictions
- [ ] Player can enter prediction (fee deducted)
- [ ] Player can submit answer
- [ ] Admin can mark answer
- [ ] Winners are credited
- [ ] Result is visible to player

### 3-Door Quiz ✅
- [ ] Player can play door
- [ ] Entry fee deducted
- [ ] Can submit answer
- [ ] Correct answer gives prize

### Wallet ✅
- [ ] Get balance
- [ ] View transactions
- [ ] Withdraw request

### Error Cases ✅
- [ ] Insufficient balance error (402)
- [ ] Invalid token error (401)
- [ ] Not admin error (403)
- [ ] Already played error (409)

---

## 🎯 Next Steps

1. **Run through all test flows above**
2. **Verify all endpoints return expected responses**
3. **Check database for transaction records**
4. **Connect frontend and test end-to-end**

All endpoints are live and ready for integration!
