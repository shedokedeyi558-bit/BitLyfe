const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');

const router = express.Router();

// In-memory OTP store (replace with Redis or DB in production)
const otpStore = new Map();

// ─── SMS HELPER ───────────────────────────────────────────────────────────────

/**
 * Send an OTP via Termii SMS gateway.
 * Returns { success: boolean, error?: string }
 */
async function sendSmsOtp(phone, otp) {
  const apiKey = process.env.TERMII_API_KEY;
  if (!apiKey) {
    console.warn('[OTP] TERMII_API_KEY not set — SMS not sent. OTP:', otp);
    return { success: false, error: 'SMS provider not configured' };
  }

  try {
    const res = await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: phone,
        from: 'Bitlyfe',
        sms: `Your Bitlyfe verification code is: ${otp}. Valid for 10 minutes.`,
        type: 'plain',
        channel: 'generic',
        api_key: apiKey,
      }),
    });

    const data = await res.json();

    if (!res.ok || data.code === 'error' || data.message?.toLowerCase().includes('error')) {
      console.error('[OTP] Termii error:', JSON.stringify(data));
      return { success: false, error: data.message || 'SMS failed' };
    }

    console.log(`[OTP] Sent to ${phone} — Termii message_id: ${data.message_id || 'ok'}`);
    return { success: true };
  } catch (err) {
    console.error('[OTP] Termii fetch error:', err.message);
    return { success: false, error: err.message };
  }
}

// In-memory store for password-reset OTPs: phone → { otp, expires }
const resetOtpStore = new Map();

// In-memory store for password-reset tokens: token → { playerId, expires }
const resetTokenStore = new Map();

// Per-phone rate-limit tracker for auth endpoints: phone → [timestamp, ...]
const authAttemptStore = new Map();

// ─── AUTH RATE LIMITER ────────────────────────────────────────────────────────
// 5 attempts per phone per 15-minute window.
// Call this BEFORE doing any real work; it returns null when allowed,
// or a { status, body } object to return immediately when blocked.
function checkAuthRateLimit(phone) {
  const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
  const MAX_ATTEMPTS = 5;
  const now = Date.now();

  const attempts = (authAttemptStore.get(phone) || []).filter((t) => now - t < WINDOW_MS);
  attempts.push(now);
  authAttemptStore.set(phone, attempts);

  if (attempts.length > MAX_ATTEMPTS) {
    const oldestInWindow = attempts[attempts.length - MAX_ATTEMPTS - 1];
    const retryAfterMs = WINDOW_MS - (now - oldestInWindow);
    const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
    return {
      status: 429,
      body: {
        success: false,
        code: 'TOO_MANY_ATTEMPTS',
        error: 'Too many attempts. Please try again later.',
        retry_after_seconds: retryAfterSeconds,
      },
    };
  }

  return null; // allowed
}

/**
 * Generate a unique 6-char alphanumeric referral code
 * Retries up to 5 times on collision (astronomically unlikely)
 */
async function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1 to avoid confusion
  for (let attempt = 0; attempt < 5; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    // Check uniqueness
    const { data } = await supabase
      .from('players')
      .select('id')
      .eq('referral_code', code)
      .maybeSingle();
    if (!data) return code; // no collision
  }
  // Fallback: use part of a UUID (guaranteed unique enough)
  return uuidv4().replace(/-/g, '').substring(0, 8).toUpperCase();
}

/**
 * Email validation helper
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Phone validation helper (Nigerian format or 10-11 digits)
 */
function validatePhone(phone) {
  if (!phone) return false;
  const normalized = phone.trim().replace(/\s+/g, '');
  return /^\d{10,11}$/.test(normalized) || /^\+234\d{10}$/.test(normalized);
}

/**
 * Normalize phone number
 */
function normalizePhone(phone) {
  let normalized = phone.trim().replace(/\s+/g, '');
  // Convert 0 prefix to +234
  if (normalized.startsWith('0')) {
    normalized = '+234' + normalized.slice(1);
  }
  return normalized;
}

/**
 * Generate JWT token — includes token_version so server-side invalidation works.
 * token_version defaults to 0 if not present (existing rows without the column).
 */
