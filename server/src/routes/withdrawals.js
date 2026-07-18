const { createNotification } = require('./notifications');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../db/supabase');
const adminAuth = require('../middleware/adminAuth');
const paystack = require('../services/paystack');

const router = express.Router();

// All withdrawal management routes require admin auth
router.use(adminAuth);

// ─── SHARED TRANSFER LOGIC ────────────────────────────────────────────────────

/**
 * Attempt a Paystack transfer for a withdrawal row that already has a
 * transfer_reference and recipient_code (or will create the recipient if absent).
 *
 * Returns { success, paystackTransferCode, errorMessage }
 * Does NOT mutate the withdrawal_requests row — callers handle status updates.
 */
async function attemptPaystackTransfer(withdrawal) {
  let recipientCode = withdrawal.recipient_code || null;

  // Create recipient if not yet stored
  if (!recipientCode) {
    const recipientRes = await paystack.createTransferRecipient({
      name: withdrawal.bank_name || withdrawal.phone,
      accountNumber: withdrawal.account_number,
      bankCode: withdrawal.bank_code,
    });

    if (!recipientRes.status) {
      return {
        success: false,
        errorMessage: `Recipient creation failed: ${recipientRes.message || 'unknown error'}`,
      };
    }

    recipientCode = recipientRes.data.recipient_code;

    // Persist recipient_code so retries re-use it (no duplicate recipients)
    await supabase
      .from('withdrawal_requests')
      .update({ recipient_code: recipientCode })
      .eq('id', withdrawal.id);
  }

  const transferRes = await paystack.initiateTransfer({
    amountKobo: withdrawal.amount * 100,
    recipientCode,
    reference: withdrawal.transfer_reference,
    reason: `BitLyfe withdrawal for ${withdrawal.phone}`,
  });

  if (!transferRes.status) {
    return {
      success: false,
      errorMessage: `Transfer failed: ${transferRes.message || 'unknown error'}`,
    };
  }

  return {
    success: true,
    paystackTransferCode: transferRes.data.transfer_code,
  };
}

// ─── LIST ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/withdrawals
 * List withdrawal requests with optional status filter.
 * Query: ?status=pending|approved|rejected|transfer_failed&page=1&limit=20
 *
 * When no status filter is given, returns a summary object with counts per status
 * so the admin panel can display separate sections without a second round-trip.
 */
router.get('/', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabase
      .from('withdrawal_requests')
      .select(
        `id, player_id, phone, amount, method, account_number, bank_name, bank_code,
         status, reject_reason, transfer_failed_reason, transfer_reference, created_at,
         players ( name )`,
        { count: 'exact' }
      )
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status) {
      query = query.eq('status', status);
    } else {
      // No filter — return all, plus per-status counts for the admin dashboard header
    }

    const { data, error, count } = await query;

    if (error) return res.status(500).json({ success: false, error: 'Failed to fetch withdrawals' });

    // Build per-status summary counts (only when no filter is applied, cheap parallel count queries)
    let summary = null;
    if (!status) {
      const [pendingRes, failedRes, approvedRes, rejectedRes] = await Promise.all([
        supabase.from('withdrawal_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('withdrawal_requests').select('id', { count: 'exact', head: true }).eq('status', 'transfer_failed'),
        supabase.from('withdrawal_requests').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
        supabase.from('withdrawal_requests').select('id', { count: 'exact', head: true }).eq('status', 'rejected'),
      ]);
      summary = {
        pending: pendingRes.count || 0,
        transfer_failed: failedRes.count || 0,
        approved: approvedRes.count || 0,
        rejected: rejectedRes.count || 0,
      };
    }

    return res.json({
      success: true,
      data: {
        withdrawals: data,
        total: count,
        page: Number(page),
        limit: Number(limit),
        ...(summary ? { summary } : {}),
      },
    });
  } catch (err) {
    console.error('Get withdrawals error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch withdrawals' });
  }
});

// ─── APPROVE ──────────────────────────────────────────────────────────────────

