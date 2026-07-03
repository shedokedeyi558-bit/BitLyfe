# BitLyfe API - Complete Endpoint Reference

**Backend URL**: `https://bitlyfe-production.up.railway.app`  
**Version**: 1.0.0  
**Last Updated**: 2026-07-03

---

## 🔐 Authentication

All endpoints except `/health`, `/api/terms`, `/api/game/stats`, `/api/game/doors`, `/api/game/recent-winners` require a Bearer token.

**Header**: `Authorization: Bearer {jwt_token}`

### Response Codes
- `401` - Invalid/missing token
- `403` - Not admin (on admin endpoints)
- `402` - Insufficient balance
- `409` - Conflict (e.g., already played, slots full)

---

## 📍 Public Endpoints (No Auth Required)

### GET /health
Check server status and version.
```json
Response: {
  "success": true,
  "data": {
    "status": "ok",
    "version": "1.0.0",
    "uptime": 12345.67,
    "timestamp": "2026-07-03T08:00:00Z"
  }
}
```

### GET /api/terms
Get terms of service.
```json
Response: {
  "success": true,
  "data": {
    "terms": "Welcome to BitLyfe..."
  }
}
```

### GET /api/game/stats
Get today's game statistics.
```json
Response: {
  "success": true,
  "data": {
    "totalPlaysToday": 150,
    "totalRevenueToday": 75000,
    "totalPayoutsToday": 125000,
    "activePlayersToday": 45
  }
}
```

### GET /api/game/doors
Get all 3 available doors with current questions.
```json
Response: {
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
          "difficulty": "easy",
          "prize": 1000,
          "time_limit": 10,
          "options": ["Lagos", "Abuja", "Port Harcourt", "Kano"]
        }
      }
    ]
  }
}
```

### GET /api/game/recent-winners
Get last 10 winners (masked phone numbers).
```json
Response: {
  "success": true,
  "data": {
    "winners": [
      {
        "id": "uuid",
        "phone": "****5678",
        "doorId": 1,
        "prize": 1000,
        "playedAt": "2026-07-03T08:00:00Z"
      }
    ]
  }
}
```

---

## 🎮 Game Endpoints (Auth Required)

### POST /api/game/play
Start a 3-door game session (deducts entry fee).
```json
Body: {
  "doorId": 1
}

Response: {
  "success": true,
  "data": {
    "sessionId": "uuid",
    "question": {
      "id": "uuid",
      "text": "What is 2+2?",
      "format": "multiple_choice",
      "options": ["3", "4", "5", "6"],
      "time_limit": 10
    },
    "entryFee": 500,
    "newBalance": 4500
  }
}
```

### POST /api/game/submit
Submit answer and check if correct.
```json
Body: {
  "sessionId": "uuid",
  "answer": "4"
}

Response (Correct): {
  "success": true,
  "data": {
    "correct": true,
    "prize": 1000,
    "correctAnswer": "4",
    "message": "Correct! You won ₦1000"
  }
}

Response (Wrong): {
  "success": true,
  "data": {
    "correct": false,
    "prize": 0,
    "correctAnswer": "4",
    "message": "Wrong answer. Better luck next time!"
  }
}
```

---

## 💊 PILLS Endpoints (Auth Required)

### GET /api/pills/available
Get all available unopened pills.
```json
Response: {
  "success": true,
  "data": {
    "pills": [
      {
        "id": "uuid",
        "question": "What is 2+2?",
        "category": "Math",
        "price": 500,
        "prize": 1000,
        "status": "available",
        "format": "multiple_choice",
        "timer": 30
      }
    ]
  }
}
```

### POST /api/pills/open
Open a pill (deducts entry fee immediately).
```json
Body: {
  "pillId": "uuid"
}

Response: {
  "success": true,
  "data": {
    "question": "What is 2+2?",
    "category": "Math",
    "format": "multiple_choice",
    "options": ["3", "4", "5", "6"],
    "timer": 30,
    "prize": 1000,
    "entryFee": 500,
    "newBalance": 4500
  }
}
```

