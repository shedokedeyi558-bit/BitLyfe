const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');
const paystack = require('../services/paystack');
const { checkReferralCompletion } = require('./referrals');

const router = express.Router();

/**
 * GET /api/wallet/balance
 * Return player's current balance.
 */
router.get('/balance', auth, async (req, res) => {
  try {
    const { data: player, error } = await supabase
      .from('players')
      .select('balance, bonus_balance')
      .eq('id', req.player.id)
      .single();

    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to fetch balance' });
    }

    return res.json({
      success: true,
      data: {
        balance: player.balance,
        bonus_balance: player.bonus_balance || 0,
        total: (player.balance || 0) + (player.bonus_balance || 0),
      },
    });
  } catch (err) {
    console.error('Balance error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch balance' });
  }
});

/**
 * GET /api/wallet/spend-summary
 * Return player's spend summary: spent today, spent this week, daily/weekly limits
 */
router.get('/spend-summary', auth, async (req, res) => {
  try {
    const player = req.player;
    const now = new Date();

    // Calculate date ranges
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay()); // Sunday start
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfDayISO = startOfDay.toISOString();
    const startOfWeekISO = startOfWeek.toISOString();
    const nowISO = now.toISOString();

    // Get entry-fee transactions (spending only, not deposits/refunds)
    const { data: todayTxns } = await supabase
      .from('transactions')
      .select('amount')
      .eq('player_id', player.id)
      .in('type', ['prediction_enter', 'pill_open', 'blitz_entry', 'entry_fee'])
      .gte('created_at', startOfDayISO)
      .lte('created_at', nowISO);

    const { data: weekTxns } = await supabase
      .from('transactions')
      .select('amount')
      .eq('player_id', player.id)
      .in('type', ['prediction_enter', 'pill_open', 'blitz_entry', 'entry_fee'])
      .gte('created_at', startOfWeekISO)
      .lte('created_at', nowISO);

    // Get player limits — player may not have any limits set (returns null cleanly)
    const { data: limits } = await supabase
      .from('player_limits')
      .select('daily_limit, weekly_limit')
      .eq('player_id', player.id)
      .maybeSingle();

    const spentToday = (todayTxns || []).reduce((sum, t) => sum + Math.abs(t.amount), 0);
    const spentThisWeek = (weekTxns || []).reduce((sum, t) => sum + Math.abs(t.amount), 0);

    // Count plays
    const [pillPlaysRes, predictionEntriesRes, blitzRegsRes] = await Promise.all([
      supabase
        .from('pill_plays')
        .select('id', { count: 'exact', head: true })
        .eq('player_id', player.id)
        .gte('created_at', startOfDayISO),
      supabase
        .from('prediction_participations')
        .select('id', { count: 'exact', head: true })
        .eq('player_id', player.id)
        .gte('created_at', startOfDayISO),
      supabase
        .from('blitz_registrations')
        .select('id', { count: 'exact', head: true })
        .eq('player_id', player.id)
        .gte('registered_at', startOfDayISO),
    ]);

    const playsToday =
      (pillPlaysRes.count || 0) + (predictionEntriesRes.count || 0) + (blitzRegsRes.count || 0);

    return res.json({
      success: true,
      data: {
        spent_today: spentToday,
        spent_this_week: spentThisWeek,
        plays_today: playsToday,
        daily_limit: limits?.daily_limit || null,
        weekly_limit: limits?.weekly_limit || null,
      },
    });
  } catch (err) {
    console.error('Spend summary error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch spend summary' });
  }
});

/**
 * PUT /api/wallet/limits
 * Set/update player's daily and/or weekly spend limits
 * Body: { daily_limit?, weekly_limit? } (either can be null to disable)
 */
