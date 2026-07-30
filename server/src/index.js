require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const authRoutes = require('./routes/auth');
const gameRoutes = require('./routes/game');
const gamesRoutes = require('./routes/games');
const walletRoutes = require('./routes/wallet');
const adminRoutes = require('./routes/admin');
const withdrawalRoutes = require('./routes/withdrawals');
const challengeRoutes = require('./routes/challenges');
const pillsRoutes = require('./routes/pills');
const predictionsRoutes = require('./routes/predictions');
const adminPillsRoutes = require('./routes/adminPills');
const adminPredictionsRoutes = require('./routes/adminPredictions');
const notificationsRoutes = require('./routes/notifications');
const blitzRoutes = require('./routes/blitz');
const adminBlitzRoutes = require('./routes/adminBlitz');
const { router: referralsRouter } = require('./routes/referrals');
const pillsVipRoutes = require('./routes/pillsVip');
// pillsSpecialRoutes removed — /api/pills/special/* was dead code, superseded by pillsVip.js (/api/pills/vip/*)
const adminSpecialsBankRoutes = require('./routes/adminSpecialsBank');
const supabase = require('./db/supabase');

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Middleware ───────────────────────────────────────────────────────────────

// Trust the Railway/Vercel reverse proxy — required so express-rate-limit
// reads the real client IP from X-Forwarded-For instead of throwing a
// ValidationError (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).
// '1' = trust one hop (the Railway load balancer immediately in front of us).
app.set('trust proxy', 1);

app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:3000',
      'https://bitlyf.vercel.app',
      'https://bitlyfe.vercel.app',
      'http://localhost:3000',
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logger (basic)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10,
  message: { success: false, error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting for game endpoints
const gameLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,
  message: { success: false, error: 'Too many game requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check — no auth, always 200. Used by UptimeRobot to keep Render alive.
app.get('/api/health', (_req, res) => {
  res.status(200).json({ success: true, status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/health', (_req, res) => {
  res.json({ 
    success: true, 
    data: { 
      status: 'ok', 
      version: '1.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString() 
    } 
  });
});

// Terms of service endpoint
app.get('/api/terms', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('site_content')
      .select('content')
      .eq('key', 'terms')
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Terms of service not found' });
    }

    return res.json({ success: true, data: { terms: data.content } });
  } catch (err) {
    console.error('Terms error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch terms of service' });
  }
});