### POST /api/pills/submit
Submit pill answer.
```json
Body: {
  "pillId": "uuid",
  "answer": "4"
}

Response (Correct): {
  "success": true,
  "data": {
    "won": true,
    "correctAnswer": "4",
    "prize": 1000,
    "newBalance": 5500
  }
}

Response (Wrong): {
  "success": true,
  "data": {
    "won": false,
    "correctAnswer": "4",
    "prize": 0
  }
}
```

---

## 🎯 PREDICTIONS Endpoints (Auth Required)

### GET /api/predictions/active
Get all active predictions with countdown.
```json
Response: {
  "success": true,
  "data": {
    "predictions": [
      {
        "id": "uuid",
        "question": "How many goals will Chelsea score?",
        "category": "Football",
        "fee": 500,
        "prize_per_winner": 5000,
        "slots_filled": 7,
        "max_slots": 10,
        "countdown_end": "2026-07-03T18:00:00Z",
        "countdown_remaining_seconds": 3600,
        "status": "active"
      }
    ]
  }
}
```

### POST /api/predictions/enter
Join a prediction (deducts entry fee).
```json
Body: {
  "predictionId": "uuid"
}

Response: {
  "success": true,
  "data": {
    "prediction": {
      "id": "uuid",
      "question": "How many goals will Chelsea score?",
      "category": "Football",
      "fee": 500,
      "prize_per_winner": 5000,
      "slots_filled": 8,
      "max_slots": 10,
      "countdown_end": "2026-07-03T18:00:00Z",
      "status": "active"
    },
    "newBalance": 4500
  }
}
```

### POST /api/predictions/submit
Submit prediction answer.
```json
Body: {
  "predictionId": "uuid",
  "answer": "2"
}

Response: {
  "success": true,
  "data": {
    "message": "Prediction submitted"
  }
}
```

### GET /api/predictions/result/:id
Get prediction result (only if answer is marked by admin).
```json
Response: {
  "success": true,
  "data": {
    "won": true,
    "correctAnswer": "2",
    "yourAnswer": "2",
    "prize": 5000,
    "newBalance": 9500
  }
}
```

---

## 💰 Wallet Endpoints (Auth Required)

### GET /api/wallet/balance
Get current wallet balance.
```json
Response: {
  "success": true,
  "data": {
    "balance": 10000
  }
}
```

### POST /api/wallet/deposit
Initialize Paystack payment.
```json
Body: {
  "amount": 5000
}

Response: {
  "success": true,
  "data": {
    "authorizationUrl": "https://checkout.paystack.com/xxx",
    "reference": "dep_uuid",
    "amount": 5000
  }
}
```

### GET /api/wallet/verify?reference=xxx
Verify payment and credit wallet.
```json
Response: {
  "success": true,
  "data": {
    "message": "₦5000 credited to your wallet",
    "amount": 5000,
    "newBalance": 15000
  }
}
```

### GET /api/wallet/transactions
Get transaction history.
```json
Response: {
  "success": true,
  "data": {
    "transactions": [
      {
        "id": "uuid",
        "type": "deposit",
        "amount": 5000,
        "description": "Deposit of ₦5000",
        "reference": "dep_uuid",
        "created_at": "2026-07-03T08:00:00Z"
      }
    ],
    "total": 50,
    "page": 1,
    "limit": 20
  }
}
```

### POST /api/wallet/withdraw
Request withdrawal.
```json
Body: {
  "amount": 2000,
  "method": "bank_transfer",
  "accountNumber": "1234567890",
  "bankName": "GTBank"
}

Response: {
  "success": true,
  "data": {
    "message": "Withdrawal request submitted",
    "withdrawal": {
      "id": "uuid",
      "amount": 2000,
      "status": "pending"
    },
    "newBalance": 8000
  }
}
```

---

## 👤 Admin Endpoints (Auth Required + is_admin=true)

### Auth
Use Bearer token with admin account.

### GET /api/admin/stats
Dashboard statistics.
```json
Response: {
  "success": true,
  "data": {
    "playsToday": 150,
    "revenueToday": 75000,
    "payoutsToday": 125000,
    "profitToday": -50000,
    "totalPlayers": 200,
    "pendingWithdrawals": 5
  }
}
```

