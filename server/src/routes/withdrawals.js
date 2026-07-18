const { createNotification } = require('./notifications');
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

    // Guard: bank_code is required for Paystack transfer recipient creation.
    // Rows created before the bank_code migration will lack this field.
    if (!withdrawal.bank_code) {
      return res.status(422).json({
        success: false,
        code: 'MISSING_BANK_CODE',
        error: 'This withdrawal request has no bank_code stored. The player must re-submit their withdrawal with the correct bank selected, or an admin must update the bank_code manually via SQL before approving.',
      });
    }

    // Idempotency: if a transfer_reference is already stored, a previous approve call
    // got far enough to generate a reference — don't create a second transfer.
    // Check if Paystack already has a successful transfer for this reference.
    if (withdrawal.transfer_reference) {
      return res.status(409).json({
        success: false,
        code: 'ALREADY_PROCESSED',
        error: `This withdrawal was already approved with transfer reference ${withdrawal.transfer_reference}. Check Paystack dashboard for transfer status.`,
      });
    }

    const transferReference = `wdl_${uuidv4()}`;

    // Store the reference immediately before calling Paystack —
    // this means if the server crashes mid-call, a retry will be blocked
    // and the admin can check Paystack manually rather than double-paying.
    await supabase
      .from('withdrawal_requests')
      .update({ transfer_reference: transferReference })
      .eq('id', id);

    let paystackTransferCode = null;
    let transferError = null;
    let recipientCode = withdrawal.recipient_code || null;

    try {
      // Re-use existing recipient_code if we already created this recipient
      if (!recipientCode) {
        const recipientRes = await paystack.createTransferRecipient({
          name: withdrawal.bank_name || withdrawal.phone,
          accountNumber: withdrawal.account_number,
          bankCode: withdrawal.bank_code,   // ← correct field, always numeric code
        });

        if (!recipientRes.status) {
          throw new Error(`Paystack recipient creation failed: ${recipientRes.message || 'unknown error'}`);
        }

        recipientCode = recipientRes.data.recipient_code;

        // Persist recipient_code so we can re-use it on retry without creating duplicates
        await supabase
          .from('withdrawal_requests')
          .update({ recipient_code: recipientCode })
          .eq('id', id);
      }

      // Initiate transfer
      const transferRes = await paystack.initiateTransfer({
        amountKobo: withdrawal.amount * 100,
        recipientCode,
        reference: transferReference,
        reason: `BitLyfe withdrawal for ${withdrawal.phone}`,
      });

      if (!transferRes.status) {
        throw new Error(`Paystack transfer failed: ${transferRes.message || 'unknown error'}`);
      }

      paystackTransferCode = transferRes.data.transfer_code;
    } catch (paystackErr) {
      console.error('Paystack transfer error:', paystackErr.message);
      transferError = paystackErr.message;

      // Clear the transfer_reference we just stored so the admin can retry cleanly
      await supabase
        .from('withdrawal_requests')
        .update({ transfer_reference: null })
        .eq('id', id);

      // Do NOT mark as approved — the money hasn't moved
      return res.status(502).json({
        success: false,
        code: 'PAYSTACK_ERROR',
        error: `Paystack transfer failed: ${transferError}. Withdrawal remains pending — fix the issue and try again.`,
        transferReference,
      });
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

    // Notify player
    await createNotification(
      withdrawal.player_id,
      'withdrawal_approved',
      'Withdrawal approved',
      `₦${withdrawal.amount.toLocaleString()} is on its way to your account`
    );

    return res.json({
      success: true,
      data: {
        withdrawal: updated,
        transferReference,
        paystackTransferCode,
        message: 'Withdrawal approved and transfer initiated',
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

    // Notify player
    await createNotification(
      withdrawal.player_id,
      'withdrawal_rejected',
      'Withdrawal rejected',
      reason || 'Your withdrawal request was rejected by admin'
    );

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
