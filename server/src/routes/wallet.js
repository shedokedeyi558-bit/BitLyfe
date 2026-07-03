const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');
const paystack = require('../services/paystack');

const router = express.Router();

/**
 * GET /api/wallet/balance
 * Return player's current balance.
 */
router.get('/balance', auth, async (req, res) => {
  try {
    const { data: player, error } = await supabase
      .from('players')
      .select('balance')
      .eq('id', req.player.id)
      .single();

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch balance' });
    }

    return res.json({ success: true, data: { balance: player.balance } });
  } catch (err) {
    console.error('Balance error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch balance' });
  }
});

/**
 * POST /api/wallet/deposit
 * Initialize a Paystack transaction and return authorization_url.
 * Body: { amount } — amount in Naira
 */
router.post('/deposit', auth, async (req, res) => {
  try {
    const { amount } = req.body;
    const player = req.player;

    if (!amount || isNaN(amount) || Number(amount) < 100) {
      return res.status(400).json({ success: false, error: 'Minimum deposit amount is ₦100' });
    }

    const amountNaira = Math.floor(Number(amount));
    const amountKobo = amountNaira * 100;
    const reference = `dep_${uuidv4()}`;

    // Use phone as a pseudo-email for Paystack
    const email = `${player.phone}@triplethreat.app`;

    const paystackRes = await paystack.initializeTransaction({
      email,
      amountKobo,
      reference,
      metadata: { playerId: player.id, phone: player.phone },
    });

    if (!paystackRes.status) {
      return res.status(502).json({ success: false, error: 'Payment initialization failed' });
    }

    // Store pending transaction
    await supabase.from('transactions').insert({
      player_id: player.id,
      type: 'deposit_pending',
      amount: amountNaira,
      description: `Deposit of ₦${amountNaira}`,
      reference,
    });

    return res.json({
      success: true,
      data: {
        authorizationUrl: paystackRes.data.authorization_url,
        reference,
        amount: amountNaira,
      },
    });
  } catch (err) {
    console.error('Deposit error:', err);
    return res.status(500).json({ success: false, error: 'Failed to initialize deposit' });
  }
});

/**
 * GET /api/wallet/verify?reference={ref}
 * Verify Paystack payment and credit wallet if successful.
 */
router.get('/verify', auth, async (req, res) => {
  try {
    const { reference } = req.query;
    const player = req.player;

    if (!reference) {
      return res.status(400).json({ success: false, error: 'Payment reference is required' });
    }

    // Check if already processed
    const { data: existing } = await supabase
      .from('transactions')
      .select('id, type')
      .eq('reference', reference)
      .eq('type', 'deposit')
      .single();

    if (existing) {
      return res.json({ success: true, data: { message: 'Payment already processed', alreadyProcessed: true } });
    }

    // Verify with Paystack
    const paystackRes = await paystack.verifyTransaction(reference);

    if (!paystackRes.status || paystackRes.data.status !== 'success') {
      return res.status(400).json({
        success: false,
        error: 'Payment not confirmed. Status: ' + (paystackRes.data?.status || 'unknown'),
      });
    }

    // Confirm payment belongs to this player
    const meta = paystackRes.data.metadata;
    if (meta?.playerId && meta.playerId !== player.id) {
      return res.status(403).json({ success: false, error: 'Payment reference mismatch' });
    }

    const amountNaira = Math.floor(paystackRes.data.amount / 100);

    // Credit wallet
    const { data: freshPlayer } = await supabase
      .from('players')
      .select('balance')
      .eq('id', player.id)
      .single();

    await supabase
      .from('players')
      .update({ balance: (freshPlayer.balance || 0) + amountNaira })
      .eq('id', player.id);

    // Record deposit transaction
    await supabase.from('transactions').insert({
      player_id: player.id,
      type: 'deposit',
      amount: amountNaira,
      description: `Deposit of ₦${amountNaira}`,
      reference,
    });

    // Mark pending as done (optional cleanup)
    await supabase
      .from('transactions')
      .update({ type: 'deposit_settled' })
      .eq('reference', reference)
      .eq('type', 'deposit_pending');

    return res.json({
      success: true,
      data: {
        message: `₦${amountNaira} credited to your wallet`,
        amount: amountNaira,
        newBalance: (freshPlayer.balance || 0) + amountNaira,
      },
    });
  } catch (err) {
    console.error('Verify deposit error:', err);
    return res.status(500).json({ success: false, error: 'Payment verification failed' });
  }
});

/**
 * GET /api/wallet/transactions
 * Return player's transaction history.
 */
router.get('/transactions', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const { data, error, count } = await supabase
      .from('transactions')
      .select('id, type, amount, description, reference, created_at', { count: 'exact' })
      .eq('player_id', req.player.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch transactions' });
    }

    return res.json({
      success: true,
      data: {
        transactions: data,
        total: count,
        page: Number(page),
        limit: Number(limit),
      },
    });
  } catch (err) {
    console.error('Transactions error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch transactions' });
  }
});

/**
 * POST /api/wallet/withdraw
 * Create a withdrawal request.
 * Body: { amount, method, accountNumber, bankName }
 */
router.post('/withdraw', auth, async (req, res) => {
  try {
    const { amount, method, accountNumber, bankName } = req.body;
    const player = req.player;

    if (!amount || !method || !accountNumber || !bankName) {
      return res.status(400).json({
        success: false,
        error: 'amount, method, accountNumber, and bankName are required',
      });
    }

    const amountNum = Math.floor(Number(amount));

    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid withdrawal amount' });
    }

    // Fetch settings for min withdrawal
    const { data: settings } = await supabase
      .from('app_settings')
      .select('min_withdrawal, auto_approve_withdrawals, auto_approve_limit')
      .eq('id', 1)
      .single();

    const minWithdrawal = settings?.min_withdrawal ?? 1000;

    if (amountNum < minWithdrawal) {
      return res.status(400).json({
        success: false,
        error: `Minimum withdrawal amount is ₦${minWithdrawal}`,
      });
    }

    // Fetch fresh balance
    const { data: freshPlayer } = await supabase
      .from('players')
      .select('balance')
      .eq('id', player.id)
      .single();

    if (!freshPlayer || freshPlayer.balance < amountNum) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' });
    }

    // Deduct balance
    await supabase
      .from('players')
      .update({ balance: freshPlayer.balance - amountNum })
      .eq('id', player.id);

    // Create withdrawal request
    const { data: withdrawal, error: wErr } = await supabase
      .from('withdrawal_requests')
      .insert({
        player_id: player.id,
        phone: player.phone,
        amount: amountNum,
        method,
        account_number: accountNumber,
        bank_name: bankName,
        status: 'pending',
      })
      .select()
      .single();

    if (wErr) {
      // Refund balance on failure
      await supabase
        .from('players')
        .update({ balance: freshPlayer.balance })
        .eq('id', player.id);
      return res.status(500).json({ success: false, error: 'Failed to create withdrawal request' });
    }

    // Record transaction
    await supabase.from('transactions').insert({
      player_id: player.id,
      type: 'withdrawal_pending',
      amount: -amountNum,
      description: `Withdrawal request of ₦${amountNum}`,
    });

    return res.status(201).json({
      success: true,
      data: {
        message: 'Withdrawal request submitted',
        withdrawal: {
          id: withdrawal.id,
          amount: amountNum,
          status: 'pending',
        },
        newBalance: freshPlayer.balance - amountNum,
      },
    });
  } catch (err) {
    console.error('Withdraw error:', err);
    return res.status(500).json({ success: false, error: 'Failed to process withdrawal request' });
  }
});

module.exports = router;
