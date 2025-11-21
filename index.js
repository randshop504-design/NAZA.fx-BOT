// index.js — NAZA.fx BOT (Node >=18) - Versión con mejoras
// - Cambios autorizados por el cliente:
//   1) No abortar si falta plan_id: marcar membership como 'pending' y NO crear subscription ni otorgar rol.
//   2) Generar membership_id automáticamente si no viene.
// - Otras mejoras prácticas: manejo robusto de plan resolution (varias keys), anti-fraude, logs, debug endpoints.

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const braintree = require('braintree');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 30 * 1000,
  max: 30
});
app.use(limiter);

// CORS allowlist
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = {
  origin: function (origin, callback) {
    // Allow mobile/native (no origin) requests
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  }
};
app.use(cors(corsOptions));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const APP_NAME = process.env.APP_NAME || 'NAZA Trading Academy';

const SHARED_SECRET = process.env.SHARED_SECRET || process.env.X_SHARED_SECRET || 'change-this-shared-secret';
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-jwt-secret';
const FRONTEND_TOKEN = process.env.FRONTEND_TOKEN || null;
const WAIT_FOR_WEBHOOK = (process.env.WAIT_FOR_WEBHOOK || 'true').toLowerCase() === 'true';

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE) ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } }) : null;
if (!supabase) console.warn('⚠️ SUPABASE NOT CONFIGURED - Some features disabled');

// SendGrid
if (!process.env.SENDGRID_API_KEY) console.warn('⚠️ SENDGRID_API_KEY not set');
sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');
const FROM_EMAIL = process.env.FROM_EMAIL || `no-reply@nazatradingacademy.com`;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@nazatradingacademy.com';

// Braintree config
const BT_ENV_RAW = (process.env.BRAINTREE_ENV || process.env.BT_ENVIRONMENT || 'sandbox').toLowerCase();
const BT_ENV = (BT_ENV_RAW === 'production' || BT_ENV_RAW === 'prod') ? braintree.Environment.Production : braintree.Environment.Sandbox;
const gateway = new braintree.BraintreeGateway({
  environment: BT_ENV,
  merchantId: process.env.BRAINTREE_MERCHANT_ID || process.env.BT_MERCHANT_ID || '',
  publicKey: process.env.BRAINTREE_PUBLIC_KEY || process.env.BT_PUBLIC_KEY || '',
  privateKey: process.env.BRAINTREE_PRIVATE_KEY || process.env.BT_PRIVATE_KEY || ''
});

// Discord
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const GUILD_ID = process.env.GUILD_ID || process.env.DISCORD_GUILD_ID || '';
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL || `${BASE_URL}/discord/callback`;
const DISCORD_INVITE_URL = process.env.DISCORD_INVITE_URL || null;
const SUCCESS_URL = process.env.SUCCESS_URL || `${BASE_URL}/success`;

// Role IDs (ajusta por entorno)
const ROLE_ID_SENALES = process.env.ROLE_ID_SENALES || process.env.ROLE_ID_SENALESDISCORD || null;
const ROLE_ID_MENTORIA = process.env.ROLE_ID_MENTORIA || process.env.ROLE_ID_MENTORIADISCORD || null;
const ROLE_ID_ANUAL = process.env.ROLE_ID_ANUAL || process.env.ROLE_ID_ANUALDISCORD || ROLE_ID_MENTORIA || null;

// Plan constants
const PLAN_IDS = {
  MENSUAL: "plan_mensual",
  TRIMESTRAL: "plan_trimestral",
  ANUAL: "plan_anual"
};

// PRODUCT -> PLAN map (textual, usado para product_name)
const PRODUCT_NAME_TO_PLAN = {
  'plan mensual de señales 🛰️': PLAN_IDS.MENSUAL,
  'plan mensual de señales': PLAN_IDS.MENSUAL,
  'educación desde cero🧑‍🚀👩‍🚀': PLAN_IDS.TRIMESTRAL,
  'educación desde cero': PLAN_IDS.TRIMESTRAL,
  'educación total 🏅': PLAN_IDS.ANUAL,
  'educación total': PLAN_IDS.ANUAL,
  'educacion desde cero': PLAN_IDS.TRIMESTRAL,
  'educacion total': PLAN_IDS.ANUAL,
  'plan anual': PLAN_IDS.ANUAL
};

