const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const adminAuth = require('../middleware/adminAuth');
const paystack = require('../services/paystack');

const router = express.Router();

// All withdrawal management routes require admin auth
router.use(adminAuth);

/**
 * GET /api/admin/withdrawals
 * List withdrawal requests with optional status filter.
 * Query: ?status=pending|approved|rejected&page=1&limit=20
 */
router.get('/', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabase
      .from('withdrawal_requests')
      .select(
        `id, player_id, phone, amount, method, account_number, bank_name, status, reject_reason, created_at,
        players ( name )`,
        { count: 'exact' }
      )
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch withdrawals' });

    return res.json({
      success: true,
      data: {
        withdrawals: data,
        total: count,
        page: Number(page),
        limit: Number(limit),
      },
    });
  } catch (err) {
    console.error('Get withdrawals error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch withdrawals' });
  }
});

/**
 * PUT /api/admin/withdrawals/:id/approve
 * Approve a withdrawal and initiate Paystack transfer.
 */
router.put('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: withdrawal, error: fetchErr } = await supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !withdrawal) {
      return res.status(404).json({ success: false, error: 'Withdrawal request not found' });
    }

    if (withdrawal.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `Cannot approve a withdrawal with status: ${withdrawal.status}`,
      });
    }

    // Fetch app settings to get payout bank info and verify
    const { data: settings } = await supabase
      .from('app_settings')
      .select('payout_bank_name, payout_account_name, payout_account_number')
      .eq('id', 1)
      .single();

    let transferReference = `wdl_${uuidv4()}`;
    let paystackTransferCode = null;
    let transferError = null;

    try {
      // Create transfer recipient
      // Note: In production, bank_code lookup is required. Here we pass bank_name as a placeholder.
      // Frontend should collect bank_code and store it, or use Paystack /bank to resolve.
      const recipientRes = await paystack.createTransferRecipient({
        name: withdrawal.phone,
        accountNumber: withdrawal.account_number,
        bankCode: withdrawal.bank_name, // Ideally the bank code, not name
      });

      if (!recipientRes.status) {
        throw new Error('Failed to create Paystack recipient');
      }

      const recipientCode = recipientRes.data.recipient_code;

      // Initiate transfer
      const transferRes = await paystack.initiateTransfer({
        amountKobo: withdrawal.amount * 100,
        recipientCode,
        reference: transferReference,
        reason: `Triple Threat withdrawal for ${withdrawal.phone}`,
      });

      if (!transferRes.status) {
        throw new Error('Paystack transfer initiation failed');
      }

      paystackTransferCode = transferRes.data.transfer_code;
    } catch (paystackErr) {
      console.error('Paystack transfer error:', paystackErr.message);
      transferError = paystackErr.message;
      // Continue to mark as approved even if Paystack fails — admin can retry manually
    }

    // Update withdrawal to approved
    const { data: updated, error: updateErr } = await supabase
      .from('withdrawal_requests')
      .update({ status: 'approved' })
      .eq('id', id)
      .select()
      .single();

    if (updateErr) {
      return res.status(500).json({ success: false, error: 'Failed to update withdrawal status' });
    }

    // Record approved transaction
    await supabase.from('transactions').insert({
      player_id: withdrawal.player_id,
      type: 'withdrawal',
      amount: -withdrawal.amount,
      description: `Withdrawal of ₦${withdrawal.amount} approved`,
      reference: transferReference,
    });

    return res.json({
      success: true,
      data: {
        withdrawal: updated,
        transferReference,
        paystackTransferCode,
        transferError: transferError || null,
        message: transferError
          ? `Approved but Paystack transfer failed: ${transferError}. Process manually.`
          : 'Withdrawal approved and transfer initiated',
      },
    });
  } catch (err) {
    console.error('Approve withdrawal error:', err);
    return res.status(500).json({ success: false, error: 'Failed to approve withdrawal' });
  }
});

/**
 * PUT /api/admin/withdrawals/:id/reject
 * Reject a withdrawal and refund the player's balance.
 */
router.put('/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { data: withdrawal, error: fetchErr } = await supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !withdrawal) {
      return res.status(404).json({ success: false, error: 'Withdrawal request not found' });
    }

    if (withdrawal.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `Cannot reject a withdrawal with status: ${withdrawal.status}`,
      });
    }

    // Refund to player balance
    const { data: player } = await supabase
      .from('players')
      .select('balance')
      .eq('id', withdrawal.player_id)
      .single();

    await supabase
      .from('players')
      .update({ balance: (player?.balance || 0) + withdrawal.amount })
      .eq('id', withdrawal.player_id);

    // Update withdrawal status
    const { data: updated, error: updateErr } = await supabase
      .from('withdrawal_requests')
      .update({ status: 'rejected', reject_reason: reason || 'Rejected by admin' })
      .eq('id', id)
      .select()
      .single();

    if (updateErr) {
      return res.status(500).json({ success: false, error: 'Failed to reject withdrawal' });
    }

    // Record refund transaction
    await supabase.from('transactions').insert({
      player_id: withdrawal.player_id,
      type: 'withdrawal_refund',
      amount: withdrawal.amount,
      description: `Withdrawal rejected: ${reason || 'Rejected by admin'}`,
    });

    return res.json({
      success: true,
      data: {
        withdrawal: updated,
        message: 'Withdrawal rejected and amount refunded to player',
      },
    });
  } catch (err) {
    console.error('Reject withdrawal error:', err);
    return res.status(500).json({ success: false, error: 'Failed to reject withdrawal' });
  }
});

module.exports = router;
