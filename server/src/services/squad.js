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
 *
 * SquadCo does NOT have a dynamic bank-list API endpoint.
 * Their Transfer API docs (https://squadinc.gitbook.io/squad-api-documentation/transfer-api)
 * publish a static bank code table. We return that list directly.
 * Bank codes are in NIP format (e.g. "000013" for GTBank, not Paystack's "058").
 */
async function getBankList() {
  // Static list from SquadCo Transfer API documentation.
  // Source: https://squadinc.gitbook.io/squad-api-documentation/transfer-api
  const banks = [
    { name: 'Access Bank', code: '000014' },
    { name: 'Citibank', code: '000009' },
    { name: 'Diamond Bank', code: '000005' },
    { name: 'Ecobank', code: '000010' },
    { name: 'FCMB', code: '000003' },
    { name: 'Fidelity Bank', code: '000007' },
    { name: 'First Bank of Nigeria', code: '000016' },
    { name: 'GTBank', code: '000013' },
    { name: 'Heritage Bank', code: '000020' },
    { name: 'Jaiz Bank', code: '000006' },
    { name: 'Keystone Bank', code: '000002' },
    { name: 'Kuda Bank (MFB)', code: '090267' },
    { name: 'Moniepoint (Rolez MFB)', code: '090405' },
    { name: 'OPay (Opay Digital Services)', code: '100004' },
    { name: 'PalmPay', code: '100033' },
    { name: 'Polaris Bank', code: '000008' },
    { name: 'Providus Bank', code: '000023' },
    { name: 'Stanbic IBTC Bank', code: '000012' },
    { name: 'Standard Chartered', code: '000021' },
    { name: 'Sterling Bank', code: '000001' },
    { name: 'Suntrust Bank', code: '000022' },
    { name: 'Titan Trust Bank', code: '000025' },
    { name: 'UBA (United Bank for Africa)', code: '000004' },
    { name: 'Union Bank', code: '000018' },
    { name: 'Unity Bank', code: '000011' },
    { name: 'Wema Bank', code: '000017' },
    { name: 'Zenith Bank', code: '000015' },
    { name: 'Taj Bank', code: '000026' },
    { name: 'Globus Bank', code: '000027' },
    { name: 'Lotus Bank', code: '000029' },
    { name: 'Premium Trust Bank', code: '000031' },
    { name: 'Optimus Bank', code: '000036' },
    { name: 'Sparkle MFB', code: '090325' },
    { name: 'VFD MFB', code: '090110' },
    { name: 'FairMoney MFB', code: '090551' },
    { name: 'Safe Haven MFB', code: '090286' },
    { name: 'RenMoney MFB', code: '090198' },
    { name: 'Eyowo', code: '090328' },
    { name: '9PSB (9Payment Service Bank)', code: '120001' },
    { name: 'HopePSB', code: '120002' },
    { name: 'MoMo PSB (MTN)', code: '120003' },
    { name: 'Coronation Merchant Bank', code: '060001' },
  ];

  return {
    status: true,
    data: banks.map((b) => ({ name: b.name, code: b.code, type: 'nuban' })),
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
 *
 * SquadCo Transfer API docs:
 *   POST /payout/transfer  (NOT /payout/initiate)
 *   transaction_reference MUST be prefixed with merchant ID (from SQUADCO_MERCHANT_ID env var)
 *   account_name is required
 * Source: https://squadinc.gitbook.io/squad-api-documentation/transfer-api
 */
async function initiateTransfer({ amountKobo, recipientCode, reference, reason }) {
  const { accountNumber, bankCode, name } = JSON.parse(recipientCode);

  // SquadCo requires transaction_reference to be prefixed with merchant ID
  // e.g. "2DEGLX1A_wdl_uuid" — without this the transfer is rejected
  const merchantId = process.env.SQUADCO_MERCHANT_ID || '';
  const transactionReference = merchantId
    ? `${merchantId}_${reference}`
    : reference;

  if (!merchantId) {
    console.warn('[squad] initiateTransfer: SQUADCO_MERCHANT_ID env var not set — transaction_reference will not be prefixed. SquadCo may reject this transfer.');
  }

  let response;
  try {
    response = await axios.post(
      `${BASE_URL}/payout/transfer`,   // ← correct path per SquadCo docs
      {
        account_number: accountNumber,
        bank_code: bankCode,
        account_name: name || '',       // ← required by SquadCo
        currency_id: 'NGN',
        amount: String(amountKobo),     // ← SquadCo sample shows string amount
        transaction_reference: transactionReference,
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
      transfer_code: d.data?.transaction_reference || transactionReference,
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
