const crypto = require("crypto");
const BASE_URL = "https://targetgrowths.com";

function getCredentials() {
  const publicKey = process.env.TARGETGROWTHS_PUBLIC_KEY;
  const secretKey = process.env.TARGETGROWTHS_SECRET_KEY;
  if (!publicKey || !secretKey) {
    throw new Error("TargetGrowths credentials are not configured");
  }
  return { publicKey, secretKey };
}

async function postForm(path, params) {
  const { publicKey } = getCredentials();
  const body = new URLSearchParams();
  Object.entries({ ...params, public_key: publicKey }).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") body.set(key, String(value));
  });

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch (error) {
    error.retryable = true;
    throw error;
  }

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok || data?.error === "true" || data?.success === false) {
    const error = new Error(data?.message || data?.error || `TargetGrowths request failed (${response.status})`);
    error.retryable = false;
    error.providerResponse = data;
    throw error;
  }
  return data;
}

function initiatePayment({ identifier, amount, details, ipnUrl, successUrl, cancelUrl, siteLogo, customerName, customerEmail }) {
  return postForm("/payment/initiate", {
    identifier,
    currency: "NGN",
    amount: Number(amount).toFixed(2),
    details,
    gateway_id: "21",
    ipn_url: ipnUrl,
    success_url: successUrl,
    cancel_url: cancelUrl,
    site_logo: siteLogo,
    checkout_theme: "light",
    customer_name: customerName,
    customer_email: customerEmail,
  });
}

function initiateTransfer({ identifier, amount, bankId, recipient, accountName, ipnUrl, customerEmail }) {
  return postForm("/payment/transfer", {
    identifier,
    currency: "NGN",
    amount: Number(amount).toFixed(2),
    fee_bearer: "merchant",
    bank_id: bankId,
    ipn_url: ipnUrl,
    recipient,
    account_name: accountName,
    customer_email: customerEmail,
  });
}

async function verifyPayment(transactionId) {
  const { secretKey } = getCredentials();
  const url = `${BASE_URL}/verify/payment/${encodeURIComponent(transactionId)}?secret_key=${encodeURIComponent(secretKey)}`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await response.text();
  console.log("[TG-VERIFY-RAW]", url.replace(/secret_key=[^&]+/, "secret_key=REDACTED"), text);
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data?.message || `TargetGrowths verification failed (${response.status})`);
  return data;
}

function parseWebhookBody(rawBody) {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
  if (!text) return {};
  try { return JSON.parse(text); } catch {}

  const params = new URLSearchParams(text);
  const payload = Object.fromEntries(params.entries());
  if (payload.data) {
    try { payload.data = JSON.parse(payload.data); } catch {}
  }
  return payload;
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function webhookData(payload) {
  return asObject(payload?.data);
}

function webhookTransactionReference(payload) {
  const data = webhookData(payload);
  return payload?.transaction_ref || payload?.transactionReference || payload?.trx_id || payload?.transaction_id ||
    data.transaction_ref || data.transactionReference || data.trx_id || data.transaction_id || data.ref_trx || null;
}

function webhookIdentifier(payload) {
  const data = webhookData(payload);
  return payload?.identifier || data.identifier || null;
}

function webhookAmount(payload) {
  const data = webhookData(payload);
  const value = payload?.amount ?? data.amount ?? data.payment_amount ?? data.final_amount;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function webhookStatus(payload) {
  const data = webhookData(payload);
  // The provider's top-level status can describe the webhook/API response.
  // Prefer the nested payment state so an initiated/pending payment cannot credit.
  return String(data.payment_status || data.status || payload?.payment_status || payload?.status || "").trim().toLowerCase();
}

function webhookType(payload) {
  const data = webhookData(payload);
  return String(payload?.pay_type || payload?.payType || data.pay_type || data.payType || data.type || "payin").toLowerCase();
}

function isSuccessfulStatus(status) {
  return ["success", "successful", "completed", "complete", "paid", "approved"].includes(String(status).toLowerCase());
}

function isFailedStatus(status) {
  return ["failed", "failure", "rejected", "reject", "cancelled", "canceled", "declined"].includes(String(status).toLowerCase());
}

function validWebhookSignature(payload) {
  const { secretKey } = getCredentials();
  const data = webhookData(payload);
  const signature = String(payload?.signature || data.signature || "").trim();
  const identifier = webhookIdentifier(payload);
  const amount = webhookAmount(payload);
  if (!signature || !identifier || amount === null) return false;

  const candidates = [String(amount), Number(amount).toFixed(2), Number(amount).toFixed(0)];
  const provided = signature.toUpperCase();
  return candidates.some(value => {
    const expected = crypto.createHmac("sha256", secretKey)
      .update(`${value}${identifier}`)
      .digest("hex")
      .toUpperCase();
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    return expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  });
}

module.exports = {
  getCredentials,
  initiatePayment,
  initiateTransfer,
  verifyPayment,
  parseWebhookBody,
  webhookData,
  webhookTransactionReference,
  webhookIdentifier,
  webhookAmount,
  webhookStatus,
  webhookType,
  isSuccessfulStatus,
  isFailedStatus,
  validWebhookSignature,
};
