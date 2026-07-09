# Test Seed Endpoint

## Quick Test Commands

### 1. Admin Login (Get Token)
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/auth/admin-login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "shedokedeyi558@gmail.com",
    "password": "Sapphire558"
  }'
```

**Save the token from response**: `response.data.token`

### 2. Create Seed Data
Replace `YOUR_ADMIN_TOKEN` with the token from step 1:

```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/admin/seed \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Expected Response (201)**:
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
        { "id": "...", "name": "General Knowledge Pack", "status": "active" },
        { "id": "...", "name": "Sports Pack", "status": "draft" },
        { "id": "...", "name": "Entertainment Pack", "status": "active" }
      ],
      "predictions": [
        { "id": "...", "question": "How many goals will Manchester United score?", "status": "active" },
        { "id": "...", "question": "Will Bitcoin reach $50,000?", "status": "locked" },
        { "id": "...", "question": "Who will win the next election?", "status": "draft" }
      ],
      "tournaments": [
        { "id": "...", "title": "Speed Quiz Challenge", "status": "registration" },
        { "id": "...", "title": "Football Legends", "status": "active" },
        { "id": "...", "title": "Crypto Quiz Showdown", "status": "completed" }
      ]
    }
  }
}
```

### 3. Verify Data Was Created

#### Check Pill Packs
```bash
curl https://bitlyfe-production.up.railway.app/api/admin/pills/packs \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

#### Check Predictions
```bash
curl https://bitlyfe-production.up.railway.app/api/admin/predictions \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

#### Check Tournaments
```bash
curl https://bitlyfe-production.up.railway.app/api/admin/blitz \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

---

## What Should Be Visible in Admin Dashboard

After running seed:

### 1. Pills Section
- ✅ 3 pill packs showing
- ✅ "General Knowledge Pack" and "Entertainment Pack" are active
- ✅ "Sports Pack" is in draft (may not be visible to players)
- ✅ Each pack has pills with different colors
- ✅ Total: 9 pills across 3 packs

### 2. Predictions Section
- ✅ 3 predictions
- ✅ "Manchester United goals" - active, 15 players registered
- ✅ "Bitcoin $50k" - locked, 30 players registered
- ✅ "Election" - draft, 0 players
- ✅ Countdown timers showing for active/locked
- ✅ Participation data visible

### 3. Blitz Tournaments Section
- ✅ 3 tournaments
- ✅ "Speed Quiz Challenge" - registration phase, 25 players
- ✅ "Football Legends" - active/running, 100 players
- ✅ "Crypto Quiz Showdown" - completed, 80 players
- ✅ Leaderboard visible for completed tournament
- ✅ Prize distribution showing for top 10 players

---

## Player-Side Visibility

Players should see:

### 1. Pill Packs (GET /api/pills/packs)
- ✅ "General Knowledge Pack" (active)
- ✅ "Entertainment Pack" (active)
- ✅ Sports Pack (NOT visible - it's draft)
- ✅ Each pill shows color, price, prize

### 2. Active Predictions (GET /api/predictions/active)
- ✅ "Manchester United goals" (active, can enter)
- ✅ "Bitcoin $50k" (locked, cannot enter - full)
- ✅ "Election" (draft - NOT visible)
- ✅ Countdown timer showing time remaining

### 3. Tournaments (GET /api/blitz)
- ✅ "Speed Quiz Challenge" (registration open)
- ✅ "Football Legends" (active - ongoing)
- ✅ "Crypto Quiz Showdown" (completed - can view results only)

---

## Bash Script (All-in-One)

Save as `test_seed.sh`:

```bash
#!/bin/bash

BACKEND_URL="https://bitlyfe-production.up.railway.app"
ADMIN_EMAIL="shedokedeyi558@gmail.com"
ADMIN_PASSWORD="Sapphire558"

# Step 1: Login
echo "🔐 Logging in admin..."
TOKEN=$(curl -s -X POST "$BACKEND_URL/api/auth/admin-login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | grep -o '"token":"[^"]*' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "❌ Login failed"
  exit 1
fi

echo "✅ Token: ${TOKEN:0:20}..."

# Step 2: Seed data
echo "🌱 Creating seed data..."
RESPONSE=$(curl -s -X POST "$BACKEND_URL/api/admin/seed" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}')

echo "$RESPONSE" | jq '.'

if echo "$RESPONSE" | grep -q '"success":true'; then
  echo "✅ Seed data created successfully!"
else
  echo "❌ Failed to create seed data"
  exit 1
fi

echo ""
echo "📊 Verifying data..."
echo ""

# Step 3: Verify
echo "📦 Pill Packs:"
curl -s "$BACKEND_URL/api/admin/pills/packs" \
  -H "Authorization: Bearer $TOKEN" | jq '.data.packs | length'

echo "🎰 Predictions:"
curl -s "$BACKEND_URL/api/admin/predictions" \
  -H "Authorization: Bearer $TOKEN" | jq '.data | length'

echo "⚡ Tournaments:"
curl -s "$BACKEND_URL/api/admin/blitz" \
  -H "Authorization: Bearer $TOKEN" | jq '.data | length'

echo ""
echo "✅ Seed endpoint test complete!"
```

Run with: `bash test_seed.sh`

---

## Postman Collection JSON

Import this into Postman:

```json
{
  "info": { "name": "BitLyfe Seed Test", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  "item": [
    {
      "name": "1. Admin Login",
      "request": {
        "method": "POST",
        "header": [{ "key": "Content-Type", "value": "application/json" }],
        "body": {
          "mode": "raw",
          "raw": "{\"email\":\"shedokedeyi558@gmail.com\",\"password\":\"Sapphire558\"}"
        },
        "url": { "raw": "https://bitlyfe-production.up.railway.app/api/auth/admin-login", "protocol": "https", "host": ["bitlyfe-production", "up", "railway", "app"], "path": ["api", "auth", "admin-login"] }
      }
    },
    {
      "name": "2. Create Seed Data",
      "request": {
        "method": "POST",
        "header": [
          { "key": "Authorization", "value": "Bearer {{token}}" },
          { "key": "Content-Type", "value": "application/json" }
        ],
        "body": { "mode": "raw", "raw": "{}" },
        "url": { "raw": "https://bitlyfe-production.up.railway.app/api/admin/seed", "protocol": "https", "host": ["bitlyfe-production", "up", "railway", "app"], "path": ["api", "admin", "seed"] }
      }
    },
    {
      "name": "3. View Pill Packs",
      "request": {
        "method": "GET",
        "header": [{ "key": "Authorization", "value": "Bearer {{token}}" }],
        "url": { "raw": "https://bitlyfe-production.up.railway.app/api/admin/pills/packs", "protocol": "https", "host": ["bitlyfe-production", "up", "railway", "app"], "path": ["api", "admin", "pills", "packs"] }
      }
    }
  ]
}
```

---

## Status Check

Run this to see current data counts:

```bash
ADMIN_TOKEN="YOUR_TOKEN_HERE"

echo "Current Database Status:"
echo ""

echo "📦 Pill Packs:"
curl -s https://bitlyfe-production.up.railway.app/api/admin/pills/packs \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data.packs | map({name, status}) | .[]'

echo ""
echo "🎰 Predictions:"
curl -s https://bitlyfe-production.up.railway.app/api/admin/predictions \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data | map({question, status}) | .[]'

echo ""
echo "⚡ Tournaments:"
curl -s https://bitlyfe-production.up.railway.app/api/admin/blitz \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data | map({title, status}) | .[]'
```

---

## Done! ✅

The seed endpoint is live and ready. Start with `POST /api/admin/seed` and the admin dashboard will have full test data.