// ---------- Helpers ----------
function escapeHtml(s){ if(!s) return ''; return String(s).replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]); }

async function logEvent(event_id, event_type, data){
  try{
    if (supabase) await supabase.from('webhook_logs').insert({ event_id, event_type, data, processed: false });
  } catch(e){ console.log('logEvent error', e?.message || e); }
}

async function markWebhookProcessed(event_id){
  try{ if (supabase) await supabase.from('webhook_logs').update({ processed: true, processed_at: new Date().toISOString() }).eq('event_id', event_id); } catch(e){ console.log('markWebhookProcessed error', e?.message || e); }
}

async function upsertLink(membership_id, discord_id, discord_username, discord_email){
  if(!membership_id || !discord_id || !supabase) return;
  try{ 
    await supabase.from('membership_links').upsert({ 
      membership_id, 
      discord_id,
      discord_username: discord_username || null,
      discord_email: discord_email || null,
      is_active: true,
      updated_at: new Date().toISOString()
    }, { onConflict: 'membership_id' }); 
  } catch(e){ console.log('upsertLink error', e?.message || e); }
}

async function createClaimRecord(jti, membership_id, plan_id){ 
  if(!supabase) return; 
  try{ 
    await supabase.from('claims_issued').insert({ 
      jti, 
      membership_id,
      plan_id,
      expires_at: new Date(Date.now() + 24*60*60*1000).toISOString()
    }); 
  } catch(e){ console.log('createClaimRecord error', e?.message || e); } 
}

async function markClaimUsed(jti, discord_id, ip){ 
  if(!supabase) return; 
  try{ 
    await supabase.from('claims_issued').update({ 
      used_at: new Date().toISOString(),
      used_by_discord_id: discord_id || null,
      used_from_ip: ip || null
    }).eq('jti', jti).is('used_at', null); 
  } catch(e){ console.log('markClaimUsed error', e?.message || e); } 
}

async function checkClaimUsed(jti){ 
  if(!jti) return true; 
  if(!supabase) return false; 
  try{ 
    const { data } = await supabase.from('claims_issued').select('used_at').eq('jti', jti).maybeSingle(); 
    return !!(data?.used_at); 
  } catch(e){ console.log('checkClaimUsed error', e?.message || e); return true; } 
}

// Anti-fraud helpers
async function logFailedAttempt({ email, card_last4, ip_address, user_agent, failure_type, error_message, plan_id, amount, raw_data }){
  if(!supabase) return;
  try{
    await supabase.from('failed_attempts').insert({
      email: email || null,
      card_last4: card_last4 || null,
      ip_address: ip_address || null,
      user_agent: user_agent || null,
      failure_type,
      error_message: error_message || null,
      plan_id: plan_id || null,
      amount: amount || null,
      raw_data: raw_data || null
    });
  } catch(e){ console.log('logFailedAttempt error', e?.message || e); }
}

async function checkAndRegisterCard({ card_fingerprint, card_last4, card_type, membership_id }){
  if(!supabase || !card_fingerprint) return { is_suspicious: false, usage_count: 1 };
  try{
    const { data: existing } = await supabase
      .from('card_fingerprints')
      .select('*')
      .eq('card_fingerprint', card_fingerprint)
      .maybeSingle();

    if (existing) {
      const new_count = (existing.usage_count || 1) + 1;
      const new_memberships = Array.isArray(existing.membership_ids) ? [...existing.membership_ids, membership_id] : [membership_id];
      await supabase.from('card_fingerprints').update({
        usage_count: new_count,
        membership_ids: new_memberships,
        last_seen_at: new Date().toISOString(),
        is_flagged: new_count > 2,
        flag_reason: new_count > 2 ? `used_in_${new_count}_accounts` : null
      }).eq('card_fingerprint', card_fingerprint);
      return { is_suspicious: new_count > 3, usage_count: new_count };
    } else {
      await supabase.from('card_fingerprints').insert({
        card_fingerprint,
        card_last4,
        card_type,
        usage_count: 1,
        membership_ids: [membership_id]
      });
      return { is_suspicious: false, usage_count: 1 };
    }
  } catch(e){
    console.log('checkAndRegisterCard error', e?.message || e);
    return { is_suspicious: false, usage_count: 1 };
  }
}

