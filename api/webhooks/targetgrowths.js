/*
 * TargetGrowths IPN/webhook.
 * Register: https://YOUR_DOMAIN/api/webhooks/targetgrowths
 *
 * The provider secret is never exposed to the browser. It is read from
 * TARGETGROWTHS_SECRET_KEY by lib/targetgrowths.js.
 */

const { createClient } = require("@supabase/supabase-js");
const {
  getCredentials,
  parseWebhookBody,
  webhookIdentifier,
  webhookTransactionReference,
  webhookAmount,
  webhookStatus,
  webhookType,
  isSuccessfulStatus,
  isFailedStatus,
  validWebhookSignature,
} = require("../../lib/targetgrowths");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function rawBody(req) {
  return new Promise((resolve, reject) => {
    if (Buffer.isBuffer(req.body)) return resolve(req.body);
    if (typeof req.body === "string") return resolve(Buffer.from(req.body));
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function closeEnough(a, b) {
  return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) < 0.01;
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") return res.json({ ok: true, service: "TargetGrowths webhook" });
  if (req.method !== "POST") return res.status(405).end();

  let body;
  try { body = await rawBody(req); } catch (e) { return res.status(400).json({ error: "Could not read webhook body" }); }
  const payload = parseWebhookBody(body);
  console.log("[TG-WEBHOOK-RAW]", JSON.stringify(payload));
  if (!payload || Object.keys(payload).length === 0) return res.status(400).json({ error: "Empty webhook payload" });

  try { getCredentials(); } catch (e) {
    console.error("[targetgrowths-webhook] credentials are not configured");
    return res.status(500).json({ error: "Webhook is not configured" });
  }

  if (!validWebhookSignature(payload)) {
    console.warn("[targetgrowths-webhook] invalid signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const identifier = webhookIdentifier(payload);
  const providerReference = webhookTransactionReference(payload);
  const amount = webhookAmount(payload);
  const status = webhookStatus(payload);
  const type = webhookType(payload);
  if (!identifier || amount === null || !status) return res.status(400).json({ error: "Missing identifier, amount, or status" });

  if (!isSuccessfulStatus(status) && !isFailedStatus(status)) {
    return res.json({ ok: true, skipped: true, status });
  }

  if (type === "payout" || type === "transfer") {
    const { data: withdrawal, error } = await supabase.from("withdrawals")
      .select("id,amount,net_amount,status,provider_identifier")
      .eq("provider_identifier", identifier).single();
    if (error || !withdrawal) return res.status(404).json({ error: "Withdrawal not found" });

    const expectedAmount = withdrawal.net_amount ?? withdrawal.amount;
    if (!closeEnough(amount, expectedAmount)) return res.status(400).json({ error: "Payout amount mismatch" });

    const { data, error: rpcError } = await supabase.rpc("finalize_targetgrowths_withdrawal", {
      p_withdrawal_id: withdrawal.id,
      p_success: isSuccessfulStatus(status),
      p_provider_reference: providerReference,
      p_provider_status: status,
      p_payload: payload,
    });
    if (rpcError) {
      console.error("[targetgrowths-webhook] withdrawal finalize error:", rpcError.message);
      return res.status(500).json({ error: rpcError.message });
    }
    return res.json({ ok: true, data });
  }

  const { data: deposit, error } = await supabase.from("deposits")
    .select("id,reference,amount,status,provider_identifier")
    .eq("provider_identifier", identifier).single();
  if (error || !deposit) return res.status(404).json({ error: "Deposit not found" });
  if (!closeEnough(amount, deposit.amount)) return res.status(400).json({ error: "Deposit amount mismatch" });

  if (isFailedStatus(status)) {
    await supabase.from("deposits").update({
      status: "rejected",
      provider_status: status,
      provider_reference: providerReference,
      provider_response: payload,
      updated_at: new Date().toISOString(),
    }).eq("id", deposit.id).neq("status", "completed");
    return res.json({ ok: true, action: "rejected" });
  }

  const { data, error: rpcError } = await supabase.rpc("process_deposit", {
    p_reference: deposit.reference,
    p_amount: Number(deposit.amount),
    p_payload: payload,
  });
  if (rpcError) {
    console.error("[targetgrowths-webhook] deposit processing error:", rpcError.message);
    return res.status(500).json({ error: rpcError.message });
  }
  if (data && data.success === false) {
    console.error("[targetgrowths-webhook] deposit settlement rejected:", data.message || data);
    return res.status(400).json({ error: data.message || "Deposit settlement was rejected" });
  }
  await supabase.from("deposits").update({
    provider_status: status,
    provider_reference: providerReference,
    provider_response: payload,
    updated_at: new Date().toISOString(),
  }).eq("id", deposit.id);
  return res.json({ ok: true, action: "auto_credited", data });
};

module.exports.config = { api: { bodyParser: false } };
