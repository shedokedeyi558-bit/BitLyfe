const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');

const router = express.Router();

// In-memory OTP store (replace with Redis or DB in production)
const otpStore = new Map();

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
 */
router.post('/signup', async (req, res) => {
  try {
    const { email, password, phone, name } = req.body;

    // Validate required fields
    if (!email || !password || !phone) {
      return res.status(400).json({
        success: false,
        error: 'email, password, and phone are required',
      });
    }

    // Validate email format
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    // Validate password length
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }

    // Validate phone
    if (!validatePhone(phone)) {
      return res.status(400).json({ success: false, error: 'Invalid phone number format' });
    }

    // Normalize inputs
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = normalizePhone(phone);

    // Check if email already exists
    const { data: existingEmail } = await supabase
      .from('players')
      .select('id')
      .eq('email', normalizedEmail)
      .single();

    if (existingEmail) {
      return res.status(400).json({ success: false, error: 'Email already exists' });
    }

    // Check if phone already exists
    const { data: existingPhone } = await supabase
      .from('players')
      .select('id')
      .eq('phone', normalizedPhone)
      .single();

    if (existingPhone) {
      return res.status(400).json({ success: false, error: 'Phone number already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Fetch bonus from app_settings
    const { data: settings } = await supabase
      .from('app_settings')
      .select('new_user_bonus')
      .eq('id', 1)
      .single();

    const newUserBonus = settings?.new_user_bonus ?? 0;

    // Create new player
    const { data: player, error: insertErr } = await supabase
      .from('players')
      .insert({
        email: normalizedEmail,
        password_hash: passwordHash,
        phone: normalizedPhone,
        name: name || null,
        balance: newUserBonus,
        is_admin: false,
      })
      .select('id, email, phone, name, balance, is_admin')
      .single();

    if (insertErr) {
      console.error('Signup insert error:', insertErr);
      return res.status(500).json({ success: false, error: 'Failed to create account' });
    }

    // Credit bonus if applicable
    if (newUserBonus > 0) {
      await supabase.from('transactions').insert({
        player_id: player.id,
        type: 'bonus',
        amount: newUserBonus,
        description: 'Welcome bonus',
      });
    }

    // Generate token
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

    if (!phone) {
      return res.status(400).json({ success: false, error: 'Phone number is required' });
    }

    // Normalize phone
    const normalizedPhone = phone.trim().replace(/\s+/g, '');

    // Check if player already exists
    const { data: existing } = await supabase
      .from('players')
      .select('id, phone, status')
      .eq('phone', normalizedPhone)
      .single();

    if (existing && existing.status === 'banned') {
      return res.status(403).json({ success: false, error: 'This account has been banned' });
    }

    // Send OTP regardless of whether player is new or existing
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(normalizedPhone, { otp, expires: Date.now() + 5 * 60 * 1000 });

    console.log(`[OTP] ${normalizedPhone} → ${otp}`);

    if (existing) {
      return res.json({
        success: true,
        data: {
          message: 'Welcome back! OTP sent to your phone.',
          isExisting: true,
        },
      });
    }

    // Create new player (phone-based, no email/password)
    const { data: settings } = await supabase
      .from('app_settings')
      .select('new_user_bonus')
      .eq('id', 1)
      .single();

    const newUserBonus = settings?.new_user_bonus ?? 0;

    const { data: player, error } = await supabase
      .from('players')
      .insert({
        phone: normalizedPhone,
        name: name || null,
        balance: newUserBonus,
        is_admin: false,
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

    return res.status(201).json({
      success: true,
      data: {
        message: 'Account created! OTP sent to your phone.',
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
 */
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ success: false, error: 'Phone and OTP are required' });
    }

    const normalizedPhone = phone.trim().replace(/\s+/g, '');

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
