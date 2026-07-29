const axios = require('axios');

// Sandbox:    https://sandbox-api-d.squadco.com
// Production: https://api-d.squadco.com
const BASE_URL = process.env.SQUADCO_BASE_URL || 'https://api-d.squadco.com';

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.SQUADCO_SECRET_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Initialize a Squad payment (deposit).
 * Replaces paystack.initializeTransaction().
 *
 * Squad initiate response shape:
 *   { "status": 200, "message": "success", "data": { "checkout_url": "...", ... } }
 *
 * NOTE: top-level field is "status": 200 (number), NOT "success": true.
 * wallet.js expects: { status: true, data: { authorization_url } }
 */
async function initializeTransaction({ email, amountKobo, reference, metadata = {} }) {
  let response;
  try {
    response = await axios.post(
      `${BASE_URL}/transaction/initiate`,
      {
        email,
        amount: amountKobo,       // Squad uses kobo, same as Paystack
        currency: 'NGN',
        initiate_type: 'inline',
        transaction_ref: reference,
        callback_url: `${(process.env.FRONTEND_URL || 'https://bitlyf.vercel.app').replace(/\/$/, '')}/payment/verify`,
      },
      { headers: getHeaders() }
    );
  } catch (axiosErr) {
    // Surface Squad's full error body to Render logs
    console.error('[squad] initializeTransaction axios error:', axiosErr.message);
    if (axiosErr.response) {
      console.error('[squad] Squad HTTP status:', axiosErr.response.status);
      console.error('[squad] Squad error body:', JSON.stringify(axiosErr.response.data, null, 2));
    }
    throw axiosErr;
  }

  const d = response.data;

  // Squad uses status: 200 (number) on success, not a boolean "success" field
  const ok = d.status === 200 || d.status === '200';

  if (!ok) {
    console.error('[squad] initializeTransaction failed. Full response:', JSON.stringify(d, null, 2));
  }

  // Normalise to the shape wallet.js already expects
  return {
    status: ok,
    message: d.message,
    data: {
      authorization_url: d.data?.checkout_url,  // Squad → Paystack field name map
      reference,
    },
  };
}

/**
 * Verify a Squad transaction by reference.
 * Replaces paystack.verifyTransaction().
 *
 * Squad verify response shape (success):
 *   { "status": 200, "success": true, "message": "Success",
 *     "data": { "transaction_status": "Success", "transaction_amount": 5000, ... } }
 *
 * transaction_status values: "Success" | "failed" | "Abandoned" | "Pending"
 * wallet.js checks: paystackRes.data.status === 'success'
 * So we normalise transaction_status === 'Success' → status: 'success'
 *
 * Amount field: transaction_amount (not "amount") — still in kobo.
 */
async function verifyTransaction(reference) {
  let response;
  try {
    response = await axios.get(
      `${BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: getHeaders() }
    );
  } catch (axiosErr) {
    console.error('[squad] verifyTransaction axios error:', axiosErr.message);
    if (axiosErr.response) {
      console.error('[squad] Squad HTTP status:', axiosErr.response.status);
      console.error('[squad] Squad error body:', JSON.stringify(axiosErr.response.data, null, 2));
    }
    throw axiosErr;
  }

  const d = response.data;

  // transaction_status is "Success" (capital S) on success, "failed" (lowercase) on failure
  const txStatus = d.data?.transaction_status;
  const normalised = txStatus === 'Success' ? 'success' : (txStatus?.toLowerCase() || 'failed');

  return {
    status: d.status === 200 || d.success === true,
    data: {
      status: normalised,                     // wallet.js checks === 'success'
      amount: d.data?.transaction_amount,     // kobo — wallet.js divides by 100
      metadata: d.data?.meta_data ? (() => {
        try { return JSON.parse(d.data.meta_data); } catch { return {}; }
      })() : {},
      reference: d.data?.transaction_ref,
    },
  };
}

/**
 * Fetch list of supported Nigerian banks.
 * Replaces paystack.getBankList().
 * Returns { status, data: [{ name, code, type }] }
 */
async function getBankList() {
  let response;
  try {
    response = await axios.get(`${BASE_URL}/payout/banks`, { headers: getHeaders() });
  } catch (axiosErr) {
    console.error('[squad] getBankList error:', axiosErr.message);
    if (axiosErr.response) console.error('[squad] body:', JSON.stringify(axiosErr.response.data));
    throw axiosErr;
  }

  const d = response.data;

  return {
    status: d.status === 200 || d.success === true,
    data: (d.data || []).map((b) => ({
      name: b.bank_name,
      code: b.bank_code,
      type: 'nuban',
    })),
  };
}

/**
 * Resolve account number → account name.
 * Replaces paystack.resolveAccountNumber().
 */
async function resolveAccountNumber(accountNumber, bankCode) {
  let response;
  try {
    response = await axios.post(
      `${BASE_URL}/payout/account/lookup`,
      { bank_code: bankCode, account_number: accountNumber },
      { headers: getHeaders() }
    );
  } catch (axiosErr) {
    console.error('[squad] resolveAccountNumber error:', axiosErr.message);
    if (axiosErr.response) console.error('[squad] body:', JSON.stringify(axiosErr.response.data));
    throw axiosErr;
  }

  const d = response.data;

  return {
    status: d.status === 200 || d.success === true,
    data: {
      account_name: d.data?.account_name,
      account_number: d.data?.account_number,
    },
  };
}

/**
 * Create a transfer recipient (shim — Squad has no separate recipient step).
 * Encodes account details as a JSON string used as "recipient_code" so
 * withdrawals.js needs no structural change.
 */
async function createTransferRecipient({ name, accountNumber, bankCode }) {
  return {
    status: true,
    data: {
      recipient_code: JSON.stringify({ accountNumber, bankCode, name }),
    },
  };
}

/**
 * Initiate a payout (withdrawal transfer).
 * Replaces paystack.initiateTransfer().
 * recipientCode is the JSON string from createTransferRecipient above.
 */
async function initiateTransfer({ amountKobo, recipientCode, reference, reason }) {
  const { accountNumber, bankCode, name } = JSON.parse(recipientCode);

  let response;
  try {
    response = await axios.post(
      `${BASE_URL}/payout/initiate`,
      {
        account_number: accountNumber,
        bank_code: bankCode,
        currency_id: 'NGN',
        amount: amountKobo,
        transaction_reference: reference,
        remark: reason,
      },
      { headers: getHeaders() }
    );
  } catch (axiosErr) {
    console.error('[squad] initiateTransfer error:', axiosErr.message);
    if (axiosErr.response) console.error('[squad] body:', JSON.stringify(axiosErr.response.data));
    throw axiosErr;
  }

  const d = response.data;

  return {
    status: d.status === 200 || d.success === true,
    message: d.message,
    data: {
      transfer_code: d.data?.transaction_reference || reference,
    },
  };
}

module.exports = {
  initializeTransaction,
  verifyTransaction,
  getBankList,
  resolveAccountNumber,
  createTransferRecipient,
  initiateTransfer,
};