// Normalize product names and resolve plan id from multiple possible inputs
function removeEmojisAndTrim(s){
  if(!s) return '';
  return String(s)
    .replace(/([\u231A-\u32FF\uD83C-\uDBFF\uDC00-\uDFFF\u200D])/g, '')
    .replace(/\s+/g,' ')
    .trim();
}

function normalizeName(s){
  if(!s) return '';
  return removeEmojisAndTrim(String(s))
    .toLowerCase()
    .replace(/\s+/g,' ')
    .trim();
}

function resolvePlanIdFromMap(normalizedProductName) {
  if(!normalizedProductName) return null;
  for (const [key, val] of Object.entries(PRODUCT_NAME_TO_PLAN)){
    if (normalizeName(key) === normalizedProductName) return val;
  }
  for (const [key, val] of Object.entries(PRODUCT_NAME_TO_PLAN)){
    if (normalizedProductName.includes(normalizeName(key))) return val;
  }
  return null;
}

// Resolve plan from many possible request fields: prefer explicit plan_id, then plan, then planString, then product_name variants.
function resolvePlanId({ plan_id, plan, planString, product_name, productTitle, productName }) {
  // direct explicit
  if (plan_id && String(plan_id).trim()) return String(plan_id).trim();
  if (plan && String(plan).trim()) return String(plan).trim();
  if (planString && String(planString).trim()) return String(planString).trim();

  // product name variants
  const candidate = product_name || productTitle || productName || '';
  const normalized = normalizeName(candidate);
  if (normalized) {
    const byMap = resolvePlanIdFromMap(normalized);
    if (byMap) return byMap;
  }

  return null;
}

// Email template
function buildWelcomeEmailHTML({ name, email, claim, membership_id }){
  const claimLink = `${BASE_URL}/discord/login?claim=${encodeURIComponent(claim)}`;
  return `
  <div style="background:#071022;padding:24px;color:#e6eef8;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto">
      <tr><td align="center" style="padding:18px 0">
        ${process.env.LOGO_URL ? `<img src="${process.env.LOGO_URL}" alt="${APP_NAME}" style="width:120px;border-radius:8px;display:block;margin-bottom:12px">` : ''}
        <h1 style="margin:6px 0 0;font-size:26px;color:#fff">${escapeHtml(APP_NAME)}</h1>
        <p style="margin:8px 0 0;color:#bfc9d6">Bienvenido${name? ' ' + escapeHtml(name):''} — gracias por unirte a ${escapeHtml(APP_NAME)}.</p>
      </td></tr>
      <tr><td align="center" style="padding:18px 16px">
        <a href="${claimLink}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#18a957;color:#fff;text-decoration:none;font-weight:700">Acceder al servidor Discord</a>
        <div style="color:#98a3b4;font-size:12px;margin-top:8px">Enlace de un solo uso, expira en 24 horas.</div>
      </td></tr>
      <tr><td style="padding:18px 24px;color:#9fb6a3;font-size:13px">
        <p style="margin:6px 0">Tu ID de membresía: <strong>${escapeHtml(membership_id)}</strong></p>
        <p style="margin:6px 0">Soporte: <a href="mailto:${SUPPORT_EMAIL}" style="color:#cdebd8">${SUPPORT_EMAIL}</a></p>
      </td></tr>
    </table>
  </div>`;
}

// Core handler: what pasa una vez que el pago está confirmado (genera claim, envía email)
async function handleConfirmedPayment({ plan_id, email, membership_id, user_name }){
  try{
    const jti = crypto.randomUUID();
    const payload = { membership_id, plan_id, user_name, jti };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h', jwtid: jti });

    await logEvent(membership_id || jti, 'payment_confirmed', { plan_id, email, membership_id, user_name });
    await createClaimRecord(jti, membership_id, plan_id);

    // Send email (async)
    (async ()=>{
      try{
        const html = buildWelcomeEmailHTML({ name: user_name, email, claim: token, membership_id });
        await sgMail.send({ to: email, from: FROM_EMAIL, subject: `${APP_NAME} — Acceso y pasos (Discord)`, html });
        console.log('📧 Welcome email sent to', email);
      }catch(e){ console.error('sendgrid error', e?.message || e); }
    })();

    return { claim: token, redirect: `${BASE_URL}/discord/login?claim=${encodeURIComponent(token)}` };
  } catch(e){
    console.error('handleConfirmedPayment error', e?.message || e);
    throw e;
  }
}