function generateToken(player) {
  return jwt.sign(
    {
      playerId: player.id,
      email: player.email,
      is_admin: player.is_admin,
      token_version: player.token_version ?? 0,
    },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// ─── NEW UNIFIED AUTH ENDPOINTS ───────────────────────────────────────────

/**
 * POST /api/auth/signup
 * Register a new player with email and password
 * Optional query param: ?ref=CODE (referral code of the referring player)
 */
router.post('/signup', async (req, res) => {
  try {
    const { email, password, phone, name } = req.body;
    const refCode = req.query.ref || req.body.ref || null;

    // Validate required fields
    if (!email || !password || !phone) {
      return res.status(400).json({
        success: false,
        error: 'email, password, and phone are required',
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }

    if (!validatePhone(phone)) {
      return res.status(400).json({ success: false, error: 'Invalid phone number format' });
    }

    const normalizedPhone = normalizePhone(phone);

    // Rate limit by phone
    const rateLimitResult = checkAuthRateLimit(normalizedPhone);
    if (rateLimitResult) return res.status(rateLimitResult.status).json(rateLimitResult.body);

    const normalizedEmail = email.trim().toLowerCase();

    const { data: existingEmail } = await supabase
      .from('players')
      .select('id')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (existingEmail) {
      return res.status(400).json({ success: false, error: 'Email already exists' });
    }

    const { data: existingPhone } = await supabase
      .from('players')
      .select('id')
      .eq('phone', normalizedPhone)
      .maybeSingle();

    if (existingPhone) {
      return res.status(400).json({ success: false, error: 'Phone number already registered' });
    }

    // Resolve referrer if ref code provided
    let referrerId = null;
    if (refCode) {
      const { data: referrer } = await supabase
        .from('players')
        .select('id')
        .eq('referral_code', refCode.trim().toUpperCase())
        .maybeSingle();
      if (referrer) referrerId = referrer.id;
      // Invalid codes are silently ignored — don't block signup
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const { data: settings } = await supabase
      .from('app_settings')
      .select('new_user_bonus')
      .eq('id', 1)
      .single();

    const newUserBonus = settings?.new_user_bonus ?? 0;

    // Generate unique referral code for this new player
    const newReferralCode = await generateReferralCode();

    const { data: player, error: insertErr } = await supabase
      .from('players')
      .insert({
        email: normalizedEmail,
        password_hash: passwordHash,
        phone: normalizedPhone,
        name: name || null,
        balance: newUserBonus,
        is_admin: false,
        referral_code: newReferralCode,
      })
      .select('id, email, phone, name, balance, is_admin, referral_code')
      .single();

    if (insertErr) {
      console.error('Signup insert error:', insertErr);
      return res.status(500).json({ success: false, error: 'Failed to create account' });
    }

    // Credit welcome bonus if applicable
    if (newUserBonus > 0) {
      await supabase.from('transactions').insert({
        player_id: player.id,
        type: 'bonus',
        amount: newUserBonus,
        description: 'Welcome bonus',
      });
    }

    // Create referral row if a valid referrer was found
    if (referrerId) {
      await supabase.from('referrals').insert({
        referrer_id: referrerId,
        referee_id: player.id,
        status: 'pending',
        first_deposit_done: false,
        first_game_done: false,
        first_deposit_amount: 0,
      });
    }

    const token = generateToken(player);

    return res.status(201).json({
      success: true,
      data: {
        token,
        player: {
          id: player.id,
          email: player.email,
          phone: player.phone,
          name: player.name,
          balance: player.balance,
          is_admin: player.is_admin,
          referral_code: player.referral_code,
        },
      },
    });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ success: false, error: 'Signup failed' });
  }
});

/**
 * POST /api/auth/signin
 * Sign in with email and password
 */
router.post('/signin', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'email and password are required' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Rate limit by email (use as identifier)
    const rateLimitResult = checkAuthRateLimit(normalizedEmail);
    if (rateLimitResult) return res.status(rateLimitResult.status).json(rateLimitResult.body);

    // Fetch player by email
    const { data: player, error } = await supabase
      .from('players')
      .select('id, email, password_hash, phone, name, balance, is_admin, status, token_version')
      .eq('email', normalizedEmail)
      .single();

    if (error || !player) {
      return res.status(401).json({ success: false, error: 'Email or password incorrect' });
    }

    // Check if account is banned
    if (player.status === 'banned') {
      return res.status(403).json({ success: false, error: 'This account has been banned' });
    }

    // Verify password
    if (!player.password_hash) {
      return res.status(401).json({ success: false, error: 'Email or password incorrect' });
    }

    const passwordMatch = await bcrypt.compare(password, player.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ success: false, error: 'Email or password incorrect' });
    }

    // Generate token
    const token = generateToken(player);

    return res.json({
      success: true,
      data: {
        token,
        player: {
          id: player.id,
          email: player.email,
          phone: player.phone,
          name: player.name,
          balance: player.balance,
          is_admin: player.is_admin,
        },
      },
    });
  } catch (err) {
    console.error('Signin error:', err);
    return res.status(500).json({ success: false, error: 'Signin failed' });
  }
});

