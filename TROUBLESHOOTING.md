# BitLyfe Backend - Troubleshooting Guide

## Railway Build Failure

### Issue: "Build failed 1 second ago"

This usually means Railway encountered an error during build or startup.

---

## Step 1: Check Railway Logs

1. Go to Railway Dashboard
2. Click your BitLyfe service
3. Go to **Logs** tab
4. Look for error message (usually in red)

---

## Common Error Messages & Fixes

### ❌ Error: "Cannot find module 'express'"

**Cause**: Dependencies not installed

**Fix**:
```bash
# Locally
cd server
npm install

# Then push
git add package-lock.json
git commit -m "Update dependencies"
git push origin main
```

---

### ❌ Error: "Error: connect ECONNREFUSED"

**Cause**: Cannot connect to Supabase

**Fix**:
1. Go to Railway Dashboard
2. Click your service
3. Go to **Variables** tab
4. Add/verify these variables:
   - `SUPABASE_URL` (your Supabase URL)
   - `SUPABASE_ANON_KEY` (your Supabase key)
   - `SUPABASE_SERVICE_KEY` (your service role key)

5. Click **Redeploy** after adding variables

---

### ❌ Error: "Cannot find module '@supabase/supabase-js'"

**Cause**: Package not in package.json

**Fix**:
```bash
cd server
npm install @supabase/supabase-js
git add package*.json
git commit -m "Ensure supabase dependency"
git push origin main
```

---

### ❌ Error: "ENOENT: no such file or directory, open '.env'"

**Cause**: App trying to read .env locally

**Fix**: Ensure `.env` is in `.gitignore` (it is by default)
- All variables should come from Railway dashboard, not .env

---

### ❌ Error: "Port is already in use"

**Cause**: Another process on port 5000

**Fix**:
1. Railway handles ports automatically
2. Make sure `PORT = process.env.PORT || 5000` is in index.js
3. Don't hardcode port number

---

### ❌ Error: "SyntaxError: Unexpected token"

**Cause**: JavaScript syntax error in code

**Fix**:
1. Check which file has the error
2. Fix locally
3. Test: `node -c src/index.js`
4. Push fix

---

### ❌ Error: "Missing JWT_SECRET"

**Cause**: JWT_SECRET not in Railway variables

**Fix**:
1. Go to Railway Dashboard → Variables
2. Add: `JWT_SECRET=your-secret-key`
3. Redeploy

---

### ❌ Error: "npm ERR! code ERESOLVE"

**Cause**: Dependency conflict

**Fix**:
```bash
cd server
rm -rf node_modules package-lock.json
npm install
npm install --legacy-peer-deps
git add package*.json
git commit -m "Fix dependency conflicts"
git push origin main
```

---

### ❌ Error: "Cannot GET /health"

**Cause**: Server not starting or wrong route

**Fix**:
1. Check logs for startup errors
2. Verify routes are mounted in index.js
3. Test locally: `npm run dev`
4. Check if it responds on `http://localhost:5000/health`

---

## Step 2: Verify Configuration

### Check Required Files
- ✅ `Procfile` exists in root
- ✅ `package.json` in server/ directory
- ✅ `src/index.js` exists

### Check Configuration
```bash
# Verify npm start works
cd server
npm start  # Should not error

# Verify syntax
node -c src/index.js
```

---

## Step 3: Test Locally First

Before pushing to Railway, test locally:

```bash
# Install dependencies
cd server
npm install

# Configure .env
cp .env.example .env
# Edit .env with your Supabase & Paystack keys

# Run locally
npm run dev

# Test health endpoint
curl http://localhost:5000/health
```

If this works locally, the issue is Railway configuration, not code.

---

## Step 4: Deploy Correctly

1. **Ensure all code is committed**
   ```bash
   git status  # Should be clean
   ```

2. **Push to main**
   ```bash
   git push origin main
   ```

3. **Railway auto-deploys** when it detects push to main

4. **Watch logs** for build status

---

## Step 5: Debug Build Process

### Enable Debug Logs
1. Railway Dashboard → Settings
2. Look for "Build logs" or "Debug" option
3. View more detailed logs

### Redeploy to Retry
1. Go to Deployments tab
2. Find the failed build
3. Click "Redeploy"
4. It will try again with same code

---

## Emergency Checks

### 1. Is Repository Connected?
- Railway → Settings
- Should show GitHub connection
- Should list "BitLyfe" repository

### 2. Are Variables Set?
- Railway → Variables
- Should have all required env vars
- Check for typos

### 3. Is Procfile Correct?
```
web: cd server && npm install && npm start
```
- Must be exactly this format
- In root directory (not in server/)

### 4. Can You Connect to Supabase?
- Test from local machine
- Check Supabase project is active
- Verify API keys are correct

### 5. Are Credentials Valid?
- Supabase URL: Format `https://xxx.supabase.co`
- Paystack key: Format `pk_test_...` or `pk_live_...`
- JWT secret: Any string, for signing tokens

---

## Manual Troubleshooting

### Option 1: View Full Build Log
```bash
# In Railway Dashboard
Logs tab → Search for error
Filter by "system" to see build steps
```

### Option 2: Check Procfile
```bash
# Verify locally
cd /path/to/BitLyfe
cat Procfile  # Should show: web: cd server && npm install && npm start
```

### Option 3: Verify package.json
```bash
# Check start script
cat server/package.json | grep -A 2 '"scripts"'
```

### Option 4: Test Entry Point
```bash
# Does index.js exist and work?
node -c server/src/index.js  # Should output nothing (good)
```

---

## Common Railway Issues

### Build Takes Too Long
- **Cause**: First deploy installs all node_modules
- **Solution**: Wait or increase build timeout in Railway settings

### Deployment Killed After a While
- **Cause**: App not responding on PORT
- **Solution**: Ensure PORT is set and app listens on it

### Crashed Immediately
- **Cause**: Missing critical dependency or env var
- **Solution**: Check logs, add missing config, redeploy

### Intermittent Errors
- **Cause**: Database connection timeout
- **Solution**: Check Supabase status, verify credentials, increase timeout

---

## Testing Deployed App

Once deployed, test these endpoints:

```bash
# Replace RAILWAY_URL with your Railway domain
RAILWAY_URL="https://your-railway-app.railway.app"

# Test health
curl $RAILWAY_URL/health

# Test signup
curl -X POST $RAILWAY_URL/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test123","phone":"08012345678"}'

# Test games list (requires login first)
curl -X GET $RAILWAY_URL/api/admin/games \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Still Not Working?

1. **Check Railway Status Page**
   - https://status.railway.app
   - Is Railway having issues?

2. **Review All Variables**
   - Are all required env vars set?
   - Any typos in variable names?

3. **Check Code Locally**
   - Does `npm run dev` work locally?
   - Does code have syntax errors?

4. **Clear Railway Cache**
   - Delete previous failed deployments
   - Force a new redeploy

5. **Restart Service**
   - Railway Dashboard → Service
   - Click "Restart" button
   - Check if it stays running

---

## Contact/Support

- **Railway Docs**: https://docs.railway.app
- **GitHub Issues**: Create issue in BitLyfe repository
- **Debug Locally**: Run `npm run dev` and test before pushing

---

**Last Updated**: July 2, 2026  
**For**: BitLyfe Backend Deployment Troubleshooting