router.put('/limits', auth, async (req, res) => {
  try {
    const player = req.player;
    const { daily_limit, weekly_limit } = req.body;

    // Validate
    if (
      (daily_limit !== undefined && daily_limit !== null && (isNaN(daily_limit) || daily_limit < 0)) ||
      (weekly_limit !== undefined && weekly_limit !== null && (isNaN(weekly_limit) || weekly_limit < 0))
    ) {
      return res
        .status(400)
        .json({ success: false, error: 'daily_limit and weekly_limit must be non-negative integers or null' });
    }

    // Check if limits already exist — player may not have any yet
    const { data: existing } = await supabase
      .from('player_limits')
      .select('id')
      .eq('player_id', player.id)
      .maybeSingle();

    let result;
    if (existing) {
      // Update
      const { data, error } = await supabase
        .from('player_limits')
        .update({
          daily_limit: daily_limit !== undefined ? daily_limit : undefined,
          weekly_limit: weekly_limit !== undefined ? weekly_limit : undefined,
          updated_at: new Date().toISOString(),
        })
        .eq('player_id', player.id)
        .select()
        .single();

      if (error) return res.status(500).json({ success: false, error: 'Failed to update limits' });
      result = data;
    } else {
      // Create
      const { data, error } = await supabase
        .from('player_limits')
        .insert({
          player_id: player.id,
          daily_limit: daily_limit !== undefined ? daily_limit : null,
          weekly_limit: weekly_limit !== undefined ? weekly_limit : null,
        })
        .select()
        .single();

      if (error) return res.status(500).json({ success: false, error: 'Failed to create limits' });
      result = data;
    }

    return res.json({
      success: true,
      data: {
        daily_limit: result.daily_limit,
        weekly_limit: result.weekly_limit,
        message: 'Spend limits updated',
      },
    });
  } catch (err) {
    console.error('Set limits error:', err);
    return res.status(500).json({ success: false, error: 'Failed to set limits' });
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

    // Use phone as a pseudo-email for Paystack (fallback format)
    const email = player.email || `${player.phone}@bitlyfe.app`;

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

    // Idempotency: check if already processed (any terminal state for this reference)
    const { data: existing } = await supabase
      .from('transactions')
      .select('id, type')
      .eq('reference', reference)
      .in('type', ['deposit', 'deposit_settled'])
      .maybeSingle();

    if (existing) {
      // Already successfully processed — fetch current balance and return
      const { data: currentPlayer } = await supabase
        .from('players')
        .select('balance')
        .eq('id', player.id)
        .single();
      return res.json({
        success: true,
        data: { message: 'Payment already processed', alreadyProcessed: true, newBalance: currentPlayer?.balance },
      });
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

    // Remove the pending record so only one deposit entry appears in transaction history
    await supabase
      .from('transactions')
      .delete()
      .eq('reference', reference)
      .eq('type', 'deposit_pending');

    // Trigger referral first-deposit check (fire-and-forget)
    checkReferralCompletion(player.id, 'deposit', amountNaira).catch(() => {});

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
 * Return player's transaction history, including pending/processing withdrawal state.
 *
 * withdrawal_pending rows are included — these represent the held balance while a
 * withdrawal is awaiting admin action (including transfer_failed state).
 * Frontend should render withdrawal_pending as "Processing" not "Completed",
 * so the player can see their money is accounted for.
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

    // Check if any withdrawal_pending transactions have a corresponding transfer_failed request
    // so the frontend can display "Transfer issue — under review" instead of just "Processing"
    const pendingTxns = (data || []).filter((t) => t.type === 'withdrawal_pending');
    let transferFailedIds = new Set();

    if (pendingTxns.length > 0) {
      const { data: failedWithdrawals } = await supabase
        .from('withdrawal_requests')
        .select('id')
        .eq('player_id', req.player.id)
        .eq('status', 'transfer_failed');

      if (failedWithdrawals) {
        // We can't directly join withdrawal_requests to transactions without a reference,
        // so flag ALL pending transactions if ANY withdrawal is transfer_failed.
        // This is conservative — if the player has any transfer_failed withdrawal, show the warning.
        if (failedWithdrawals.length > 0) {
          transferFailedIds = new Set(failedWithdrawals.map((w) => w.id));
        }
      }
    }

    const enriched = (data || []).map((t) => ({
      ...t,
      // Provide a display_status hint for the frontend
      display_status:
        t.type === 'withdrawal_pending' && transferFailedIds.size > 0
          ? 'transfer_issue'
          : t.type === 'withdrawal_pending'
          ? 'processing'
          : 'completed',
    }));

    return res.json({
      success: true,
      data: {
        transactions: enriched,
        total: count,
        page: Number(page),
        limit: Number(limit),
        has_transfer_failed_withdrawal: transferFailedIds.size > 0,
      },
    });
  } catch (err) {
    console.error('Transactions error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch transactions' });
  }
});