### GET /api/admin/questions
List all questions.
```json
Response: {
  "success": true,
  "data": {
    "questions": [...],
    "total": 100,
    "page": 1,
    "limit": 20
  }
}
```

### POST /api/admin/questions
Create question.
```json
Body: {
  "door_id": 1,
  "text": "What is the capital?",
  "format": "multiple_choice",
  "difficulty": "easy",
  "prize": 1000,
  "options": ["A", "B", "C", "D"],
  "correct_answer": "C"
}
```

### PUT /api/admin/doors/:id
Update door (including entry fee).
```json
Body: {
  "entry_fee": 500,
  "question_id": "uuid"
}
```

### GET /api/admin/pills
List all pills.

### POST /api/admin/pills
Create pill.
```json
Body: {
  "question": "What is 2+2?",
  "category": "Math",
  "entry_fee": 500,
  "prize": 2000,
  "format": "multiple_choice",
  "options": ["3", "4", "5", "6"],
  "correct_answer": "4",
  "timer_seconds": 30
}
```

### GET /api/admin/predictions
List all predictions.

### POST /api/admin/predictions
Create prediction.
```json
Body: {
  "question": "How many goals?",
  "category": "Football",
  "entry_fee": 500,
  "prize_per_winner": 5000,
  "max_participants": 10,
  "countdown_seconds": 3600
}
```

### POST /api/admin/predictions/:id/mark-answer
Mark correct answer and credit winners.
```json
Body: {
  "correctAnswer": "2"
}

Response: {
  "success": true,
  "data": {
    "message": "Prediction marked and winners credited",
    "prediction": {
      "id": "uuid",
      "correctAnswer": "2",
      "totalParticipants": 8,
      "winners": 3,
      "totalPrizeDistributed": 15000
    }
  }
}
```

### POST /api/admin/predictions/:id/cancel
Cancel prediction and refund all.
```json
Response: {
  "success": true,
  "data": {
    "message": "Prediction cancelled. 8 participants refunded.",
    "refundedCount": 8,
    "totalRefunded": 4000
  }
}
```

---

## 🔔 Webhook Endpoints

### POST /api/paystack/webhook
Paystack webhook handler (signature verified).
- Event: `charge.success` → Auto-credit wallet
- Logged to `webhook_logs` table
- Idempotency: Won't double-credit

---

## 📊 Error Responses

### Insufficient Balance (402)
```json
{
  "success": false,
  "error": "Insufficient balance"
}
```

### Pill Already Played (409)
```json
{
  "success": false,
  "error": "Pill already played"
}
```

### Prediction Full (409)
```json
{
  "success": false,
  "error": "Prediction full"
}
```

### Unauthorized (401)
```json
{
  "success": false,
  "error": "Unauthorized"
}
```

### Not Found (404)
```json
{
  "success": false,
  "error": "Prediction not found"
}
```

---

## 🚀 Rate Limits

- **Auth endpoints**: 10 requests/minute per IP
- **Game endpoints** (play, submit, pills, predictions): 30 requests/minute per IP
- **Other endpoints**: No limit

---

## ✅ Features Summary

| Feature | Status | Notes |
|---------|--------|-------|
| 3-Door Quiz Game | ✅ Complete | Questions, prizes, entry fees |
| PILLS Game | ✅ Complete | Multiple formats, timers |
| PREDICTIONS Game | ✅ Complete | Countdowns, auto-locking |
| Wallet Integration | ✅ Complete | Deposits, withdrawals, transactions |
| Paystack Payments | ✅ Complete | Webhook verification |
| Admin Dashboard | ✅ Complete | Stats, management endpoints |
| Rate Limiting | ✅ Complete | Per endpoint |
| Error Logging | ✅ Complete | Saved to database |
| Authentication | ✅ Complete | JWT bearer tokens |
| CORS | ✅ Complete | Vercel frontend allowed |

---

## 🎯 Ready for Integration!

Frontend can now integrate all three games with complete API coverage. All endpoints are live and tested on Railway.

**Questions?** Check the endpoint response format and error codes above.