// Game stats endpoint (public)
app.get('/api/game/stats', async (_req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const { data: sessions } = await supabase
      .from('game_sessions')
      .select('entry_fee, prize, status, player_id')
      .gte('played_at', startOfDay.toISOString());

    const totalPlaysToday = sessions?.length || 0;
    const totalRevenueToday = sessions?.reduce((sum, s) => sum + (s.entry_fee || 0), 0) || 0;
    const totalPayoutsToday = sessions?.filter(s => s.status === 'won').reduce((sum, s) => sum + (s.prize || 0), 0) || 0;
    const activePlayersToday = new Set(sessions?.map(s => s.player_id).filter(Boolean)).size;

    return res.json({
      success: true,
      data: {
        totalPlaysToday,
        totalRevenueToday,
        totalPayoutsToday,
        activePlayersToday,
      },
    });
  } catch (err) {
    console.error('Game stats error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch game stats' });
  }
});

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/game/play', gameLimiter);
app.use('/api/game/submit', gameLimiter);
app.use('/api/game', gameRoutes);
app.use('/api/pills', gameLimiter, pillsRoutes);
app.use('/api/pills/vip', gameLimiter, pillsVipRoutes);
// /api/pills/special removed — pillsSpecial.js was dead code (zero frontend calls)
// All Specials/VIP gameplay goes through /api/pills/vip via pillsVip.js
app.use('/api/predictions', gameLimiter, predictionsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/blitz', gameLimiter, blitzRoutes);
// Admin subroutes BEFORE generic /api/admin so they aren't shadowed
app.use('/api/admin/games', gamesRoutes);
app.use('/api/admin/pills', adminPillsRoutes);
app.use('/api/admin/specials-bank', adminSpecialsBankRoutes);
app.use('/api/admin/predictions', adminPredictionsRoutes);
app.use('/api/admin/blitz', adminBlitzRoutes);
app.use('/api/admin/withdrawals', withdrawalRoutes);
app.use('/api/admin/challenges', challengeRoutes);
// Generic admin router (stats, players, settings, analytics, seed, export, etc.)
app.use('/api/admin', adminRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/challenges', challengeRoutes);
app.use('/api/player/referrals', referralsRouter);

// ─── SquadCo Webhook ─────────────────────────────────────────────────────────

/**
 * POST /api/squad/webhook
 * Handles Squad event callbacks (charge_successful, etc.)
 *
 * Signature verification: HMAC-SHA512 of JSON.stringify(req.body) with
 * SQUADCO_SECRET_KEY, uppercased. Header: x-squad-encrypted-body.
 *
 * NOTE: Uses express.json() (parsed body), NOT express.raw().
 * The HMAC is computed over JSON.stringify(req.body) after parsing.
 */
app.post('/api/squad/webhook', express.json(), async (req, res) => {
  try {
    const secret = process.env.SQUADCO_SECRET_KEY;

    if (!secret) {
      console.error('[squad webhook] SQUADCO_SECRET_KEY env var is not set — rejecting webhook');
      return res.status(500).send('Webhook secret not configured');
    }
    const hash = crypto
      .createHmac('sha512', secret)
      .update(JSON.stringify(req.body))
      .digest('hex')
      .toUpperCase();

    if (hash !== req.headers['x-squad-encrypted-body']) {
      await supabase.from('webhook_logs').insert({
        event_type: 'invalid_signature',
        payload: {},
        status: 'rejected',
      });
      return res.status(401).send('Invalid signature');
    }

    const event = req.body; // already parsed

    await supabase.from('webhook_logs').insert({
      event_type: event.Event,
      payload: event,
      status: 'received',
    });

    // Squad deposit event: "charge_successful" (Paystack was "charge.success")
    if (event.Event === 'charge_successful') {
      // Squad webhook payload structure: fields at top level of event, or in event.Body
      // The actual webhook data may be in event directly or nested in event.Body
      const eventData = event.Body || event;
      const { transaction_ref, amount, transaction_status } = eventData;

      // Only process confirmed successes
      if (transaction_status !== 'Success') return res.sendStatus(200);

      const amountNaira = Math.floor(amount / 100);

      // Squad webhooks don't carry metadata the way Paystack did.
      // Look up the pending transaction by reference to retrieve player_id.
      const { data: pendingTxn } = await supabase
        .from('transactions')
        .select('player_id')
        .eq('reference', transaction_ref)
        .eq('type', 'deposit_pending')
        .maybeSingle();

      const playerId = pendingTxn?.player_id;
      if (!playerId) return res.sendStatus(200);

      // Idempotency: skip if already processed
      const { data: existing } = await supabase
        .from('transactions')
        .select('id')
        .eq('reference', transaction_ref)
        .eq('type', 'deposit')
        .maybeSingle();

      if (existing) return res.sendStatus(200);

      // Credit wallet
      const { data: player } = await supabase
        .from('players')
        .select('balance')
        .eq('id', playerId)
        .single();

      if (player) {
        await supabase
          .from('players')
          .update({ balance: (player.balance || 0) + amountNaira })
          .eq('id', playerId);

        await supabase.from('transactions').insert({
          player_id: playerId,
          type: 'deposit',
          amount: amountNaira,
          description: `Deposit of ₦${amountNaira} (webhook)`,
          reference: transaction_ref,
        });

        // Remove pending record so history shows only the settled deposit
        await supabase
          .from('transactions')
          .delete()
          .eq('reference', transaction_ref)
          .eq('type', 'deposit_pending');

        // Trigger referral first-deposit check (fire-and-forget)
        const { checkReferralCompletion } = require('./routes/referrals');
        checkReferralCompletion(playerId, 'deposit', amountNaira).catch(() => {});

        await supabase
          .from('webhook_logs')
          .update({ status: 'processed' })
          .eq('event_type', event.Event);
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Squad webhook error:', err);
    return res.sendStatus(500);
  }
});

// ─── Error Handler ────────────────────────────────────────────────────────────

// 404
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

// Global error handler with logging
app.use(async (err, req, res, _next) => {
  console.error('Unhandled error:', err);

  // Log error to database
  try {
    await supabase.from('error_logs').insert({
      message: err.message || 'Unknown error',
      stack: err.stack || '',
      route: req.path,
      method: req.method,
    });
  } catch (logErr) {
    console.error('Failed to log error to database:', logErr);
  }

  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`BitLyfe backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
