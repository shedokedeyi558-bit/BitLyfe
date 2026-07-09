# 🚀 Seed Endpoint - Quick Reference

## One-Liner Test

```bash
# Copy & paste this entire command to test the seed endpoint:
TOKEN=$(curl -s -X POST https://bitlyfe-production.up.railway.app/api/auth/admin-login -H "Content-Type: application/json" -d '{"email":"shedokedeyi558@gmail.com","password":"Sapphire558"}' | jq -r '.data.token') && curl -X POST https://bitlyfe-production.up.railway.app/api/admin/seed -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}' | jq '.'
```

---

## Endpoint Details

| Property | Value |
|----------|-------|
| **URL** | `POST /api/admin/seed` |
| **Full URL** | `https://bitlyfe-production.up.railway.app/api/admin/seed` |
| **Auth Required** | ✅ Yes (Bearer token) |
| **Method** | POST |
| **Body** | `{}` (empty) |
| **Response Code** | 201 (success) or 401/500 (error) |

---

## What Gets Created

```
📦 Pill Packs (3)
├─ General Knowledge (active) - 3 pills
├─ Sports (draft) - 2 pills
└─ Entertainment (active) - 4 pills
   
🎰 Predictions (3)
├─ Active (15 players)
├─ Locked (30 players)
└─ Draft (0 players)

⚡ Tournaments (3)
├─ Registration (25 players)
├─ Active/Running (100 players)
└─ Completed (80 players + leaderboard)
```

---

## Step-by-Step

### 1. Get Admin Token
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/auth/admin-login \
  -H "Content-Type: application/json" \
  -d '{"email":"shedokedeyi558@gmail.com","password":"Sapphire558"}'

# Save the token value from: response → data → token
```

### 2. Call Seed Endpoint
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/admin/seed \
  -H "Authorization: Bearer <YOUR_TOKEN_HERE>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### 3. Verify
```bash
# Check packs created
curl https://bitlyfe-production.up.railway.app/api/admin/pills/packs \
  -H "Authorization: Bearer <YOUR_TOKEN_HERE>" | jq '.data.packs | length'
# Should show: 3
```

---

## Success Response (201)

```json
{
  "success": true,
  "data": {
    "packs_created": 3,
    "predictions_created": 3,
    "blitz_created": 3,
    "message": "Seed data created successfully"
  }
}
```

---

## Error Responses

### 401 - Unauthorized
```json
{"success": false, "error": "Admin authentication required"}
```
**Fix**: Get a valid admin token first

### 500 - Server Error
```json
{"success": false, "error": "Failed to create seed data: ..."}
```
**Fix**: Check database connection, server logs

---

## Data Breakdown

### Pills by Pack

| Pack | Name | Count | Status | Entry Fee | Prize |
|------|------|-------|--------|-----------|-------|
| 1 | General Knowledge | 3 | Active | ₦200 | ₦1000 |
| 2 | Sports | 2 | Draft | ₦500 | ₦2000 |
| 3 | Entertainment | 4 | Active | ₦100 | ₦500 |

### Predictions

| # | Question | Status | Fee | Prize | Players | Countdown |
|---|----------|--------|-----|-------|---------|-----------|
| 1 | Manchester goals? | Active | ₦500 | ₦2000 | 15 | 2h |
| 2 | Bitcoin $50k? | Locked | ₦1000 | ₦5000 | 30 | Expired |
| 3 | Election? | Draft | ₦2000 | ₦10k | 0 | 24h |

### Tournaments

| # | Title | Status | Fee | Players | Prize Pool |
|---|-------|--------|-----|---------|-----------|
| 1 | Speed Quiz | Registration | ₦500 | 25 | ₦12.5k |
| 2 | Football Legends | Active | ₦1000 | 100 | ₦100k |
| 3 | Crypto Quiz | Completed | ₦1000 | 80 | ₦80k |

---

## Admin Credentials

```
Email: shedokedeyi558@gmail.com
Password: Sapphire558
```

---

## Test All Related Endpoints

After seeding:

```bash
TOKEN="<your-token>"

# Pills
curl https://bitlyfe-production.up.railway.app/api/admin/pills/packs \
  -H "Authorization: Bearer $TOKEN" | jq '.data.packs | length'

# Predictions
curl https://bitlyfe-production.up.railway.app/api/admin/predictions \
  -H "Authorization: Bearer $TOKEN" | jq '.data | length'

# Tournaments
curl https://bitlyfe-production.up.railway.app/api/admin/blitz \
  -H "Authorization: Bearer $TOKEN" | jq '.data | length'

# Should show: 3, 3, 3
```

---

## Player-Side Visibility

```bash
PLAYER_TOKEN="<get-from-player-login>"

# Visible pill packs (only active ones)
curl https://bitlyfe-production.up.railway.app/api/pills/packs \
  -H "Authorization: Bearer $PLAYER_TOKEN"
# Shows: 2 packs (General Knowledge + Entertainment, NOT Sports)

# Visible predictions
curl https://bitlyfe-production.up.railway.app/api/predictions/active \
  -H "Authorization: Bearer $PLAYER_TOKEN"
# Shows: 2 predictions (Active + Locked, NOT Draft)

# All tournaments
curl https://bitlyfe-production.up.railway.app/api/blitz \
  -H "Authorization: Bearer $PLAYER_TOKEN"
# Shows: 3 tournaments
```

---

## Postman Import

1. Open Postman
2. Click **Import** → **Raw text**
3. Paste this:

```
POST https://bitlyfe-production.up.railway.app/api/admin/seed
Authorization: Bearer {{token}}
Content-Type: application/json

{}
```

4. Set `{{token}}` variable to your admin token
5. Click **Send**

---

## Safe to Call Multiple Times?

✅ **YES** - Each call creates fresh data independently

```bash
# Call once
curl -X POST https://bitlyfe-production.up.railway.app/api/admin/seed \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'

# Call again - creates MORE data (now 6 packs, 6 predictions, 6 tournaments)
curl -X POST https://bitlyfe-production.up.railway.app/api/admin/seed \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

💡 **To reset**: Run database cleanup SQL first, then reseed

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `401 Unauthorized` | Get fresh admin token |
| `500 Server Error` | Check DB connection, check logs |
| No data showing | Wait 2-3 seconds, refresh |
| Duplicate data | By design, re-run seed to add more |
| Players can't see draft pack | Correct - draft packs are hidden |

---

## Performance

- **Time to create**: ~1-2 seconds
- **Data size**: ~100KB
- **DB impact**: Minimal (15 inserts)
- **Can run**: Anytime, as many times as needed

---

## Key Numbers

| Metric | Count |
|--------|-------|
| Pill packs | 3 |
| Pills total | 9 |
| Prediction questions | 3 |
| Prediction registrations | 45 |
| Tournaments | 3 |
| Tournament questions | 6 |
| Tournament attempts | 80 |
| Prize entries | 10 |

---

## Pill Colors (Hex)

```
#FF4444  - Red
#44FF88  - Green
#8844FF  - Purple
#FFD700  - Gold
#FF69B4  - Hot Pink
#00CED1  - Dark Turquoise
#32CD32  - Lime Green
#FF8C00  - Dark Orange
#9370DB  - Medium Purple
```

---

## Remember

- ✅ Database is clean (only admin account)
- ✅ Seed endpoint is live
- ✅ Safe to call multiple times
- ✅ Creates realistic test data
- ✅ Dashboard will have different statuses to test

---

**Ready to test?** Start with the one-liner at the top! 🚀
