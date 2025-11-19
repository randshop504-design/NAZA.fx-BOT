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
app.use(express.json()); // JSON bodies

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

// Helpers
function escapeHtml(s){ if(!s) return ''; return String(s).replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]); }
async function logEvent(event_id, event_type, data){ try{ await supabase.from('webhook_logs').insert({ event_id, event_type, data }); } catch(e){ console.log('logEvent error', e?.message || e); } }
async function upsertLink(membership_id, discord_id){ if(!membership_id || !discord_id) return; try{ await supabase.from('membership_links').upsert({ membership_id, discord_id }, { onConflict: 'membership_id' }); } catch(e){ console.log('upsertLink error', e?.message || e); } }
async function createClaimRecord(jti, membership_id){ try{ await supabase.from('claims_issued').insert({ jti, membership_id }); } catch(e){} }
async function markClaimUsed(jti){ try{ await supabase.from('claims_issued').update({ used_at: new Date().toISOString() }).eq('jti', jti).is('used_at', null); } catch(e){ console.log('markClaimUsed error', e?.message || e); } }
async function checkClaimUsed(jti){ if(!jti) return true; const { data } = await supabase.from('claims_issued').select('used_at').eq('jti', jti).maybeSingle(); return !!(data?.used_at); }

// Email builder
function buildWelcomeEmailHTML({ name, email, claim, membership_id }){
  const claimLink = `${BASE_URL}/discord/login?claim=${encodeURIComponent(claim)}`;
  return `
  <div style="background:#071022;padding:24px;color:#e6eef8;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto">
      <tr><td align="center" style="padding:18px 0">
        ${process.env.LOGO_URL ? `<img src="${process.env.LOGO_URL}" alt="NAZA Trading Academy" style="width:120px;border-radius:8px;display:block;margin-bottom:12px">` : ''}
        <h1 style="margin:6px 0 0;font-size:26px;color:#fff">NAZA Trading Academy</h1>
        <p style="margin:8px 0 0;color:#bfc9d6">Bienvenido${name? ' ' + escapeHtml(name):''} — gracias por unirte a NAZA Trading Academy.</p>
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

// central handler
async function handleConfirmedPayment({ plan_id, email, membership_id, user_name }){
  const jti = crypto.randomUUID();
  const payload = { membership_id, plan_id, user_name, jti };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h', jwtid: jti });

  await logEvent(membership_id || jti, 'payment_confirmed', { plan_id, email, membership_id, user_name });
  await createClaimRecord(jti, membership_id);

  (async ()=>{
    try{
      const html = buildWelcomeEmailHTML({ name: user_name, email, claim: token, membership_id });
      await sgMail.send({ to: email, from: FROM_EMAIL, subject: `${APP_NAME} — Acceso y pasos (Discord)`, html });
      console.log('📧 Welcome email sent to', email);
    }catch(e){ console.error('sendgrid error', e?.message || e); }
  })();

  return { claim: token, redirect: `${BASE_URL}/discord/login?claim=${encodeURIComponent(token)}` };
}

// endpoints
app.post('/api/payment/notify', async (req, res) => {
  try {
    const secret = req.get('X-SHARED-SECRET') || '';
    if (!secret || secret !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });
    const { plan_id, email, membership_id, user_name } = req.body || {};
    if (!plan_id || !email || !membership_id) return res.status(400).json({ error: 'missing_fields' });
    const result = await handleConfirmedPayment({ plan_id, email, membership_id, user_name });
    return res.json({ ok: true, claim: result.claim, redirect: result.redirect });
  } catch (e) { console.error('notify error', e?.message || e); return res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/payment/confirm', async (req, res) => {
  try {
    const secret = req.get('X-SHARED-SECRET') || '';
    if (!secret || secret !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });
    const { plan_id, email, membership_id, user_name } = req.body || {};
    if (!plan_id || !email || !membership_id) return res.status(400).json({ error: 'missing_fields' });
    const result = await handleConfirmedPayment({ plan_id, email, membership_id, user_name });
    return res.json({ ok: true, claim: result.claim, redirect: result.redirect });
  } catch (e) { console.error('confirm error', e?.message || e); return res.status(500).json({ error: 'server_error' }); }
});

// braintree webhook
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

    if(!bt_signature || !bt_payload) return res.status(400).send('missing_signature_or_payload');

    let notification;
    try { notification = await gateway.webhookNotification.parse(bt_signature, bt_payload); }
    catch (e) { console.error('braintree parse error', e?.message || e); return res.status(400).send('invalid_webhook'); }

    await logEvent(notification.timestamp || Date.now(), 'braintree_webhook', { kind: notification.kind, raw: notification });

    if (notification.kind === braintree.WebhookNotification.Kind.SubscriptionChargedSuccessfully ||
        notification.kind === 'subscription_charged_successfully') {
      const subscription = notification.subscription;
      const plan_id = subscription.planId || null;
      const membership_id = subscription.id || null;
      let email = null, user_name = null;
      try {
        const { data } = await supabase.from('memberships').select('email,user_name').eq('membership_id', subscription.id).maybeSingle();
        if (data) { email = data.email; user_name = data.user_name; }
      } catch(e){}
      if (email && subscription.id) { await handleConfirmedPayment({ plan_id: (plan_id || 'plan_unknown'), email, membership_id: subscription.id, user_name }); }
    } else if (notification.kind === braintree.WebhookNotification.Kind.TransactionSettled ||
               notification.kind === 'transaction_settled') {
      const transaction = notification.transaction;
      const plan_id = transaction.customFields && transaction.customFields.plan_id ? transaction.customFields.plan_id : null;
      const membership_id = transaction.customFields && transaction.customFields.membership_id ? transaction.customFields.membership_id : transaction.orderId || transaction.id;
      const email = transaction.customer && transaction.customer.email ? transaction.customer.email : null;
      const user_name = transaction.customer && transaction.customer.firstName ? (transaction.customer.firstName + (transaction.customer.lastName? ' '+transaction.customer.lastName:'')) : null;
      if (email && membership_id) { await handleConfirmedPayment({ plan_id: plan_id || 'plan_unknown', email, membership_id, user_name }); }
    } else {
      console.log('braintree webhook kind', notification.kind);
    }

    return res.status(200).send('ok');
  } catch (e) { console.error('webhook handler error', e?.message || e); return res.status(500).send('server_error'); }
});

// OAuth & role assignment
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
    if (!tRes.ok) return res.status(400).send('Error obtaining token');
    const tJson = await tRes.json();
    const access_token = tJson.access_token;

    const meRes = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${access_token}` }});
    if (!meRes.ok) return res.status(400).send('Error reading user');
    const me = await meRes.json();

    try {
      await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${me.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token })
      });
    } catch (e) { console.warn('join guild failed', e?.message || e); }

    let roleToAssign = null;
    const planId = String(st.plan_id || '').trim();

    if (planId === 'plan_mensual') { roleToAssign = ROLE_ID_SENALES; }
    else if (planId === 'plan_trimestral' || planId === 'plan_anual') { roleToAssign = ROLE_ID_MENTORIA; }
    else { roleToAssign = ROLE_ID_MENTORIA; }

    if (roleToAssign) {
      try{
        await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${me.id}/roles/${roleToAssign}`, {
          method: 'PUT', headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
        });
      } catch (e) { console.warn('assign role failed', e?.message || e); }
    }

    await upsertLink(st.membership_id, me.id);
    await markClaimUsed(st.jti);

    const redirectTo = DISCORD_INVITE_URL || SUCCESS_URL;
    return res.redirect(redirectTo);
  } catch (e) { console.error('callback error', e?.message || e); return res.status(500).send('OAuth error'); }
});

// health
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get('/_debug/logs', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('webhook_logs').select('event_type, received_at').order('received_at', { ascending: false }).limit(30);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.listen(PORT, () => {
  console.log('🟢 NAZA.fx BOT running on', BASE_URL);
  console.log('POST /api/payment/notify → expects X-SHARED-SECRET');
  console.log('POST /api/payment/confirm → expects X-SHARED-SECRET');
  console.log('POST /api/braintree/webhook → public endpoint for Braintree webhooks (verifies signature)');
  console.log('Discord OAuth callback:', DISCORD_REDIRECT_URL);
});
