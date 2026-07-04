const axios = require('axios');

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Initialize a Paystack transaction (deposit).
 * @param {string} email - Customer email (use phone@triplethreat.app as fallback)
 * @param {number} amountKobo - Amount in kobo (multiply naira by 100)
 * @param {string} reference - Unique transaction reference
 * @param {object} metadata - Extra metadata to attach
 * @returns {object} Paystack response data
 */
async function initializeTransaction({ email, amountKobo, reference, metadata = {} }) {
  const response = await axios.post(
    `${PAYSTACK_BASE_URL}/transaction/initialize`,
    {
      email,
      amount: amountKobo,
      reference,
      metadata,
      callback_url: `https://bitlyf.vercel.app/payment/verify`,
    },
    { headers: getHeaders() }
  );

  return response.data;
}

/**
 * Verify a Paystack transaction by reference.
 * @param {string} reference
 * @returns {object} Paystack response data
 */
async function verifyTransaction(reference) {
  const response = await axios.get(
    `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: getHeaders() }
  );

  return response.data;
}

/**
 * Create a transfer recipient on Paystack (required before initiating a transfer).
 * @param {object} params
 * @returns {object} Paystack response data
 */
async function createTransferRecipient({ name, accountNumber, bankCode }) {
  const response = await axios.post(
    `${PAYSTACK_BASE_URL}/transferrecipient`,
    {
      type: 'nuban',
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: 'NGN',
    },
    { headers: getHeaders() }
  );

  return response.data;
}

/**
 * Initiate a Paystack transfer (payout / withdrawal).
 * @param {object} params
 * @returns {object} Paystack response data
 */
async function initiateTransfer({ amountKobo, recipientCode, reference, reason }) {
  const response = await axios.post(
    `${PAYSTACK_BASE_URL}/transfer`,
    {
      source: 'balance',
      amount: amountKobo,
      recipient: recipientCode,
      reference,
      reason,
    },
    { headers: getHeaders() }
  );

  return response.data;
}

/**
 * Fetch list of banks from Paystack (useful for frontend bank selection).
 * @returns {object} Paystack response data
 */
async function getBankList() {
  const response = await axios.get(`${PAYSTACK_BASE_URL}/bank?currency=NGN&perPage=200`, {
    headers: getHeaders(),
  });

  return response.data;
}

/**
 * Resolve account number to get account name.
 * @param {string} accountNumber
 * @param {string} bankCode
 * @returns {object} Paystack response data
 */
async function resolveAccountNumber(accountNumber, bankCode) {
  const response = await axios.get(
    `${PAYSTACK_BASE_URL}/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
    { headers: getHeaders() }
  );

  return response.data;
}

module.exports = {
  initializeTransaction,
  verifyTransaction,
  createTransferRecipient,
  initiateTransfer,
  getBankList,
  resolveAccountNumber,
};
