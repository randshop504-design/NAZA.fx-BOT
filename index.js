// index.js — NAZA.fx BOT (final, Node 18, fetch nativo, SendGrid, Supabase)
// + Braintree webhook + confirm endpoint (modificado)

require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const braintree = require('braintree');

const app = express();
// We'll use raw for webhook route separately; default json for others
app.use(express.json()); // JSON bodies

/* ================== REQUIRED ENV (use exact names) ==================
APP_BASE_URL
SHARED_SECRET
JWT_SECRET
SUPABASE_URL
SUPABASE_SERVICE_ROLE
SENDGRID_API_KEY
FROM_EMAIL
SUPPORT_EMAIL
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
DISCORD_BOT_TOKEN
GUILD_ID
DISCORD_REDIRECT_URL (optional, default BASE_URL/discord/callback)
DISCORD_INVITE_URL (fallback redirect)
ROLE_ID_SENALESDISCORD
ROLE_ID_MENTORIADISCORD
LOGO_URL (optional)
FOOTER_IMAGE_URL (optional)
BT_MERCHANT_ID
BT_PUBLIC_KEY
BT_PRIVATE_KEY
BT_ENVIRONMENT (Sandbox|Production) - optional
================================================================== */

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const APP_NAME = process.env.APP_NAME || 'NAZA Trading Academy';

const SHARED_SECRET = process.env.SHARED_SECRET || 'NazaFxSuperSecretKey_2024_zzQ12AA';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-jwt-secret';

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });

// SendGrid
if (!process.env.SENDGRID_API_KEY) console.warn('⚠️ SENDGRID_API_KEY not set');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || `no-reply@nazatradingacademy.com`;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@nazatradingacademy.com';

// Braintree gateway (for verifying webhooks)
const BT_ENV = (process.env.BT_ENVIRONMENT && process.env.BT_ENVIRONMENT.toLowerCase()==='production') ? braintree.Environment.Production : braintree.Environment.Sandbox;
const gateway = braintree.connect({
  environment: BT_ENV,
  merchantId: process.env.BT_MERCHANT_ID || '',
  publicKey: process.env.BT_PUBLIC_KEY || '',
  privateKey: process.env.BT_PRIVATE_KEY || ''
});

// Discord / roles / redirects
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL || `${BASE_URL}/discord/callback`;
const DISCORD_INVITE_URL = process.env.DISCORD_INVITE_URL || null;
const SUCCESS_URL = process.env.SUCCESS_URL || `${BASE_URL}/success`;

const ROLE_ID_SENALES = process.env.ROLE_ID_SENALESDISCORD;
const ROLE_ID_MENTORIA = process.env.ROLE_ID_MENTORIADISCORD;
const ROLE_ID_ANUAL = process.env.ROLE_ID_ANUALDISCORD || ROLE_ID_MENTORIA;

// Assets
const LOGO_URL = process.env.LOGO_URL || '';
const FOOTER_IMAGE_URL = process.env.FOOTER_IMAGE_URL || '';
const DISCORD_DOWNLOAD_URL = process.env.DISCORD_DOWNLOAD_URL || 'https://discord.com/download';
const DISCORD_TUTORIAL_URL = process.env.DISCORD_TUTORIAL_URL || 'https://youtu.be/_51EAeKtTs0';

/* ================== Helpers ================== */
function escapeHtml(s){ if(!s) return ''; return String(s).replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]); }

async function logEvent(event_id, event_type, data){
  try{ await supabase.from('webhook_logs').insert({ event_id, event_type, data }); }
  catch(e){ console.log('logEvent error', e?.message || e); }
}
async function getLink(membership_id){
  if(!membership_id) return null;
  const { data } = await supabase.from('membership_links').select('membership_id,discord_id').eq('membership_id', membership_id).maybeSingle();
  return data || null;
}
async function upsertLink(membership_id, discord_id){
  if(!membership_id || !discord_id) return;
  try{ await supabase.from('membership_links').upsert({ membership_id, discord_id }, { onConflict: 'membership_id' }); }
  catch(e){ console.log('upsertLink error', e?.message || e); }
}
async function createClaimRecord(jti, membership_id){
  try{ await supabase.from('claims_issued').insert({ jti, membership_id }); } catch(e){ /* ignore dupes */ }
}
async function markClaimUsed(jti){
  try{ await supabase.from('claims_issued').update({ used_at: new Date().toISOString() }).eq('jti', jti).is('used_at', null); } catch(e){ console.log('markClaimUsed error', e?.message || e); }
}
async function checkClaimUsed(jti){
  if(!jti) return true;
  const { data } = await supabase.from('claims_issued').select('used_at').eq('jti', jti).maybeSingle();
  return !!(data?.used_at);
}

