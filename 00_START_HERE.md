# 🚀 START HERE - BitLyfe Backend Setup & Testing

Welcome! This guide helps you get up and running with the BitLyfe backend in minutes.

---

## 📍 Current Status

✅ **Backend**: Live at https://bitlyfe-production.up.railway.app
✅ **Database**: Clean and ready
✅ **Admin Account**: Created and tested
✅ **Seed Endpoint**: Implemented and ready to use

---

## 🎯 Quick Start (5 Minutes)

### Step 1: Get Admin Token
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/auth/admin-login \
  -H "Content-Type: application/json" \
  -d '{"email":"shedokedeyi558@gmail.com","password":"Sapphire558"}' | jq '.data.token'
```

Save the token value (everything between quotes after `"token":"`)

### Step 2: Create Seed Data
```bash
TOKEN="paste_your_token_here"

curl -X POST https://bitlyfe-production.up.railway.app/api/admin/seed \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Response should show:
```json
{
  "success": true,
  "data": {
    "packs_created": 3,
    "predictions_created": 3,
    "blitz_created": 3
  }
}
```

### Step 3: Verify
```bash
curl https://bitlyfe-production.up.railway.app/api/admin/pills/packs \
  -H "Authorization: Bearer $TOKEN" | jq '.data.packs | length'
```

Should show: `3`

✅ **You're done!** Test data is now ready.

---

## 📚 Documentation Files

### For Quick Testing
1. **SEED_QUICK_REFERENCE.md** ⭐ START HERE
   - One-liner commands
   - Data breakdown
   - Troubleshooting

2. **TEST_SEED_ENDPOINT.md**
   - Testing procedures
   - Verification steps
   - Bash scripts

### For Understanding Features
3. **SEED_DATA_GUIDE.md**
   - What gets created
   - Detailed examples
   - Player-side visibility

4. **SEED_ENDPOINT_IMPLEMENTATION.md**
   - Technical details
   - Code structure
   - Database impact

### For Overview
5. **TASK_COMPLETION.md**
   - Task summary
   - Status checklist
   - Next steps

6. **SESSION_SUMMARY.md**
   - Session work recap
   - Database state
   - Performance notes

---

## 🔑 Important Information

### Admin Credentials
```
Email: shedokedeyi558@gmail.com
Password: Sapphire558
```

### Backend URLs
```
Production: https://bitlyfe-production.up.railway.app
Health: GET /health
```

### Database
```
Provider: Supabase
Project: fgwqzhhhcyqfpvlquyxc
Status: ✅ Clean, ready for testing
```

---

## 🎮 What Gets Created by Seed

### Pill Packs (3)
```
✓ General Knowledge Pack (active)        - 3 pills
✓ Sports Pack (draft)                    - 2 pills
✓ Entertainment Pack (active)            - 4 pills
Total: 9 pills with unique colors
```

### Predictions (3)
```
✓ Active (15 players registered)         - 2h countdown
✓ Locked (30 players registered)         - Already expired
✓ Draft (0 players)                      - 24h countdown
Total: 45 dummy participations
```

### Tournaments (3)
```
✓ Registration (25 players)              - Starts in 30 mins
✓ Active (100 players)                   - Running now
✓ Completed (80 players)                 - With leaderboard & prizes
Total: 96 leaderboard entries + prizes
```

---

## 🧪 Testing Plan

### Phase 1: Seed Data (5 min)
- [ ] Get admin token
- [ ] Call `/api/admin/seed`
- [ ] Verify 3 packs created

### Phase 2: Admin Dashboard (10 min)
- [ ] View pill packs
- [ ] View predictions with countdowns
- [ ] View tournaments with leaderboard
- [ ] Check completed tournament prizes

### Phase 3: Player View (10 min)
- [ ] Get player token
- [ ] View pill packs (only 2 active ones)
- [ ] View active predictions
- [ ] Browse tournaments

### Phase 4: Game Flows (Optional)
- [ ] Test playing a pill
- [ ] Test entering a prediction
- [ ] Test registering for tournament

---

## 🔄 Common Tasks

### Get Player Token
```bash
curl -X POST https://bitlyfe-production.up.railway.app/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email":"testplayer@example.com",
    "password":"test123",
    "phone":"08012345678",
    "name":"Test Player"
  }' | jq '.data.token'
```

### Check Admin Stats
```bash
curl https://bitlyfe-production.up.railway.app/api/admin/stats \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.'
```

### View Leaderboard
```bash
# First, get tournament ID from /api/admin/blitz
TOURNAMENT_ID="..."