// Discord helpers
async function addDiscordRole(discordId, roleId){
  if(!discordId || !roleId || !GUILD_ID || !DISCORD_BOT_TOKEN) return;
  try{
    await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}/roles/${roleId}`, {
      method: 'PUT',
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
    });
  }catch(e){ console.warn('addDiscordRole error', e?.message || e); }
}

async function removeDiscordRole(discordId, roleId){
  if(!discordId || !roleId || !GUILD_ID || !DISCORD_BOT_TOKEN) return;
  try{
    await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}/roles/${roleId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
    });
  }catch(e){ console.warn('removeDiscordRole error', e?.message || e); }
}

function roleForPlan(planId){
  if (!planId) return null;
  if (planId === PLAN_IDS.MENSUAL) return ROLE_ID_SENALES;
  if (planId === PLAN_IDS.TRIMESTRAL) return ROLE_ID_MENTORIA;
  if (planId === PLAN_IDS.ANUAL) return ROLE_ID_ANUAL;
  return ROLE_ID_MENTORIA;
}

// ============================================
// ENDPOINT PRINCIPAL: /api/payment/process
// ============================================
app.post('/api/payment/process', async (req, res) => {
  const ip_address = req.ip || req.connection.remoteAddress;
  const user_agent = req.get('user-agent') || '';

  try {
    // Origin check
    const origin = req.get('Origin') || req.get('origin') || '';
    if (ALLOWED_ORIGINS.length > 0 && origin) {
      if (!ALLOWED_ORIGINS.includes(origin)) {
        await logFailedAttempt({ ip_address, user_agent, failure_type: 'origin_not_allowed', error_message: `Origin: ${origin}` });
        return res.status(403).json({ error: 'origin_not_allowed' });
      }
    }

    // Frontend token check
    if (FRONTEND_TOKEN) {
      const sent = req.get('x-frontend-token') || req.body?.frontend_token || '';
      if (!sent || sent !== FRONTEND_TOKEN) {
        await logFailedAttempt({ ip_address, user_agent, failure_type: 'invalid_frontend_token' });
        return res.status(401).json({ error: 'invalid_frontend_token' });
      }
    }

    // Shared secret check
    const secret = req.get('X-SHARED-SECRET') || req.body?.shared_secret || '';
    if (!secret || secret !== SHARED_SECRET) {
      await logFailedAttempt({ ip_address, user_agent, failure_type: 'unauthorized' });
      return res.status(401).json({ error: 'unauthorized' });
    }

    // Extract many possible fields (flexible request parsing)
    const body = req.body || {};
    const {
      product_name,
      productTitle,
      productName,
      plan_id: incoming_plan,
      plan,
      planString,
      email,
      membership_id: incoming_membership_id,
      user_name,
      payment_method_nonce
    } = body;

    // Resolve plan robustly
    const planResolved = resolvePlanId({
      plan_id: incoming_plan,
      plan,
      planString,
      product_name,
      productTitle,
      productName
    });

    let plan_missing = false;
    if (!planResolved) plan_missing = true;

    // Email mandatory
    if (!email) {
      await logFailedAttempt({ email, ip_address, user_agent, failure_type: 'missing_email', error_message: 'email missing', plan_id: planResolved });
      return res.status(400).json({ error: 'missing_email' });
    }

    // membership_id auto-generation if missing (autorizado)
    let membership_id = incoming_membership_id;
    if (!membership_id) {
      membership_id = crypto.randomUUID();
      console.log('Auto-created membership_id for payment flow:', membership_id);
      await logEvent(membership_id, 'membership_auto_created', { source: 'auto_generated', email, plan_id: planResolved || null });
    }

    // payment_method_nonce required to tokenize card
    if (!payment_method_nonce) {
      await logFailedAttempt({ email, ip_address, user_agent, failure_type: 'missing_nonce', plan_id: planResolved });
      return res.status(400).json({ error: 'payment_method_nonce_required' });
    }

    // Create customer in Braintree
    let customerId = null;
    try {
      const custRes = await gateway.customer.create({
        email,
        firstName: user_name || '',
        customFields: { membership_id }
      });
      if (custRes.success) customerId = custRes.customer.id;
      else {
        await logFailedAttempt({ email, ip_address, user_agent, failure_type: 'customer_creation_failed', error_message: custRes.message, plan_id: planResolved });
        return res.status(400).json({ error: 'customer_creation_failed', detail: custRes.message });
      }
    } catch(e){
      await logFailedAttempt({ email, ip_address, user_agent, failure_type: 'customer_creation_error', error_message: e.message, plan_id: planResolved });
      return res.status(500).json({ error: 'customer_creation_error', message: e.message });
    }

    // Create payment method (tokenize)
    let paymentMethodToken = null;
    let card_last4 = null;
    let card_type = null;
    let card_fingerprint = null;
    try {
      const pmRes = await gateway.paymentMethod.create({
        customerId: customerId,
        paymentMethodNonce: payment_method_nonce,
        options: { verifyCard: true, makeDefault: true }
      });
      if (pmRes.success) {
        paymentMethodToken = pmRes.paymentMethod.token;
        card_last4 = pmRes.paymentMethod.last4 || null;
        card_type = pmRes.paymentMethod.cardType || null;
        card_fingerprint = pmRes.paymentMethod.uniqueNumberIdentifier || null;
      } else {
        await logFailedAttempt({ email, ip_address, user_agent, failure_type: 'payment_method_creation_failed', error_message: pmRes.message, plan_id: planResolved });
        return res.status(400).json({ error: 'card_verification_failed', detail: pmRes.message });
      }
    } catch(e){
      await logFailedAttempt({ email, ip_address, user_agent, failure_type: 'payment_method_error', error_message: e.message, plan_id: planResolved });
      return res.status(500).json({ error: 'payment_method_error', message: e.message });
    }

    // Anti-fraud: card usage
    const cardCheck = await checkAndRegisterCard({ card_fingerprint, card_last4, card_type, membership_id });
    if (cardCheck.is_suspicious) {
      await logFailedAttempt({ email, card_last4, ip_address, user_agent, failure_type: 'suspicious_card_blocked', error_message: `Card used in ${cardCheck.usage_count} accounts`, plan_id: planResolved });
      return res.status(403).json({ error: 'card_blocked', message: 'Esta tarjeta ha sido marcada como sospechosa. Contacta soporte.' });
    }

    // If plan missing -> DO NOT create subscription nor assign roles. Save membership as pending.
    if (plan_missing) {
      try {
        if (supabase) {
          await supabase.from('memberships').insert({
            membership_id,
            email,
            user_name: user_name || null,
            plan_id: null,
            plan_name: product_name || productTitle || productName || null,
            amount_paid: null,
            currency: 'USD',
            braintree_subscription_id: null,
            braintree_customer_id: customerId,
            braintree_payment_method_token: paymentMethodToken,
            card_last4,
            card_type,
            status: 'pending',
            activated_at: null,
            ip_address,
            user_agent
          });
        }
        await logEvent(membership_id, 'membership_created_pending_plan_missing', { email, product_name, incoming_plan: incoming_plan || plan || planString });
        return res.json({ ok: true, membership_id, status: 'pending', message: 'plan_missing' });
      } catch (e) {
        await logFailedAttempt({ email, card_last4, ip_address, user_agent, failure_type: 'membership_save_failed', error_message: e.message, plan_id: null });
        return res.status(500).json({ error: 'membership_save_failed', message: e.message });
      }
    }

    // If plan present -> create subscription (normal flow)
    const planIdToUse = planResolved;
    let subscriptionId = null;
    let amount_paid = null;
    let transactionId = null;

    try {
      const subRes = await gateway.subscription.create({
        paymentMethodToken: paymentMethodToken,
        planId: planIdToUse
      });

      if (subRes.success) {
        subscriptionId = subRes.subscription.id;
        amount_paid = subRes.subscription.price || null;
        if (subRes.subscription.transactions && subRes.subscription.transactions.length > 0) {
          transactionId = subRes.subscription.transactions[0].id;
        }

        // Save membership
        if (supabase) {
          await supabase.from('memberships').insert({
            membership_id,
            email,
            user_name: user_name || null,
            plan_id: planIdToUse,
            plan_name: product_name || null,
            amount_paid: amount_paid || null,
            currency: 'USD',
            braintree_subscription_id: subscriptionId,
            braintree_customer_id: customerId,
            braintree_payment_method_token: paymentMethodToken,
            card_last4,
            card_type,
            status: WAIT_FOR_WEBHOOK ? 'pending' : 'active',
            activated_at: WAIT_FOR_WEBHOOK ? null : new Date().toISOString(),
            ip_address,
            user_agent
          });
        }

        // Save transaction details
        if (supabase && transactionId) {
          const tx = subRes.subscription.transactions[0];
          await supabase.from('transactions').insert({
            membership_id,
            braintree_transaction_id: transactionId,
            braintree_subscription_id: subscriptionId,
            amount: tx.amount,
            currency: tx.currencyIsoCode || 'USD',
            status: tx.status,
            plan_id: planIdToUse,
            card_last4,
            card_type,
            ip_address,
            user_agent,
            raw_data: tx
          });
        }

        await logEvent(membership_id, 'subscription_created', { plan_id: planIdToUse, subscription_id: subscriptionId, amount: amount_paid });

        if (WAIT_FOR_WEBHOOK) {
          return res.json({ ok: true, message: 'subscription_created_waiting_webhook', subscription_id: subscriptionId, membership_id });
        } else {
          const result = await handleConfirmedPayment({ plan_id: planIdToUse, email, membership_id, user_name });
          return res.json({ ok: true, claim: result.claim, redirect: result.redirect });
        }
      } else {
        const errorDetail = subRes.message || JSON.stringify(subRes);
        await logFailedAttempt({ email, card_last4, ip_address, user_agent, failure_type: 'subscription_creation_failed', error_message: errorDetail, plan_id: planIdToUse, amount: amount_paid });
        await logEvent(membership_id, 'subscription_failed', { plan_id: planIdToUse, error: errorDetail });
        return res.status(400).json({ error: 'subscription_failed', detail: errorDetail });
      }
    } catch(e){
      await logFailedAttempt({ email, card_last4, ip_address, user_agent, failure_type: 'subscription_error', error_message: e.message, plan_id: planIdToUse });
      return res.status(500).json({ error: 'subscription_error', message: e.message });
    }

  } catch (e) {
    console.error('process endpoint error', e?.message || e);
    await logFailedAttempt({ ip_address, user_agent, failure_type: 'server_error', error_message: e.message });
    return res.status(500).json({ error: 'server_error' });
  }
});

// Legacy helpers endpoints kept for compatibility
app.post('/api/payment/notify', async (req, res) => {
  try {
    const secret = req.get('X-SHARED-SECRET') || '';
    if (!secret || secret !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });

    const { plan_id, product_name, email, membership_id, user_name } = req.body || {};
    const resolved = resolvePlanId({ plan_id, product_name });
    if (!resolved || !email || !membership_id) return res.status(400).json({ error: 'missing_fields_or_plan_not_resolved' });

    const result = await handleConfirmedPayment({ plan_id: resolved, email, membership_id, user_name });
    return res.json({ ok: true, claim: result.claim, redirect: result.redirect });
  } catch (e) { console.error('notify error', e?.message || e); return res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/payment/confirm', async (req, res) => {
  try {
    const secret = req.get('X-SHARED-SECRET') || '';
    if (!secret || secret !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });

    const { plan_id, product_name, email, membership_id, user_name } = req.body || {};
    const resolved = resolvePlanId({ plan_id, product_name });
    if (!resolved || !email || !membership_id) return res.status(400).json({ error: 'missing_fields_or_plan_not_resolved' });

    const result = await handleConfirmedPayment({ plan_id: resolved, email, membership_id, user_name });
    return res.json({ ok: true, claim: result.claim, redirect: result.redirect });
  } catch (e) { console.error('confirm error', e?.message || e); return res.status(500).json({ error: 'server_error' }); }
});

// Braintree webhook endpoint (raw body)
app.post('/api/braintree/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const bodyStr = req.body.toString('utf8');
    let bt_signature = '', bt_payload = '';
    try{
      const params = new URLSearchParams(bodyStr);
      if (params.has('bt_signature') && params.has('bt_payload')) {
        bt_signature = params.get('bt_signature');
        bt_payload = params.get('bt_payload');
      } else {
        const parsed = JSON.parse(bodyStr);
        bt_signature = parsed.bt_signature || parsed.signature || '';
        bt_payload = parsed.bt_payload || parsed.payload || '';
      }
    }catch(e){}

    if(!bt_signature || !bt_payload) {
      console.warn('missing signature/payload in webhook');
      return res.status(400).send('missing_signature_or_payload');
    }

    let notification;
    try {
      notification = await gateway.webhookNotification.parse(bt_signature, bt_payload);
    } catch (e) {
      console.error('braintree parse error', e?.message || e);
      return res.status(400).send('invalid_webhook');
    }

    const event_id = notification.timestamp || Date.now();
    await logEvent(event_id, 'braintree_webhook', { kind: notification.kind, raw: notification });

    const kind = String(notification.kind || '').toLowerCase();

    // Subscription charged successfully
    if (notification.kind === braintree.WebhookNotification.Kind.SubscriptionChargedSuccessfully ||
        kind.includes('subscription_charged_successfully') || kind.includes('subscription_charged')) {
      
      const subscription = notification.subscription;
      const plan_id = subscription.planId || null;
      const braintree_subscription_id = subscription.id;
      
      // Look up membership from Supabase
      let membership_id = null, email = null, user_name = null;
      
      if (supabase) {
        const { data } = await supabase
          .from('memberships')
          .select('membership_id, email, user_name')
          .eq('braintree_subscription_id', braintree_subscription_id)
          .maybeSingle();
        
        if (data) {
          membership_id = data.membership_id;
          email = data.email;
          user_name = data.user_name;
        }
      }

      if (email && membership_id) {
        // Update membership status to active
        if (supabase) {
          await supabase
            .from('memberships')
            .update({ status: 'active', activated_at: new Date().toISOString() })
            .eq('membership_id', membership_id);
        }

        // Confirm payment: generate claim, send email and allow discord flow
        try {
          await handleConfirmedPayment({ plan_id: (plan_id || 'plan_unknown'), email, membership_id, user_name });
          await markWebhookProcessed(event_id);
        } catch(e){ console.error('handleConfirmedPayment error', e?.message || e); }
      } else {
        console.warn('webhook charged_successfully missing membership or email', { braintree_subscription_id, email });
      }
    }

    // Subscription canceled/expired -> remove roles
    else if (notification.kind === braintree.WebhookNotification.Kind.SubscriptionCanceled ||
             kind.includes('subscription_canceled') ||
             kind.includes('subscription_expired') ||
             kind.includes('subscription_went_past_due') ||
             kind.includes('subscription_charged_unsuccessfully') ||
             kind.includes('subscription_went_inactive')) {

      const subscription = notification.subscription || {};
      const braintree_subscription_id = subscription.id;

      if (braintree_subscription_id && supabase) {
        // Update membership status
        await supabase
          .from('memberships')
          .update({ 
            status: kind.includes('canceled') ? 'canceled' : 'expired',
            canceled_at: new Date().toISOString()
          })
          .eq('braintree_subscription_id', braintree_subscription_id);

        // Get membership_id to find Discord link
        const { data: membership } = await supabase
          .from('memberships')
          .select('membership_id')
          .eq('braintree_subscription_id', braintree_subscription_id)
          .maybeSingle();

        if (membership) {
          const { data: link } = await supabase
            .from('membership_links')
            .select('discord_id')
            .eq('membership_id', membership.membership_id)
            .maybeSingle();

          const discordId = link?.discord_id || null;
          if (discordId) {
            const rolesToRemove = [ROLE_ID_SENALES, ROLE_ID_MENTORIA, ROLE_ID_ANUAL].filter(Boolean);
            for (const r of rolesToRemove) {
              await removeDiscordRole(discordId, r);
            }
            await logEvent(membership.membership_id, 'role_removed_via_webhook', { reason: notification.kind });
          }
        }

        await markWebhookProcessed(event_id);
      }
    } else {
      console.log('unhandled webhook kind', notification.kind);
    }

    return res.status(200).send('ok');
  } catch (e) { 
    console.error('webhook handler error', e?.message || e); 
    return res.status(500).send('server_error'); 
  }
});

// Discord OAuth endpoints
function requireClaim(req, res, next){
  const { claim } = req.query || {};
  if (!claim) return res.status(401).send('🔒 Enlace inválido. Abre desde tu correo o desde tu sitio.');
  try { req.claim = jwt.verify(claim, JWT_SECRET); next(); } catch (e) { return res.status(401).send('⛔ Enlace inválido o vencido.'); }
}

app.get('/discord/login', requireClaim, (req, res) => {
  const state = jwt.sign({ 
    ts: Date.now(), 
    membership_id: req.claim.membership_id, 
    jti: req.claim.jti, 
    plan_id: req.claim.plan_id 
  }, JWT_SECRET, { expiresIn: '10m' });
  
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URL,
    response_type: 'code',
    scope: 'identify guilds.join email',
    prompt: 'consent',
    state
  });
  res.redirect('https://discord.com/api/oauth2/authorize?' + params.toString());
});

app.get('/discord/callback', async (req, res) => {
  const ip_address = req.ip || req.connection.remoteAddress;
  
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('missing_code_or_state');
    const st = jwt.verify(state, JWT_SECRET);

    if (await checkClaimUsed(st.jti)) return res.status(409).send('⛔ Este enlace ya fue usado.');

    const tRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URL
      })
    });
    
    if (!tRes.ok) {
      const body = await tRes.text();
      console.error('discord token error', tRes.status, body);
      return res.status(400).send('Error obtaining token');
    }
    
    const tJson = await tRes.json();
    const access_token = tJson.access_token;

    const meRes = await fetch('https://discord.com/api/v10/users/@me', { 
      headers: { Authorization: `Bearer ${access_token}` }
    });
    
    if (!meRes.ok) return res.status(400).send('Error reading user');
    const me = await meRes.json();

    // Join guild (best-effort)
    try {
      await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${me.id}`, {
        method: 'PUT',
        headers: { 
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ access_token })
      });
    } catch (e) { console.warn('join guild failed', e?.message || e); }

    // Assign role only if plan exists in claim
    const planId = String(st.plan_id || '').trim();
    const roleToAssign = roleForPlan(planId);

    if (roleToAssign) {
      try{
        await addDiscordRole(me.id, roleToAssign);
      } catch (e) { console.warn('assign role failed', e?.message || e); }
    }

    // Persist link with Discord username and email
    await upsertLink(st.membership_id, me.id, me.username, me.email);
    await markClaimUsed(st.jti, me.id, ip_address);

    const redirectTo = DISCORD_INVITE_URL || SUCCESS_URL;
    return res.redirect(redirectTo);
  } catch (e) { 
    console.error('callback error', e?.message || e); 
    return res.status(500).send('OAuth error'); 
  }
});