/* ================== Email builder (SendGrid) ================== */
function buildWelcomeEmailHTML({ name, email, claim, membership_id }){
  const claimLink = `${BASE_URL}/discord/login?claim=${encodeURIComponent(claim)}`;
  return `
  <div style="background:#071022;padding:24px;color:#e6eef8;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto">
      <tr><td align="center" style="padding:18px 0">
        ${LOGO_URL ? `<img src="${LOGO_URL}" alt="NAZA Trading Academy" style="width:120px;border-radius:8px;display:block;margin-bottom:12px">` : ''}
        <h1 style="margin:6px 0 0;font-size:26px;color:#fff">NAZA Trading Academy</h1>
        <p style="margin:8px 0 0;color:#bfc9d6">Bienvenido${name? ' ' + escapeHtml(name):''} — gracias por unirte a NAZA Trading Academy.</p>
      </td></tr>

      <tr><td align="center" style="padding:18px 16px">
        <p style="color:#d6dbe6;margin-bottom:12px">Para acceder a tus beneficios descarga Discord:</p>
        <a href="${DISCORD_DOWNLOAD_URL}" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#4b6bff;color:#fff;text-decoration:none;margin:6px">⬇️ Descargar Discord</a>
        <a href="${DISCORD_TUTORIAL_URL}" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#1f2633;color:#fff;text-decoration:none;margin:6px">▶️ Cómo crear tu cuenta (ES)</a>
      </td></tr>

      <tr><td align="center" style="padding:18px 16px">
        <p style="color:#d6dbe6;margin-bottom:10px">Acceso a Discord:</p>
        <a href="${claimLink}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#18a957;color:#fff;text-decoration:none;font-weight:700">Acceder al servidor</a>
        <div style="color:#98a3b4;font-size:12px;margin-top:8px">Enlace de un solo uso, expira en 24 horas.</div>
      </td></tr>

      <tr><td style="padding:18px 24px;color:#9fb6a3;font-size:13px">
        <p style="margin:6px 0">Soporte: <a href="mailto:${SUPPORT_EMAIL}" style="color:#cdebd8">${SUPPORT_EMAIL}</a></p>
        <p style="margin:6px 0">Sitio oficial: <a href="https://nazatradingacademy.com" style="color:#cdebd8">nazatradingacademy.com</a></p>
      </td></tr>

      ${FOOTER_IMAGE_URL ? `<tr><td align="center"><img src="${FOOTER_IMAGE_URL}" alt="" style="width:100%;display:block;margin-top:8px;border-radius:8px"></td></tr>` : ''}
    </table>
  </div>`;
}

/* ================== Central handler for confirmed payments ================== */
async function handleConfirmedPayment({ plan_id, email, membership_id, user_name }){
  const jti = crypto.randomUUID();
  const payload = { membership_id, plan_id, user_name, jti };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h', jwtid: jti });

  await logEvent(membership_id || jti, 'payment_confirmed', { plan_id, email, membership_id, user_name });
  await createClaimRecord(jti, membership_id);

  // send email (non-blocking)
  (async ()=>{
    try{
      const html = buildWelcomeEmailHTML({ name: user_name, email, claim: token, membership_id });
      await sgMail.send({ to: email, from: FROM_EMAIL, subject: `${APP_NAME} — Acceso y pasos (Discord)`, html });
      console.log('📧 Welcome email sent to', email);
    }catch(e){ console.error('sendgrid error', e?.message || e); }
  })();

  return { claim: token, redirect: `${BASE_URL}/discord/login?claim=${encodeURIComponent(token)}` };
}

