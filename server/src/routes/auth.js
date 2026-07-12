const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');

const router = express.Router();

// In-memory OTP store (replace with Redis or DB in production)
const otpStore = new Map();

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
 * Generate JWT token
 */
function generateToken(player) {
  return jwt.sign(
    { playerId: player.id, email: player.email, is_admin: player.is_admin },
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

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = normalizePhone(phone);

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

    // Fetch player by email
    const { data: player, error } = await supabase
      .from('players')
      .select('id, email, password_hash, phone, name, balance, is_admin, status')
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
    otpStore.set(normalizedPhone, { otp, expires: Date.now() + 5 * 60 * 1000 });
    console.log(`[OTP] ${normalizedPhone} → ${otp}`);

    if (existing) {
      return res.json({
        success: true,
        data: { message: 'Welcome back! OTP sent to your phone.', isExisting: true, phone: normalizedPhone },
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

    return res.status(201).json({
      success: true,
      data: { message: 'Account created! OTP sent to your phone.', isExisting: false, phone: normalizedPhone },
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

    // MVP: accept any 6-digit OTP
    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ success: false, error: 'OTP must be a 6-digit number' });
    }

    otpStore.delete(normalizedPhone);

    // Fetch player
    const { data: player, error } = await supabase
      .from('players')
      .select('id, phone, name, balance, status, is_admin')
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

    const token = jwt.sign(
      { playerId: player.id, is_admin: player.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

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

    // Fetch player by phone
    const { data: player, error } = await supabase
      .from('players')
      .select('id, phone, password_hash, name, balance, is_admin, status')
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
    const token = jwt.sign(
      { playerId: player.id, is_admin: player.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

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
      .single();

    if (player && player.password_hash) {
      const isMatch = await bcrypt.compare(password, player.password_hash);
      if (isMatch) {
        const token = jwt.sign(
          { playerId: player.id, adminId: player.id, email: player.email, is_admin: true },
          process.env.JWT_SECRET,
          { expiresIn: '7d' }
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
      .single();

    if (error || !admin) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, admin.password_hash);

    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = jwt.sign({ adminId: admin.id, email: admin.email }, process.env.JWT_SECRET, {
      expiresIn: '7d',
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

module.exports = router;