// Health & debug endpoints
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString(), version: 'improved-1.0' }));

app.get('/_debug/logs', async (_req, res) => {
  try {
    if (!supabase) return res.json([]);
    const { data, error } = await supabase
      .from('webhook_logs')
      .select('event_type, received_at, data, processed')
      .order('received_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/_debug/memberships', async (_req, res) => {
  try {
    if (!supabase) return res.json([]);
    const { data, error } = await supabase
      .from('memberships')
      .select('membership_id, email, plan_id, status, created_at, card_last4')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Start server
app.listen(PORT, () => {
  console.log('🟢 NAZA.fx BOT running on', BASE_URL);
  console.log('⏳ WAIT_FOR_WEBHOOK =', WAIT_FOR_WEBHOOK);
  console.log('📊 Supabase:', supabase ? 'CONNECTED' : 'NOT CONFIGURED');
  console.log('💳 Braintree:', BT_ENV === braintree.Environment.Production ? 'PRODUCTION' : 'SANDBOX');
  console.log('');
  console.log('Endpoints:');
  console.log('  POST /api/payment/process → Main payment endpoint');
  console.log('  POST /api/braintree/webhook → Braintree webhooks');
  console.log('  GET  /discord/login → Discord OAuth start');
  console.log('  GET  /discord/callback → Discord OAuth callback');
  console.log('  GET  /_debug/logs → View webhook logs');
  console.log('  GET  /_debug/memberships → View memberships');
});