/* ================== Endpoint: POST /api/payment/notify (existing) ================== */
app.post('/api/payment/notify', async (req, res) => {
  try {
    const secret = req.get('X-SHARED-SECRET') || '';
    if (!secret || secret !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });

    const { plan_id, email, membership_id, user_name } = req.body || {};
    if (!plan_id || !email || !membership_id) return res.status(400).json({ error: 'missing_fields' });

    // create claim + email via central handler
    const result = await handleConfirmedPayment({ plan_id, email, membership_id, user_name });
    return res.json({ ok: true, claim: result.claim, redirect: result.redirect });
  } catch (e) {
    console.error('notify error', e?.message || e);
    return res.status(500).json({ error: 'server_error' });
  }
});

/* ================== New helper endpoint: site can POST here after processing payment =============
   POST /api/payment/confirm
   Headers: X-SHARED-SECRET
   Body: { plan_id, email, membership_id, user_name }
   (This is an alias that does same as /api/payment/notify; added for clarity)
============================================================================================= */
app.post('/api/payment/confirm', async (req, res) => {
  // same implementation as notify - keep both for compatibility
  try {
    const secret = req.get('X-SHARED-SECRET') || '';
    if (!secret || secret !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });

    const { plan_id, email, membership_id, user_name } = req.body || {};
    if (!plan_id || !email || !membership_id) return res.status(400).json({ error: 'missing_fields' });

    const result = await handleConfirmedPayment({ plan_id, email, membership_id, user_name });
    return res.json({ ok: true, claim: result.claim, redirect: result.redirect });
  } catch (e) {
    console.error('confirm error', e?.message || e);
    return res.status(500).json({ error: 'server_error' });
  }
});

/* ================== Braintree webhook endpoint ==================
   POST /api/braintree/webhook
   Braintree sends bt_signature and bt_payload in body or form-encoded
   We verify using gateway.webhookNotification.parse(signature, payload)
================================================================== */
app.post('/api/braintree/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    // Braintree often posts form-encoded bt_signature & bt_payload
    const bodyStr = req.body.toString('utf8');
    // try to extract bt_signature & bt_payload either from raw body or as urlencoded
    let bt_signature = '', bt_payload = '';
    const params = new URLSearchParams(bodyStr);
    if (params.has('bt_signature') && params.has('bt_payload')) {
      bt_signature = params.get('bt_signature');
      bt_payload = params.get('bt_payload');
    } else {
      // fallback: parse raw as JSON if any
      try {
        const parsed = JSON.parse(bodyStr);
        bt_signature = parsed.bt_signature || parsed.signature || '';
        bt_payload = parsed.bt_payload || parsed.payload || '';
      } catch(e){}
    }
    if(!bt_signature || !bt_payload) {
      // nothing to verify; respond 400
      console.warn('braintree webhook missing signature/payload');
      return res.status(400).send('missing_signature_or_payload');
    }

    let notification;
    try {
      notification = await gateway.webhookNotification.parse(bt_signature, bt_payload);
    } catch (e) {
      console.error('braintree parse error', e?.message || e);
      return res.status(400).send('invalid_webhook');
    }

    // Log event
    await logEvent(notification.timestamp || Date.now(), 'braintree_webhook', { kind: notification.kind, raw: notification });

    // Handle relevant kinds
    if (notification.kind === braintree.WebhookNotification.Kind.SubscriptionChargedSuccessfully ||
        notification.kind === 'subscription_charged_successfully') {
      const subscription = notification.subscription;
      // subscription.transactions may contain transactions; we can take first transaction's id or subscription.id
      const plan_id = subscription.planId || null;
      // You must map subscription.customer or custom fields to membership_id/email in your DB - simplistic approach:
      // If your subscription has transactions and contains customer details, extract them.
      const membership_id = subscription.id || null;
      // NOTE: if you need customer email you must attach it in your site's DB and call /api/payment/notify to the bot instead.
      // For robustness: we just log and ack.
      console.log('subscription charged', subscription.id, 'plan', plan_id);
      // If you have mapping for membership_id->email in Supabase, fetch it and then call handleConfirmedPayment
      // Example: try to look up in membership_links or another table
      // Attempt to find membership record
      let email = null, user_name = null;
      try {
        const { data } = await supabase.from('memberships').select('email,user_name').eq('membership_id', subscription.id).maybeSingle();
        if (data) { email = data.email; user_name = data.user_name; }
      } catch(e){ /* ignore */ }

      if (email && subscription.id) {
        await handleConfirmedPayment({ plan_id: (plan_id || 'plan_unknown'), email, membership_id: subscription.id, user_name });
      }
    } else if (notification.kind === braintree.WebhookNotification.Kind.TransactionSettled ||
               notification.kind === 'transaction_settled') {
      const transaction = notification.transaction;
      // transaction.customFields may include membership_id/email if your site set them when creating transaction
      const plan_id = transaction.customFields && transaction.customFields.plan_id ? transaction.customFields.plan_id : (transaction.additionalProcessorResponse || null);
      const membership_id = transaction.customFields && transaction.customFields.membership_id ? transaction.customFields.membership_id : transaction.orderId || transaction.id;
      const email = transaction.customer && transaction.customer.email ? transaction.customer.email : null;
      const user_name = transaction.customer && transaction.customer.firstName ? (transaction.customer.firstName + (transaction.customer.lastName? ' '+transaction.customer.lastName:'')) : null;

      if (email && membership_id) {
        await handleConfirmedPayment({ plan_id: plan_id || 'plan_unknown', email, membership_id, user_name });
      }
    } else {
      // other event kinds: just log
      console.log('braintree webhook kind', notification.kind);
    }

    return res.status(200).send('ok');
  } catch (e) {
    console.error('webhook handler error', e?.message || e);
    return res.status(500).send('server_error');
  }
});

