# Railway Deployment Guide for BitLyfe

## Quick Deployment Steps

### 1. Prerequisites
- Railway account (https://railway.app)
- GitHub repository connected (already done)
- Environment variables configured

### 2. Railway Configuration

Railway should automatically detect the Node.js project. If the build fails:

#### Option A: Using Procfile (Recommended)
The `Procfile` in the root directory tells Railway how to start the app:
```
web: cd server && npm install && npm start
```

#### Option B: Manual Railway Configuration
In Railway dashboard:
1. **Build Command**: `cd server && npm install`
2. **Start Command**: `cd server && npm start`

### 3. Environment Variables

Set these in Railway dashboard under your project's **Variables**:

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
FRONTEND_URL=https://your-frontend-domain.com
NODE_ENV=production
```

### 4. Deployment Process

1. **Connect Repository**
   - Railway watches GitHub branch
   - Auto-deploys on push to main

2. **Watch Logs**
   - Railway Dashboard → Logs tab
   - See build and runtime logs

3. **Check Status**
   - Railway Dashboard → Services
   - See active deployments and health

### 5. Common Issues & Fixes

#### Build Failed: "No start script"
- **Cause**: `npm start` not defined
- **Fix**: Check `package.json` has `"start": "node src/index.js"`

#### Port Error: "Address already in use"
- **Cause**: Wrong PORT configuration
- **Fix**: Ensure `PORT = process.env.PORT || 5000`

#### Environment Variables Missing
- **Cause**: Variables not set in Railway
- **Fix**: Add all required variables in Railway dashboard

#### Module Not Found
- **Cause**: Dependencies not installed
- **Fix**: Ensure `package-lock.json` exists and is committed

#### Connect Timeout
- **Cause**: Supabase/Paystack credentials wrong
- **Fix**: Verify keys in Railway variables match Supabase/Paystack

### 6. Monitoring & Logs

**View Logs in Railway:**
1. Go to Dashboard
2. Select your BitLyfe service
3. Click "Logs" tab
4. See build output and runtime logs

**Check API Health:**
```bash
curl https://your-railway-url.railway.app/health
```

Should return:
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "timestamp": "2026-07-02T..."
  }
}
```

### 7. Database Configuration

**Supabase Connection:**
- Get URL and keys from Supabase dashboard
- Set in Railway variables (see step 3)
- Ensure RLS policies are enabled

**Database Schema:**
- Run `schema.sql` in Supabase SQL editor
- Update status constraints if needed
- Create admin account

### 8. Testing After Deployment

```bash
# Test health endpoint
curl https://your-railway-url.railway.app/health

# Test signup
curl -X POST https://your-railway-url.railway.app/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test123","phone":"08012345678"}'

# Test admin login
curl -X POST https://your-railway-url.railway.app/api/auth/admin-login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@bitlyfe.com","password":"admin123"}'

# Test games list
curl -X GET https://your-railway-url.railway.app/api/admin/games \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### 9. SSL/HTTPS

Railway provides automatic HTTPS on `*.railway.app` domain.

To use custom domain:
1. Add domain in Railway dashboard
2. Point DNS to Railway nameservers
3. Railway auto-enables SSL

### 10. Scaling

**Initial Setup:**
- 1 instance is fine for development/testing
- Increase to 2+ for production traffic

**Configure in Railway:**
1. Go to Service settings
2. Adjust number of replicas
3. Set CPU/Memory per instance

### 11. Deployment Checklist

- [ ] Procfile exists in root
- [ ] package.json has start script
- [ ] All environment variables set in Railway
- [ ] GitHub repository connected
- [ ] Supabase database ready
- [ ] Paystack test/live keys configured
- [ ] .gitignore excludes .env
- [ ] Latest code committed and pushed
- [ ] Health endpoint responding
- [ ] Admin can login
- [ ] Games endpoints accessible

### 12. Rollback

If deployment fails:
1. Go to Railway dashboard
2. Find previous successful deployment
3. Click "Redeploy"

### 13. Debugging Failed Builds

Check logs for common errors:

**"Cannot find module"**
```
→ Install missing package: npm install <package-name>
→ Add to package.json
→ Commit and push
```

**"Syntax error in src/..."**
```
→ Fix the syntax error locally
→ Test: node -c src/index.js
→ Commit and push
```

**"SUPABASE_URL is not defined"**
```
→ Add SUPABASE_URL to Railway variables
→ Redeploy project
```

### 14. Useful Links

- **Railway Docs**: https://docs.railway.app
- **Node.js Deployment**: https://docs.railway.app/guides/nodejs
- **Environment Variables**: https://docs.railway.app/develop/variables
- **GitHub Integration**: https://docs.railway.app/guides/github

---

## Quick Deploy URL Format

```
https://<railway-project>-<random>.railway.app
```

Example: `https://bitlyfe-prod-abc123.railway.app`

---

## Support

If deployment fails:
1. Check Railway logs
2. Verify environment variables
3. Test locally: `npm run dev`
4. Check GitHub sync
5. Review this guide

---

**Last Updated**: July 2, 2026  
**Status**: Ready for Deployment
