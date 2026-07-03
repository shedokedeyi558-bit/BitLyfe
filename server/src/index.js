require('dotenv').config();

const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const gameRoutes = require('./routes/game');
const gamesRoutes = require('./routes/games');
const walletRoutes = require('./routes/wallet');
const adminRoutes = require('./routes/admin');
const withdrawalRoutes = require('./routes/withdrawals');
const challengeRoutes = require('./routes/challenges');

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logger (basic)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } });
});

app.use('/api/auth', authRoutes);
app.use('/api/game', gameRoutes);
app.use('/api/admin/games', gamesRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/withdrawals', withdrawalRoutes);
app.use('/api/challenges', challengeRoutes);
app.use('/api/admin/challenges', challengeRoutes);

// ─── Paystack Webhook ─────────────────────────────────────────────────────────

/**
 * POST /api/webhooks/paystack
 * Handles Paystack event callbacks (charge.success, transfer.success, etc.)
 */
app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const crypto = require('crypto');
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const hash = crypto.createHmac('sha512', secret).update(req.body).digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).send('Invalid signature');
    }

    const event = JSON.parse(req.body);
    const supabase = require('./db/supabase');

    if (event.event === 'charge.success') {
      const { reference, amount, metadata } = event.data;
      const amountNaira = Math.floor(amount / 100);
      const playerId = metadata?.playerId;

      if (!playerId) {
        return res.sendStatus(200);
      }

      // Idempotency: check if already processed
      const { data: existing } = await supabase
        .from('transactions')
        .select('id')
        .eq('reference', reference)
        .eq('type', 'deposit')
        .single();

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
          reference,
        });
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    return res.sendStatus(500);
  }
});

// ─── Error Handler ────────────────────────────────────────────────────────────

// 404
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`BitLyfe backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
