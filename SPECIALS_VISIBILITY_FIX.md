# Specials Visibility Fix

## The Issue
Roxy special pack shows "Check back soon" because its `quiz_expires_at` has already passed.

**Current expiry**: 2026-07-26T13:28:10.555Z (EXPIRED)  
**Needs to be**: Future date to remain visible

---

## Quick Fix: Extend Expiry

### Option 1: Extend by 24 Hours

```javascript
// Run this in Node.js:
require('dotenv').config({ path: '.env' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  const { data, error } = await supabase
    .from('pill_packs')
    .update({ quiz_expires_at: tomorrow.toISOString() })
    .eq('id', 'ad7ae447-84b4-4dfa-b839-c7de94d37eaa')
    .select();
    
  if (error) console.error('Error:', error);
  else console.log('✅ Updated! Pack now expires:', tomorrow.toISOString());
  process.exit(0);
})();
```

### Option 2: Remove Expiry (Never Expires)

```javascript
require('dotenv').config({ path: '.env' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

(async () => {
  const { data, error } = await supabase
    .from('pill_packs')
    .update({ quiz_expires_at: null })
    .eq('id', 'ad7ae447-84b4-4dfa-b839-c7de94d37eaa')
    .select();
    
  if (error) console.error('Error:', error);
  else console.log('✅ Updated! Pack now has no expiry');
  process.exit(0);
})();
```

### Option 3: Custom Expiry Date

Replace `YYYY-MM-DD HH:MM:SS`:

```javascript
const customDate = new Date('2026-07-30T23:59:59Z');  // 2026-07-30 at 11:59 PM UTC
const { data, error } = await supabase
  .from('pill_packs')
  .update({ quiz_expires_at: customDate.toISOString() })
  .eq('id', 'ad7ae447-84b4-4dfa-b839-c7de94d37eaa')
  .select();
```

---

## Verification

After running the fix, check in Supabase:

```sql
SELECT id, name, quiz_expires_at, status
FROM pill_packs
WHERE id = 'ad7ae447-84b4-4dfa-b839-c7de94d37eaa';
```

You should see:
- `quiz_expires_at`: Future date (or NULL if no expiry)
- `status`: 'active'

Then test:
1. Call `GET /api/pills/specials` as any player
2. Roxy should now appear in the list
3. Player who attempted: `user_attempted: true`
4. Player who didn't: `user_attempted: false`

---

## Why This Happened

The Roxy special pack was created with `quiz_expires_at` set to approximately 30 minutes in the future. As time passed, that timestamp became the past, causing the endpoint to filter out the pack.

This is correct behavior for naturally expired quizzes, but if the quiz should remain active longer, the expiry date needs to be extended.

---

## No Backend Changes Needed

The backend code is correct. Only the data (expiry timestamp) needs to be updated.