curl https://bitlyfe-production.up.railway.app/api/admin/blitz/$TOURNAMENT_ID/leaderboard \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data'
```

### Reseed (Clear and Recreate)
```bash
# 1. Clear database (warning: destructive!)
# Run SQL cleanup in Supabase (see DATABASE_CLEANUP.sql)

# 2. Reseed
curl -X POST https://bitlyfe-production.up.railway.app/api/admin/seed \
  -H "Authorization: Bearer $TOKEN" \
  -d '{}'
```

---

## ⚠️ Troubleshooting

### 401 Unauthorized
**Problem**: `"error": "Admin authentication required"`
**Solution**: Get a fresh admin token using the login endpoint

### 500 Server Error
**Problem**: `"error": "Failed to create seed data: ..."`
**Solution**: Check server logs in Railway dashboard

### No Data Appearing
**Problem**: Seed runs but data not visible
**Solution**: Wait 2-3 seconds, then refresh. Check `/api/admin/pills/packs` directly

### Only Some Data Created
**Problem**: 1-2 categories created but not all
**Solution**: This is normal if some rows failed. Retry the seed endpoint

---

## 📊 API Reference

### Core Endpoints Needed

#### Authentication
```
POST /api/auth/admin-login          - Get admin token
POST /api/auth/signup               - Create player
```

#### Seed & View
```
POST /api/admin/seed                - Create test data
GET  /api/admin/pills/packs         - View pill packs
GET  /api/admin/predictions         - View predictions
GET  /api/admin/blitz               - View tournaments
GET  /api/admin/blitz/:id/leaderboard - View results
```

#### Player Game View
```
GET  /api/pills/packs               - View active packs only
GET  /api/predictions/active        - View active predictions
GET  /api/blitz                      - View all tournaments
```

See `API_ENDPOINTS_COMPLETE.md` for all 60+ endpoints.

---

## 🎯 Next Steps

1. **Right now**: Run the quick start (5 minutes)
2. **Then**: Follow the testing plan above (30 minutes)
3. **Optional**: Test complete game flows
4. **Finally**: Move to frontend testing

---

## 💡 Tips & Tricks

### Use Postman?
Import the collection from `TEST_SEED_ENDPOINT.md`

### Want different test data?
Edit `server/src/routes/admin.js` line 575+

### Need to clear everything?
Run the SQL from `DATABASE_CLEANUP.sql` in Supabase

### Checking if backend is alive?
```bash
curl https://bitlyfe-production.up.railway.app/health
```

### Want to automate testing?
Run the bash script from `TEST_SEED_ENDPOINT.md`

---

## 📞 Support

### If something breaks:
1. Check the error message
2. Look in the **Troubleshooting** section above
3. Read the relevant documentation file
4. Check Railway logs for server errors

### Common Documentation
- **SEED_QUICK_REFERENCE.md** - Commands & quick answers
- **TEST_SEED_ENDPOINT.md** - Testing step-by-step
- **SEED_DATA_GUIDE.md** - What everything does

---

## ✅ Verification Checklist

Before moving forward:
- [ ] Admin token obtained successfully
- [ ] Seed endpoint returns 201 success
- [ ] `GET /api/admin/pills/packs` shows 3 packs
- [ ] `GET /api/admin/predictions` shows 3 predictions
- [ ] `GET /api/admin/blitz` shows 3 tournaments
- [ ] Draft pill pack is hidden in player view
- [ ] Draft prediction is hidden in player view
- [ ] Admin dashboard displays all data correctly

---

## 📈 Current System Overview

```
Frontend
   ↓
Backend (Railway)
   ↓ API Requests
   ↓
Supabase Database
   ├─ Players (0 except admin tests)
   ├─ Pill Packs (ready for seed)
   ├─ Predictions (ready for seed)
   ├─ Tournaments (ready for seed)
   └─ All 20+ tables (schema complete)
   ↓
Paystack
   └─ Payment processing
```

---

## 🎓 Learning Resources

### Want to understand the code?
→ `SEED_ENDPOINT_IMPLEMENTATION.md`

### Want to see what's possible?
→ `API_ENDPOINTS_COMPLETE.md`

### Want step-by-step guidance?
→ `SEED_DATA_GUIDE.md`

### Want just the commands?
→ `SEED_QUICK_REFERENCE.md`

---

**You're all set!** 🎉

Start with the Quick Start section above. Everything should work in minutes.

Questions? See the documentation files or check the troubleshooting section.

**Good luck!** 🚀