// ─── LEGACY OTP ENDPOINTS (BACKWARD COMPATIBILITY) ────────────────────────

/**
 * POST /api/auth/register
 * Legacy endpoint: Register by phone and send OTP
 */
router.post('/register', async (req, res) => {
  try {
    const { phone, name } = req.body;
    const refCode = req.query.ref || req.body.ref || null;

    if (!phone) {
      return res.status(400).json({ success: false, error: 'Phone number is required' });
    }

    const normalizedPhone = normalizePhone(phone);

    const { data: existing } = await supabase
      .from('players')
      .select('id, phone, status')
      .eq('phone', normalizedPhone)
      .maybeSingle();

    if (existing && existing.status === 'banned') {
      return res.status(403).json({ success: false, error: 'This account has been banned' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(normalizedPhone, { otp, expires: Date.now() + 10 * 60 * 1000 });
    // SMS OTP disabled — no provider configured
    // console.log(`[OTP] ${normalizedPhone} → ${otp}`);

    if (existing) {
      // Existing player — return token directly, no OTP step needed
      const freshPlayer = await supabase
        .from('players')
        .select('id, phone, name, balance, bonus_balance, status, is_admin, token_version')
        .eq('id', existing.id)
        .single();

      if (freshPlayer.data) {
        const token = generateToken(freshPlayer.data);
        return res.json({
          success: true,
          data: {
            token,
            player: {
              id: freshPlayer.data.id,
              phone: freshPlayer.data.phone,
              name: freshPlayer.data.name,
              balance: freshPlayer.data.balance,
              is_admin: freshPlayer.data.is_admin,
            },
            message: 'Welcome back!',
            isExisting: true,
          },
        });
      }

      return res.json({
        success: true,
        data: { message: 'Welcome back!', isExisting: true, phone: normalizedPhone },
      });
    }

    // Resolve referrer
    let referrerId = null;
    if (refCode) {
      const { data: referrer } = await supabase
        .from('players')
        .select('id')
        .eq('referral_code', refCode.trim().toUpperCase())
        .maybeSingle();
      if (referrer) referrerId = referrer.id;
    }

    const { data: settings } = await supabase
      .from('app_settings')
      .select('new_user_bonus')
      .eq('id', 1)
      .single();

    const newUserBonus = settings?.new_user_bonus ?? 0;
    const newReferralCode = await generateReferralCode();

    const { data: player, error } = await supabase
      .from('players')
      .insert({
        phone: normalizedPhone,
        name: name || null,
        balance: newUserBonus,
        is_admin: false,
        referral_code: newReferralCode,
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to create player' });
    }

    if (newUserBonus > 0) {
      await supabase.from('transactions').insert({
        player_id: player.id,
        type: 'bonus',
        amount: newUserBonus,
        description: 'Welcome bonus',
      });
    }

    // Create referral row if a valid referrer was found
    if (referrerId) {
      await supabase.from('referrals').insert({
        referrer_id: referrerId,
        referee_id: player.id,
        status: 'pending',
        first_deposit_done: false,
        first_game_done: false,
        first_deposit_amount: 0,
      });
    }

    // Welcome notification for new players only
    await supabase.from('notifications').insert({
      player_id: player.id,
      type: 'announcement',
      title: 'Welcome, Scholar! 🎓',
      message: "Time to get rich. You're smart enough to win any challenge thrown at you. Browse packs, participate in live events, and start stacking wins.",
      read: false,
    }).catch(() => {}); // fire-and-forget — never block signup on notification failure

    return res.status(201).json({
      success: true,
      data: {
        token: generateToken(player),
        player: {
          id: player.id,
          phone: player.phone,
          name: player.name,
          balance: player.balance,
          is_admin: player.is_admin,
        },
        message: 'Account created!',
        isExisting: false,
      },
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

/**
 * POST /api/auth/verify-otp
 * Legacy endpoint: Verify OTP (MVP: accept any 6-digit code)
 * Optional: pass password in body to store a hashed password for phone-signin
 */
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp, password } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ success: false, error: 'Phone and OTP are required' });
    }

    const normalizedPhone = normalizePhone(phone);

    // Rate limit
    const rateLimitResult = checkAuthRateLimit(normalizedPhone);
    if (rateLimitResult) return res.status(rateLimitResult.status).json(rateLimitResult.body);

    // Validate against stored OTP
    const stored = otpStore.get(normalizedPhone);
    if (!stored) {
      return res.status(400).json({ success: false, error: 'No OTP found for this number. Please request a new code.' });
    }
    if (Date.now() > stored.expires) {
      otpStore.delete(normalizedPhone);
      return res.status(400).json({ success: false, error: 'OTP has expired. Please request a new code.' });
    }
    if (stored.otp !== String(otp).trim()) {
      return res.status(400).json({ success: false, error: 'Incorrect OTP. Please try again.' });
    }

    // OTP valid — consume it (single use)
    otpStore.delete(normalizedPhone);

    // Fetch player
    const { data: player, error } = await supabase
      .from('players')
      .select('id, phone, name, balance, status, is_admin, token_version')
      .eq('phone', normalizedPhone)
      .single();

    if (error || !player) {
      return res.status(404).json({ success: false, error: 'Player not found. Please register first.' });
    }

    if (player.status === 'banned') {
      return res.status(403).json({ success: false, error: 'Your account has been banned' });
    }

    // If password provided, hash and store it
    if (password) {
      const password_hash = await bcrypt.hash(password, 10);
      await supabase
        .from('players')
        .update({ password_hash })
        .eq('id', player.id);
    }

    const token = generateToken(player);

    return res.json({
      success: true,
      data: {
        token,
        player: {
          id: player.id,
          phone: player.phone,
          name: player.name,
          balance: player.balance,
          is_admin: player.is_admin,
        },
      },
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    return res.status(500).json({ success: false, error: 'OTP verification failed' });
  }
});

/**
 * POST /api/auth/phone-signin
 * Sign in with phone number and password (no OTP required)
 */
router.post('/phone-signin', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ success: false, error: 'Phone and password are required.' });
    }

    const normalizedPhone = normalizePhone(phone);

    // Rate limit
    const rateLimitResult = checkAuthRateLimit(normalizedPhone);
    if (rateLimitResult) return res.status(rateLimitResult.status).json(rateLimitResult.body);

    // Fetch player by phone
    const { data: player, error } = await supabase
      .from('players')
      .select('id, phone, password_hash, name, balance, is_admin, status, token_version')
      .eq('phone', normalizedPhone)
      .single();

    if (error || !player) {
      return res.status(401).json({ success: false, error: 'Player not found. Please sign up first.' });
    }

    // Check if banned
    if (player.status === 'banned') {
      return res.status(403).json({ success: false, error: 'This account has been banned.' });
    }

    // Check if password exists
    if (!player.password_hash) {
      return res.status(401).json({ success: false, error: 'Incorrect password.' });
    }

    // Compare password
    const passwordMatch = await bcrypt.compare(password, player.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ success: false, error: 'Incorrect password.' });
    }

    // Generate token (same shape as verify-otp)
    const token = generateToken(player);

    return res.json({
      success: true,
      data: {
        token,
        player: {
          id: player.id,
          phone: player.phone,
          name: player.name,
          balance: player.balance,
        },
      },
    });
  } catch (err) {
    console.error('Phone signin error:', err);
    return res.status(500).json({ success: false, error: 'Server error.' });
  }
});

