// index.js — NAZA.fx BOT (Node >=18)
// Mejora: espera webhook (WAIT_FOR_WEBHOOK), mapeo producto->plan, manejo de webhooks para asignar/remover roles Discord,
// BraintreeGateway (Node 18+), uso fetch global, endpoints de confirmación/notify y de webhook.
// Ajusta variables de entorno en Render antes de desplegar.

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

// Supabase (optional, used for logs & links)
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE) ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } }) : null;

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

// Role IDs
const ROLE_ID_SENALES = process.env.ROLE_ID_SENALES || process.env.ROLE_ID_SENALESDISCORD || null;
const ROLE_ID_MENTORIA = process.env.ROLE_ID_MENTORIA || process.env.ROLE_ID_MENTORIADISCORD || null;
const ROLE_ID_ANUAL = process.env.ROLE_ID_ANUAL || process.env.ROLE_ID_ANUALDISCORD || ROLE_ID_MENTORIA || null;

const PLAN_IDS = {
  MENSUAL: "plan_mensual",
  TRIMESTRAL: "plan_trimestral",
  ANUAL: "plan_anual"
};

// PRODUCT -> PLAN map (keep lowercase + emojis for readable mapping)
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

// Helpers
function escapeHtml(s){ if(!s) return ''; return String(s).replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]); }

async function logEvent(event_id, event_type, data){
  try{
    if (supabase) await supabase.from('webhook_logs').insert({ event_id, event_type, data });
  } catch(e){ console.log('logEvent error', e?.message || e); }
}

async function upsertLink(membership_id, discord_id){
  if(!membership_id || !discord_id || !supabase) return;
  try{ await supabase.from('membership_links').upsert({ membership_id, discord_id }, { onConflict: 'membership_id' }); } catch(e){ console.log('upsertLink error', e?.message || e); }
}
async function createClaimRecord(jti, membership_id){ if(!supabase) return; try{ await supabase.from('claims_issued').insert({ jti, membership_id }); } catch(e){} }
async function markClaimUsed(jti){ if(!supabase) return; try{ await supabase.from('claims_issued').update({ used_at: new Date().toISOString() }).eq('jti', jti).is('used_at', null); } catch(e){ console.log('markClaimUsed error', e?.message || e); } }
async function checkClaimUsed(jti){ if(!jti) return true; if(!supabase) return true; try{ const { data } = await supabase.from('claims_issued').select('used_at').eq('jti', jti).maybeSingle(); return !!(data?.used_at); } catch(e){ return true; } }

// Normalize product names: remove emojis, extra whitespace, lowercase
function removeEmojisAndTrim(s){
  if(!s) return '';
  // rough emoji removal: remove characters in surrogate pairs and some ranges
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
function resolvePlanId({ plan_id, product_name }){
  if (plan_id && String(plan_id).trim()) return String(plan_id).trim();
  const normalized = normalizeName(product_name);
  if (!normalized) return null;
  // direct match against normalized keys
  for (const [key, val] of Object.entries(PRODUCT_NAME_TO_PLAN)){
    if (normalizeName(key) === normalized) return val;
  }
  // try contains match
  for (const [key, val] of Object.entries(PRODUCT_NAME_TO_PLAN)){
    if (normalized.includes(normalizeName(key))) return val;
  }
  return null;
}

// Email template
function buildWelcomeEmailHTML({ name, email, claim }){
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
        <a href="${claimLink}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#18a957;color:#fff;text-decoration:none;font-weight:700">Acceder al servidor</a>
        <div style="color:#98a3b4;font-size:12px;margin-top:8px">Enlace de un solo uso, expira en 24 horas.</div>
      </td></tr>
      <tr><td style="padding:18px 24px;color:#9fb6a3;font-size:13px">
        <p style="margin:6px 0">Soporte: <a href="mailto:${SUPPORT_EMAIL}" style="color:#cdebd8">${SUPPORT_EMAIL}</a></p>
      </td></tr>
    </table>
  </div>`;
}

// Core handler: what happens once payment is confirmed (called after webhook verified)
async function handleConfirmedPayment({ plan_id, email, membership_id, user_name }){
  try{
    const jti = crypto.randomUUID();
    const payload = { membership_id, plan_id, user_name, jti };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h', jwtid: jti });

    await logEvent(membership_id || jti, 'payment_confirmed', { plan_id, email, membership_id, user_name });
    await createClaimRecord(jti, membership_id);

    // send email asynchronously
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

// Minimal helper to add role on Discord
async function addDiscordRole(discordId, roleId){
  if(!discordId || !roleId || !GUILD_ID || !DISCORD_BOT_TOKEN) return;
  try{
    await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}/roles/${roleId}`, {
      method: 'PUT',
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
    });
  }catch(e){ console.warn('addDiscordRole error', e?.message || e); }
}