/**
 * PUT /api/admin/withdrawals/:id/approve
 * Approve a pending withdrawal and initiate Paystack transfer.
 *
 * Only marks status as 'approved' if Paystack actually succeeds.
 * On Paystack failure, status becomes 'transfer_failed' with the error reason stored —
 * clearly distinct from 'approved' and visible in the admin panel.
 * Balance stays deducted in both cases — no double-refund risk.
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
        error: `Cannot approve a withdrawal with status: ${withdrawal.status}. Use the retry-transfer endpoint for transfer_failed withdrawals.`,
      });
    }

    if (!withdrawal.bank_code) {
      return res.status(422).json({
        success: false,
        code: 'MISSING_BANK_CODE',
        error: 'This withdrawal has no bank_code. The player must re-submit with a valid bank selection.',
      });
    }

    // Idempotency: a stored transfer_reference means this approve already ran.
    // Block re-entry — admin should use retry-transfer if the transfer actually failed.
    if (withdrawal.transfer_reference) {
      return res.status(409).json({
        success: false,
        code: 'ALREADY_PROCESSED',
        error: `Transfer reference already assigned (${withdrawal.transfer_reference}). If the transfer failed, use PUT /:id/retry-transfer.`,
      });
    }

    const transferReference = `wdl_${uuidv4()}`;

    // Write the reference BEFORE calling Paystack — crash safety.
    // If the process dies mid-call, the reference is stored and a subsequent
    // approve will be blocked, forcing the admin to use retry-transfer.
    await supabase
      .from('withdrawal_requests')
      .update({ transfer_reference: transferReference })
      .eq('id', id);

    let paystackResult;
    try {
      paystackResult = await attemptPaystackTransfer({
        ...withdrawal,
        transfer_reference: transferReference,
      });
    } catch (unexpectedErr) {
      // Network/unexpected error — mark transfer_failed, do not approve
      console.error('Unexpected Paystack error during approve:', unexpectedErr.message);
      await supabase
        .from('withdrawal_requests')
        .update({
          status: 'transfer_failed',
          transfer_failed_reason: `Unexpected error: ${unexpectedErr.message}`,
        })
        .eq('id', id);

      return res.status(502).json({
        success: false,
        code: 'PAYSTACK_ERROR',
        error: `Transfer error: ${unexpectedErr.message}. Status set to transfer_failed — use retry-transfer to re-attempt.`,
      });
    }

    if (!paystackResult.success) {
      // Paystack returned a failure — mark transfer_failed, NOT approved
      await supabase
        .from('withdrawal_requests')
        .update({
          status: 'transfer_failed',
          transfer_failed_reason: paystackResult.errorMessage,
        })
        .eq('id', id);

      // Notify player their withdrawal hit a problem (not rejected, but delayed)
      await createNotification(
        withdrawal.player_id,
        'withdrawal_rejected',  // closest available type — frontend shows "check your withdrawal"
        'Withdrawal transfer issue',
        `Your withdrawal of ₦${withdrawal.amount.toLocaleString()} encountered a transfer issue. Our team is resolving it.`
      ).catch(() => {});

      return res.status(502).json({
        success: false,
        code: 'TRANSFER_FAILED',
        error: paystackResult.errorMessage,
        status_set_to: 'transfer_failed',
        message: 'Withdrawal marked as transfer_failed. Use PUT /:id/retry-transfer to re-attempt.',
      });
    }

    // ── Paystack succeeded — mark approved ───────────────────────────────────
    const { data: updated, error: updateErr } = await supabase
      .from('withdrawal_requests')
      .update({ status: 'approved' })
      .eq('id', id)
      .select()
      .single();

    if (updateErr) {
      // Transfer happened but DB update failed — log loudly, don't return error to admin
      // (the money has moved; marking it failed would confuse the state)
      console.error('CRITICAL: Paystack transfer succeeded but status update failed. Withdrawal:', id);
    }

    await supabase.from('transactions').insert({
      player_id: withdrawal.player_id,
      type: 'withdrawal',
      amount: -withdrawal.amount,
      description: `Withdrawal of ₦${withdrawal.amount} approved`,
      reference: transferReference,
    });

    await createNotification(
      withdrawal.player_id,
      'withdrawal_approved',
      'Withdrawal approved',
      `₦${withdrawal.amount.toLocaleString()} is on its way to your account`
    ).catch(() => {});

    return res.json({
      success: true,
      data: {
        withdrawal: updated,
        transferReference,
        paystackTransferCode: paystackResult.paystackTransferCode,
        message: 'Withdrawal approved and transfer initiated',
      },
    });
  } catch (err) {
    console.error('Approve withdrawal error:', err);
    return res.status(500).json({ success: false, error: 'Failed to approve withdrawal' });
  }
});

// ─── RETRY TRANSFER ───────────────────────────────────────────────────────────

/**
 * PUT /api/admin/withdrawals/:id/retry-transfer
 * Re-attempt the Paystack transfer for a withdrawal in 'transfer_failed' status.
 *
 * Uses the SAME transfer_reference already stored — Paystack's idempotency
 * means re-sending the same reference is safe: if the first call actually
 * succeeded (network timeout scenario), Paystack returns the same result.
 *
 * Balance is NOT re-deducted — it was already held at the original request.
 */