/**
 * POST /api/auth/admin-login
 * Legacy endpoint: Admin login with email and password
 */
router.post('/admin-login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    // First try new unified system (players table with is_admin)
    const { data: player } = await supabase
      .from('players')
      .select('id, email, password_hash, is_admin')
      .eq('email', email.trim().toLowerCase())
      .eq('is_admin', true)
      .maybeSingle();

    if (player && player.password_hash) {
      const isMatch = await bcrypt.compare(password, player.password_hash);
      if (isMatch) {
        const token = jwt.sign(
          { playerId: player.id, adminId: player.id, email: player.email, is_admin: true },
          process.env.JWT_SECRET,
          { expiresIn: '30m' }   // 30-minute admin sessions
        );
        return res.json({
          success: true,
          data: {
            token,
            admin: { id: player.id, email: player.email },
          },
        });
      }
    }

    // Fall back to old admins table
    const { data: admin, error } = await supabase
      .from('admins')
      .select('id, email, password_hash')
      .eq('email', email.trim().toLowerCase())
      .maybeSingle();

    if (!admin) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, admin.password_hash);

    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = jwt.sign({ adminId: admin.id, email: admin.email }, process.env.JWT_SECRET, {
      expiresIn: '30m',    // 30-minute admin sessions
    });

    return res.json({
      success: true,
      data: {
        token,
        admin: { id: admin.id, email: admin.email },
      },
    });
  } catch (err) {
    console.error('Admin login error:', err);
    return res.status(500).json({ success: false, error: 'Admin login failed' });
  }
});