// Minimal helper to remove role on Discord
async function removeDiscordRole(discordId, roleId){
  if(!discordId || !roleId || !GUILD_ID || !DISCORD_BOT_TOKEN) return;
  try{
    await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}/roles/${roleId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
    });
  }catch(e){ console.warn('removeDiscordRole error', e?.message || e); }
}

// Map plan -> role
function roleForPlan(planId){
  if (!planId) return null;
  if (planId === PLAN_IDS.MENSUAL) return ROLE_ID_SENALES;
  if (planId === PLAN_IDS.TRIMESTRAL) return ROLE_ID_MENTORIA;
  if (planId === PLAN_IDS.ANUAL) return ROLE_ID_ANUAL;
  return ROLE_ID_MENTORIA;
}

// ROUTES

// Public endpoint for frontend to tell bot "process this payment attempt"
// Expects: product_name, email, membership_id, user_name, payment_method_nonce (optional)
app.post('/api/payment/process', async (req, res) => {
  try {
    // Optional origin check
    const origin = req.get('Origin') || req.get('origin') || '';
    if (ALLOWED_ORIGINS.length > 0 && origin) {
      if (!ALLOWED_ORIGINS.includes(origin)) return res.status(403).json({ error: 'origin_not_allowed' });
    }

    if (FRONTEND_TOKEN) {
      const sent = req.get('x-frontend-token') || req.body?.frontend_token || '';
      if (!sent || sent !== FRONTEND_TOKEN) return res.status(401).json({ error: 'invalid_frontend_token' });
    }

    const secret = req.get('X-SHARED-SECRET') || req.body?.shared_secret || '';
    if (!secret || secret !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });

    const { product_name, plan_id: incoming_plan, email, membership_id, user_name, payment_method_nonce } = req.body || {};

    const plan_id = resolvePlanId({ plan_id: incoming_plan, product_name });
    if (!plan_id || !email || !membership_id) return res.status(400).json({ error: 'missing_fields_or_plan_not_resolved' });

    // create customer / payment method / subscription in Braintree (sandbox)
    // If frontend already tokenized and created a customer, you could skip some steps.
    // Here we try to create subscription using provided nonce.
    try {
      // create customer (or use existing via search) - minimal approach
      let customerId = null;
      // create a customer with email and name
      const custRes = await gateway.customer.create({ email, firstName: user_name || '', customFields: { membership_id } }).catch(()=>null);
      if (custRes && custRes.success) customerId = custRes.customer.id;

      // create payment method
      let paymentMethodToken = null;
      if (payment_method_nonce) {
        const pm = await gateway.paymentMethod.create({
          customerId: customerId,
          paymentMethodNonce: payment_method_nonce,
          options: { verifyCard: true, makeDefault: true }
        }).catch(()=>null);
        if (pm && pm.success) paymentMethodToken = pm.paymentMethod.token;
      }

      // create subscription
      const subRequest = {
        paymentMethodToken: paymentMethodToken,
        planId: plan_id,
        // optionally pass merchantAccountId, price overrides, etc.
      };

      const subRes = await gateway.subscription.create(subRequest).catch(()=>null);

      // If subscription created and active -> proceed (Braintree may still send webhook)
      if (subRes && subRes.success) {
        // log
        await logEvent(membership_id, 'subscription_created', { plan_id, subscription: subRes.subscription });

        // If we WAIT_FOR_WEBHOOK we should not grant access yet; only return ok and let webhook finish the flow.
        if (WAIT_FOR_WEBHOOK) {
          return res.json({ ok: true, message: 'subscription_created_waiting_webhook', subscription_id: subRes.subscription.id });
        } else {
          // immediate flow: handleConfirmedPayment now
          const result = await handleConfirmedPayment({ plan_id, email, membership_id, user_name });
          return res.json({ ok: true, claim: result.claim, redirect: result.redirect });
        }
      } else {
        // subscription creation failed: return failure code
        const errorDetail = subRes ? (subRes.message || JSON.stringify(subRes)) : 'subscription_failed';
        await logEvent(membership_id, 'subscription_failed', { plan_id, error: errorDetail });
        return res.status(400).json({ error: 'subscription_failed', detail: errorDetail });
      }
    } catch(e){
      console.error('process error', e?.message || e);
      return res.status(500).json({ error: 'server_error', message: String(e?.message || e) });
    }

  } catch (e) {
    console.error('process endpoint error', e?.message || e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Legacy confirm/notify endpoints (if your frontend uses them)
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

// Braintree webhook endpoint — must be raw body
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
        // sometimes body is json with keys
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

    await logEvent(notification.timestamp || Date.now(), 'braintree_webhook', { kind: notification.kind, raw: notification });

    const kind = String(notification.kind || '').toLowerCase();

    // Handle subscription charged successfully
    if (notification.kind === braintree.WebhookNotification.Kind.SubscriptionChargedSuccessfully ||
        kind.includes('subscription_charged_successfully') || kind.includes('subscription_charged')) {
      const subscription = notification.subscription;
      const plan_id = subscription.planId || null;
      const membership_id = subscription.id || (subscription.transactions && subscription.transactions[0] && subscription.transactions[0].customFields && subscription.transactions[0].customFields.membership_id) || null;
      let email = null, user_name = null;
      try {
        // try to look up from our DB
        if (supabase && membership_id) {
          const { data } = await supabase.from('memberships').select('email,user_name').eq('membership_id', membership_id).maybeSingle();
          if (data) { email = data.email; user_name = data.user_name; }
        }
      } catch(e){}
      // Fallback: try transaction customer
      if (!email && subscription.transactions && subscription.transactions[0] && subscription.transactions[0].customer && subscription.transactions[0].customer.email) {
        email = subscription.transactions[0].customer.email;
      }
      if (email && membership_id) {
        // only confirm payment after webhook
        try {
          const result = await handleConfirmedPayment({ plan_id: (plan_id || 'plan_unknown'), email, membership_id, user_name });
          // If you want the webhook to trigger other logic (e.g. add Discord role), you can store mapping membership->claim/plan
        } catch(e){ console.error('handleConfirmedPayment error', e?.message || e); }
      } else {
        console.warn('webhook charged_successfully missing membership or email', { membership_id, email });
      }
    }

    // Transaction settled (can be used as alternate signal)
    else if (notification.kind === braintree.WebhookNotification.Kind.TransactionSettled ||
             kind.includes('transaction_settled')) {
      const transaction = notification.transaction;
      const plan_id = transaction.customFields && transaction.customFields.plan_id ? transaction.customFields.plan_id : null;
      const membership_id = transaction.customFields && transaction.customFields.membership_id ? transaction.customFields.membership_id : transaction.orderId || transaction.id;
      const email = transaction.customer && transaction.customer.email ? transaction.customer.email : null;
      const user_name = transaction.customer && transaction.customer.firstName ? (transaction.customer.firstName + (transaction.customer.lastName? ' '+transaction.customer.lastName:'')) : null;
      if (email && membership_id) {
        try {
          await handleConfirmedPayment({ plan_id: plan_id || 'plan_unknown', email, membership_id, user_name });
        } catch(e){ console.error('handleConfirmedPayment error', e?.message || e); }
      } else {
        console.warn('transaction_settled missing membership/email', { membership_id, email });
      }
    }

    // Subscription canceled/expired/failed -> remove roles
    else if (notification.kind === braintree.WebhookNotification.Kind.SubscriptionCanceled ||
             kind.includes('subscription_canceled') ||
             kind.includes('subscription_expired') ||
             kind.includes('subscription_went_past_due') ||
             kind.includes('subscription_charged_unsuccessfully') ||
             kind.includes('subscription_went_inactive')) {

      const subscription = notification.subscription || {};
      const membership_id = subscription.id || (subscription.transactions && subscription.transactions[0] && subscription.transactions[0].customFields && subscription.transactions[0].customFields.membership_id) || null;

      if (membership_id && supabase) {
        try {
          const { data } = await supabase.from('membership_links').select('discord_id').eq('membership_id', membership_id).maybeSingle();
          const discordId = data?.discord_id || null;
          if (discordId) {
            // remove all membership roles (safety)
            const rolesToRemove = [ROLE_ID_SENALES, ROLE_ID_MENTORIA, ROLE_ID_ANUAL].filter(Boolean);
            for (const r of rolesToRemove) {
              await removeDiscordRole(discordId, r);
            }
            await logEvent(membership_id, 'role_removed_via_webhook', { reason: notification.kind });
          } else {
            console.warn('no discord link for membership to remove role', membership_id);
          }
        } catch(e){ console.error('error removing role on webhook', e?.message || e); }
      } else {
        console.warn('subscription cancelled expired webhook missing membership_id or supabase');
      }
    } else {
      console.log('unhandled webhook kind', notification.kind);
    }

    return res.status(200).send('ok');
  } catch (e) { console.error('webhook handler error', e?.message || e); return res.status(500).send('server_error'); }
});