/* ================== Middleware / OAuth start ================== */
function requireClaim(req, res, next){
  const { claim } = req.query || {};
  if (!claim) return res.status(401).send('🔒 Enlace inválido. Abre desde tu correo o desde tu sitio.');
  try {
    req.claim = jwt.verify(claim, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).send('⛔ Enlace inválido o vencido.');
  }
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

/* ================== OAuth callback ================== */
app.get('/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('missing_code_or_state');

    const st = jwt.verify(state, JWT_SECRET);
    if (await checkClaimUsed(st.jti)) return res.status(409).send('⛔ Este enlace ya fue usado.');

    // token exchange
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
    if (!tRes.ok) return res.status(400).send('Error obtaining token');
    const tJson = await tRes.json();
    const access_token = tJson.access_token;

    // get user
    const meRes = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${access_token}` }});
    if (!meRes.ok) return res.status(400).send('Error reading user');
    const me = await meRes.json();

    // join guild (best-effort)
    try {
      await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${me.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token })
      });
    } catch (e) { console.warn('join guild failed', e?.message || e); }

    // determine role based on exact plan_id values
    let roleToAssign = null;
    const planId = String(st.plan_id || '').trim();

    if (planId === 'plan_mensual') {
      roleToAssign = ROLE_ID_SENALES;
    } else if (planId === 'plan_trimestral' || planId === 'plan_anual') {
      roleToAssign = ROLE_ID_MENTORIA;
    } else {
      roleToAssign = ROLE_ID_MENTORIA; // default fallback
    }

    if (roleToAssign) {
      try{
        await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${me.id}/roles/${roleToAssign}`, {
          method: 'PUT', headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
        });
      } catch (e) { console.warn('assign role failed', e?.message || e); }
    }

    // persist link and mark claim used
    await upsertLink(st.membership_id, me.id);
    await markClaimUsed(st.jti);

    // redirect final (invite or success)
    const redirectTo = DISCORD_INVITE_URL || SUCCESS_URL;
    return res.redirect(redirectTo);
  } catch (e) {
    console.error('callback error', e?.message || e);
    return res.status(500).send('OAuth error');
  }
});

/* ================== Debug / health ================== */
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get('/_debug/logs', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('webhook_logs').select('event_type, received_at').order('received_at', { ascending: false }).limit(30);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

/* ================== Start server ================== */
app.listen(PORT, () => {
  console.log('🟢 NAZA.fx BOT running on', BASE_URL);
  console.log('POST /api/payment/notify → expects X-SHARED-SECRET');
  console.log('POST /api/payment/confirm → expects X-SHARED-SECRET');
  console.log('POST /api/braintree/webhook → public endpoint for Braintree webhooks (verifies signature)');
  console.log('Discord OAuth callback:', DISCORD_REDIRECT_URL);
});