// ─── FORGOT PASSWORD FLOW ─────────────────────────────────────────────────────

/**
 * POST /api/auth/forgot-password
 * Generate and send a 6-digit OTP to the player's phone.
 * Rate-limited: 5 attempts per phone per 15 min.
 */
router.post('/forgot-password', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'phone is required' });

    const normalizedPhone = normalizePhone(phone);

    const rateLimitResult = checkAuthRateLimit(normalizedPhone);
    if (rateLimitResult) return res.status(rateLimitResult.status).json(rateLimitResult.body);

    // Always respond the same way whether the phone exists or not (prevents enumeration)
    const { data: player } = await supabase
      .from('players')
      .select('id')
      .eq('phone', normalizedPhone)
      .maybeSingle();

    if (player) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      resetOtpStore.set(normalizedPhone, { otp, expires: Date.now() + 10 * 60 * 1000 });
      console.log(`[RESET OTP] ${normalizedPhone} → ${otp}`);
      await sendSmsOtp(normalizedPhone, otp);
    }

    return res.json({
      success: true,
      data: { message: 'If that phone number is registered, an OTP has been sent.' },
    });
  } catch (err) {
    console.error('Forgot-password error:', err);
    return res.status(500).json({ success: false, error: 'Failed to process request' });
  }
});

/**
 * POST /api/auth/verify-reset-otp
 * Validate the reset OTP. Returns a short-lived reset token (10 min).
 * Rate-limited: 5 attempts per phone per 15 min.
 */
router.post('/verify-reset-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) {
      return res.status(400).json({ success: false, error: 'phone and otp are required' });
    }

    const normalizedPhone = normalizePhone(phone);

    const rateLimitResult = checkAuthRateLimit(normalizedPhone);
    if (rateLimitResult) return res.status(rateLimitResult.status).json(rateLimitResult.body);

    const entry = resetOtpStore.get(normalizedPhone);
    if (!entry || Date.now() > entry.expires || entry.otp !== String(otp)) {
      return res.status(400).json({ success: false, error: 'Invalid or expired OTP' });
    }

    // Consume OTP — single use
    resetOtpStore.delete(normalizedPhone);

    // Fetch player to bind token to their ID
    const { data: player } = await supabase
      .from('players')
      .select('id')
      .eq('phone', normalizedPhone)
      .maybeSingle();

    if (!player) {
      return res.status(404).json({ success: false, error: 'Player not found' });
    }

    // Generate a short-lived reset token
    const resetToken = require('crypto').randomBytes(32).toString('hex');
    resetTokenStore.set(resetToken, { playerId: player.id, expires: Date.now() + 10 * 60 * 1000 });

    return res.json({
      success: true,
      data: { reset_token: resetToken },
    });
  } catch (err) {
    console.error('Verify-reset-otp error:', err);
    return res.status(500).json({ success: false, error: 'Failed to verify OTP' });
  }
});