// Discord OAuth & role assignment (user-facing flow)
function requireClaim(req, res, next){
  const { claim } = req.query || {};
  if (!claim) return res.status(401).send('🔒 Enlace inválido. Abre desde tu correo o desde tu sitio.');
  try { req.claim = jwt.verify(claim, JWT_SECRET); next(); } catch (e) { return res.status(401).send('⛔ Enlace inválido o vencido.'); }
}

app.get('/discord/login', requireClaim, (req, res) => {
  const state = jwt.sign({ ts: Date.now(), membership_id: req.claim.membership_id, jti: req.claim.jti, plan_id: req.claim.plan_id }, JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URL,
    response_type: 'code',
    scope: 'identify guilds.join',
    prompt: 'consent',
    state
  });
  res.redirect('https://discord.com/api/oauth2/authorize?' + params.toString());
});

app.get('/discord/callback', async (req, res) => {
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

    const meRes = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${access_token}` }});
    if (!meRes.ok) return res.status(400).send('Error reading user');
    const me = await meRes.json();

    try {
      // join guild
      await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${me.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token })
      });
    } catch (e) { console.warn('join guild failed', e?.message || e); }

    // determine role to assign
    let roleToAssign = null;
    const planId = String(st.plan_id || '').trim();
    if (planId === PLAN_IDS.MENSUAL) { roleToAssign = ROLE_ID_SENALES; }
    else if (planId === PLAN_IDS.TRIMESTRAL) { roleToAssign = ROLE_ID_MENTORIA; }
    else if (planId === PLAN_IDS.ANUAL) { roleToAssign = ROLE_ID_ANUAL; }
    else { roleToAssign = ROLE_ID_MENTORIA; }

    if (roleToAssign) {
      try{
        await addDiscordRole(me.id, roleToAssign);
      } catch (e) { console.warn('assign role failed', e?.message || e); }
    }

    // persist link and mark claim used
    await upsertLink(st.membership_id, me.id);
    await markClaimUsed(st.jti);

    const redirectTo = DISCORD_INVITE_URL || SUCCESS_URL;
    return res.redirect(redirectTo);
  } catch (e) { console.error('callback error', e?.message || e); return res.status(500).send('OAuth error'); }
});

// Health & debug
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get('/_debug/logs', async (_req, res) => {
  try {
    if (!supabase) return res.json([]);
    const { data, error } = await supabase.from('webhook_logs').select('event_type, received_at, data').order('received_at', { ascending: false }).limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.listen(PORT, () => {
  console.log('🟢 NAZA.fx BOT running on', BASE_URL);
  console.log('WAIT_FOR_WEBHOOK =', WAIT_FOR_WEBHOOK);
  console.log('POST /api/payment/process → expects X-SHARED-SECRET and optionally payment_method_nonce');
  console.log('POST /api/braintree/webhook → public endpoint for Braintree webhooks (verifies signature)');
  console.log('Discord OAuth callback:', DISCORD_REDIRECT_URL);
});