router.put('/:id/retry-transfer', async (req, res) => {
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

    if (withdrawal.status !== 'transfer_failed') {
      return res.status(400).json({
        success: false,
        error: `retry-transfer is only for withdrawals in transfer_failed status. Current status: ${withdrawal.status}`,
      });
    }

    if (!withdrawal.transfer_reference) {
      // Shouldn't happen — transfer_failed always has a reference — but guard it
      return res.status(422).json({
        success: false,
        error: 'No transfer_reference found. Reject this withdrawal and ask the player to re-submit.',
      });
    }

    if (!withdrawal.bank_code) {
      return res.status(422).json({
        success: false,
        code: 'MISSING_BANK_CODE',
        error: 'No bank_code on this withdrawal. Reject it and ask the player to re-submit.',
      });
    }

    let paystackResult;
    try {
      paystackResult = await attemptPaystackTransfer(withdrawal);
    } catch (unexpectedErr) {
      console.error('Unexpected Paystack error during retry:', unexpectedErr.message);
      await supabase
        .from('withdrawal_requests')
        .update({ transfer_failed_reason: `Retry error: ${unexpectedErr.message}` })
        .eq('id', id);

      return res.status(502).json({
        success: false,
        code: 'PAYSTACK_ERROR',
        error: `Transfer error: ${unexpectedErr.message}. Withdrawal remains transfer_failed.`,
      });
    }

    if (!paystackResult.success) {
      // Update the failure reason so the admin can see the latest error
      await supabase
        .from('withdrawal_requests')
        .update({ transfer_failed_reason: paystackResult.errorMessage })
        .eq('id', id);

      return res.status(502).json({
        success: false,
        code: 'TRANSFER_FAILED',
        error: paystackResult.errorMessage,
        message: 'Transfer retry failed. Withdrawal remains transfer_failed. Consider rejecting and refunding the player.',
      });
    }

    // ── Retry succeeded — mark approved ──────────────────────────────────────
    const { data: updated } = await supabase
      .from('withdrawal_requests')
      .update({
        status: 'approved',
        transfer_failed_reason: null,  // clear the error
      })
      .eq('id', id)
      .select()
      .single();

    await supabase.from('transactions').insert({
      player_id: withdrawal.player_id,
      type: 'withdrawal',
      amount: -withdrawal.amount,
      description: `Withdrawal of ₦${withdrawal.amount} approved (retry)`,
      reference: withdrawal.transfer_reference,
    });

    await createNotification(
      withdrawal.player_id,
      'withdrawal_approved',
      'Withdrawal approved',
      `₦${withdrawal.amount.toLocaleString()} is on its way to your account`
    ).catch(() => {});

    return res.json({
      success: true,
      data: {
        withdrawal: updated,
        transferReference: withdrawal.transfer_reference,
        paystackTransferCode: paystackResult.paystackTransferCode,
        message: 'Transfer retry succeeded — withdrawal approved',
      },
    });
  } catch (err) {
    console.error('Retry transfer error:', err);
    return res.status(500).json({ success: false, error: 'Failed to retry transfer' });
  }
});

// ─── REJECT ───────────────────────────────────────────────────────────────────

/**
 * PUT /api/admin/withdrawals/:id/reject
 * Reject a withdrawal (pending or transfer_failed) and refund the player's balance.
 *
 * transfer_failed withdrawals can also be rejected here — this is the resolution
 * path when retry is not possible (e.g. invalid account details).
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

    // Allow rejection of both pending and transfer_failed statuses
    if (!['pending', 'transfer_failed'].includes(withdrawal.status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot reject a withdrawal with status: ${withdrawal.status}`,
      });
    }

    // Refund to player balance — balance was deducted at request creation
    const { data: player } = await supabase
      .from('players')
      .select('balance')
      .eq('id', withdrawal.player_id)
      .single();

    await supabase
      .from('players')
      .update({ balance: (player?.balance || 0) + withdrawal.amount })
      .eq('id', withdrawal.player_id);

    const { data: updated, error: updateErr } = await supabase
      .from('withdrawal_requests')
      .update({ status: 'rejected', reject_reason: reason || 'Rejected by admin' })
      .eq('id', id)
      .select()
      .single();

    if (updateErr) {
      return res.status(500).json({ success: false, error: 'Failed to reject withdrawal' });
    }

    await supabase.from('transactions').insert({
      player_id: withdrawal.player_id,
      type: 'withdrawal_refund',
      amount: withdrawal.amount,
      description: `Withdrawal rejected: ${reason || 'Rejected by admin'}`,
    });

    await createNotification(
      withdrawal.player_id,
      'withdrawal_rejected',
      'Withdrawal rejected',
      reason || 'Your withdrawal request was rejected. The amount has been returned to your balance.'
    ).catch(() => {});

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