/**
 * GET /api/wallet/banks
 * Returns Paystack's list of supported Nigerian banks.
 * Frontend uses this to render a bank picker — never let the player type a bank name freely.
 * Response is cached for 1 hour since the list rarely changes.
 */
let banksCache = null;
let banksCacheExpiry = 0;

router.get('/banks', auth, async (req, res) => {
  try {
    const now = Date.now();
    if (!banksCache || now > banksCacheExpiry) {
      const paystackRes = await paystack.getBankList();
      if (!paystackRes.status) {
        return res.status(502).json({ success: false, error: 'Failed to fetch bank list from Paystack' });
      }
      banksCache = paystackRes.data.map((b) => ({
        name: b.name,
        code: b.code,
        type: b.type,
      }));
      banksCacheExpiry = now + 60 * 60 * 1000; // 1 hour
    }
    return res.json({ success: true, data: { banks: banksCache } });
  } catch (err) {
    console.error('Bank list error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch bank list' });
  }
});

/**
 * GET /api/wallet/resolve-account?account_number=&bank_code=
 * Resolves an account number to an account name via Paystack.
 * Frontend calls this after the player enters their account number + selects a bank,
 * so they can confirm "Is this your name?" before submitting the withdrawal.
 */
router.get('/resolve-account', auth, async (req, res) => {
  try {
    const { account_number, bank_code } = req.query;

    if (!account_number || !bank_code) {
      return res.status(400).json({ success: false, error: 'account_number and bank_code are required' });
    }

    const paystackRes = await paystack.resolveAccountNumber(account_number, bank_code);

    if (!paystackRes.status) {
      return res.status(400).json({ success: false, error: 'Could not resolve account. Check the account number and bank.' });
    }

    return res.json({
      success: true,
      data: {
        account_name: paystackRes.data.account_name,
        account_number: paystackRes.data.account_number,
      },
    });
  } catch (err) {
    // Paystack returns 422 for unresolvable accounts — surface a clean message
    const status = err?.response?.status;
    if (status === 422 || status === 400) {
      return res.status(400).json({ success: false, error: 'Account number not found at this bank. Please check and try again.' });
    }
    console.error('Resolve account error:', err);
    return res.status(500).json({ success: false, error: 'Failed to resolve account number' });
  }
});

/**
 * POST /api/wallet/withdraw
 * Create a withdrawal request.
 * Body: { amount, method, accountNumber, bankCode, bankName }
 *   bankCode  — Paystack numeric bank code (e.g. "058"). Required.
 *   bankName  — Human-readable bank name. Stored for display, not used for transfers.
 */
router.post('/withdraw', auth, async (req, res) => {
  try {
    const { amount, method, accountNumber, bankCode, bankName } = req.body;
    const player = req.player;

    if (!amount || !method || !accountNumber || !bankCode) {
      return res.status(400).json({
        success: false,
        error: 'amount, method, accountNumber, and bankCode are required. Use GET /api/wallet/banks to get the correct bankCode.',
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

    // Generate transfer_reference NOW — at creation time, not at approve time.
    // This is the idempotency key for the Paystack transfer. Generating it here
    // means the reference is fixed for the lifetime of this withdrawal request —
    // no matter how many times an admin clicks Approve, the same reference is used.
    const transferReference = `wdl_${uuidv4()}`;

    // Create withdrawal request
    const { data: withdrawal, error: wErr } = await supabase
      .from('withdrawal_requests')
      .insert({
        player_id: player.id,
        phone: player.phone,
        amount: amountNum,
        method,
        account_number: accountNumber,
        bank_code: bankCode,
        bank_name: bankName || null,   // display only — not used for transfers
        transfer_reference: transferReference,  // pre-assigned, never changes
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