/**
/**
 * POST /api/auth/reset-password
 * Option B — phone-number-is-identity reset.
 * No OTP required. Player provides phone + new password.
 * If phone is registered, password is updated and a new JWT is returned.
 * Security model matches signup (phone number = proof of identity).
 *
 * Body: { phone, new_password }
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { phone, new_password } = req.body;

    if (!phone || !new_password) {
      return res.status(400).json({ success: false, error: 'phone and new_password are required' });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }

    const normalizedPhone = normalizePhone(phone);

    // Rate limit
    const rateLimitResult = checkAuthRateLimit(normalizedPhone);
    if (rateLimitResult) return res.status(rateLimitResult.status).json(rateLimitResult.body);

    const { data: player } = await supabase
      .from('players')
      .select('id, phone, name, balance, status, is_admin, token_version')
      .eq('phone', normalizedPhone)
      .maybeSingle();

    if (!player) {
      return res.status(404).json({ success: false, error: 'Phone number not registered' });
    }

    if (player.status === 'banned') {
      return res.status(403).json({ success: false, error: 'This account has been banned' });
    }

    const password_hash = await bcrypt.hash(new_password, 10);
    // Increment token_version to invalidate all existing sessions
    const newVersion = (player.token_version ?? 0) + 1;

    await supabase
      .from('players')
      .update({ password_hash, token_version: newVersion })
      .eq('id', player.id);

    const updatedPlayer = { ...player, token_version: newVersion };
    const token = generateToken(updatedPlayer);

    return res.json({
      success: true,
      data: {
        token,
        player: {
          id: player.id,
          phone: player.phone,
          name: player.name,
          balance: player.balance,
          is_admin: player.is_admin,
        },
        message: 'Password reset successful.',
      },
    });
  } catch (err) {
    console.error('Reset-password error:', err);
    return res.status(500).json({ success: false, error: 'Failed to reset password' });
  }
});

// ─── CHANGE PASSWORD (LOGGED IN) ─────────────────────────────────────────────

/**
 * POST /api/auth/change-password
 * Change password while authenticated. Requires current password confirmation.
 * Does NOT invalidate other sessions — use /logout-all for that.
 */
router.post('/change-password', require('../middleware/auth'), async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const player = req.player;

    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, error: 'current_password and new_password are required' });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ success: false, error: 'New password must be at least 6 characters' });
    }

    // Fetch the hash — auth middleware only selects limited fields
    const { data: full } = await supabase
      .from('players')
      .select('password_hash')
      .eq('id', player.id)
      .single();

    if (!full?.password_hash) {
      return res.status(400).json({ success: false, error: 'No password set on this account' });
    }

    const match = await bcrypt.compare(current_password, full.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, error: 'Current password is incorrect' });
    }

    const password_hash = await bcrypt.hash(new_password, 10);
    await supabase.from('players').update({ password_hash }).eq('id', player.id);

    return res.json({
      success: true,
      data: { message: 'Password changed successfully.' },
    });
  } catch (err) {
    console.error('Change-password error:', err);
    return res.status(500).json({ success: false, error: 'Failed to change password' });
  }
});

// ─── LOGOUT ALL ───────────────────────────────────────────────────────────────

/**
 * POST /api/auth/logout-all
 * Increments token_version, immediately invalidating every token issued for this account.
 * Client should discard its token after calling this.
 */
router.post('/logout-all', require('../middleware/auth'), async (req, res) => {
  try {
    const player = req.player;

    const { data: full } = await supabase
      .from('players')
      .select('token_version')
      .eq('id', player.id)
      .single();

    const newVersion = (full?.token_version ?? 0) + 1;

    await supabase.from('players').update({ token_version: newVersion }).eq('id', player.id);

    return res.json({
      success: true,
      data: { message: 'All sessions invalidated. Please log in again.' },
    });
  } catch (err) {
    console.error('Logout-all error:', err);
    return res.status(500).json({ success: false, error: 'Failed to invalidate sessions' });
  }
});

module.exports = router;
