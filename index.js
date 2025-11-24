require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const braintree = require('braintree');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const fetch = global.fetch || require('node-fetch');

const app = express();
app.set('trust proxy', true);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
  windowMs: 30 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-SHARED-SECRET', 'x-frontend-token']
};
app.use(cors(corsOptions));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const APP_NAME = process.env.APP_NAME || 'NAZA Trading Academy';

const SHARED_SECRET = process.env.SHARED_SECRET || 'NazaFx8upexSecretKey_2024_zzu12AA';
const JWT_SECRET = process.env.JWT_SECRET || 'alexi3i020wi$$$!';
const FRONTEND_TOKEN = (typeof process.env.FRONTEND_TOKEN === 'undefined') ? 'NAZA_TEST_123' : process.env.FRONTEND_TOKEN;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE) ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } }) : null;
if (!supabase) console.warn('⚠️ SUPABASE NOT CONFIGURED');

sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');
const FROM_EMAIL = process.env.FROM_EMAIL || 'support@nazatradingacademy.com';

const BT_ENV_RAW = (process.env.BRAINTREE_ENV || 'Sandbox').toLowerCase();
const BT_ENV = (BT_ENV_RAW === 'production' || BT_ENV_RAW === 'prod') ? braintree.Environment.Production : braintree.Environment.Sandbox;
const gateway = new braintree.BraintreeGateway({
  environment: BT_ENV,
  merchantId: process.env.BRAINTREE_MERCHANT_ID || '',
  publicKey: process.env.BRAINTREE_PUBLIC_KEY || '',
  privateKey: process.env.BRAINTREE_PRIVATE_KEY || ''
});

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const GUILD_ID = process.env.GUILD_ID || '';
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL || `${BASE_URL}/discord/callback`;
const SUCCESS_URL = process.env.SUCCESS_URL || `${BASE_URL}/success`;

const ROLE_ID_SENALES = process.env.ROLE_ID_SENALESDISCORD || null;
const ROLE_ID_MENTORIA = process.env.ROLE_ID_MENTORIADISCORD || null;
const ROLE_ID_ANUAL = process.env.ROLE_ID_ANUALDISCORD || ROLE_ID_MENTORIA || null;
const DEFAULT_CHANNEL_ID = process.env.DEFAULT_CHANNEL_ID || null;

function escapeHtml(s){ if(!s) return ''; return String(s).replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]); }

async function logEvent(event_id, event_type, data){
  try{ if (supabase) await supabase.from('webhook_logs').insert({ event_id, event_type, data, processed: false }); } catch(e){ console.log('logEvent err', e?.message || e); }
}

async function markWebhookProcessed(event_id){
  try{ if (supabase) await supabase.from('webhook_logs').update({ processed: true, processed_at: new Date().toISOString() }).eq('event_id', event_id); } catch(e){ console.log('markWebhookProcessed err', e?.message || e); }
}

async function upsertLink(membership_id, discord_id, discord_username, discord_email){
  if(!membership_id || !discord_id || !supabase) return;
  try{ await supabase.from('membership_links').upsert({ membership_id, discord_id, discord_username: discord_username || null, discord_email: discord_email || null, is_active: true, updated_at: new Date().toISOString() }, { onConflict: 'membership_id' }); } catch(e){ console.log('upsertLink err', e?.message || e); }
}

async function createClaimRecord(jti, membership_id, plan_id){ 
  if(!supabase) return; 
  try{ await supabase.from('claims_issued').insert({ jti, membership_id, plan_id, expires_at: new Date(Date.now() + 24*60*60*1000).toISOString() }); } catch(e){ console.log('createClaimRecord err', e?.message || e); } 
}

async function markClaimUsed(jti, discord_id, ip){ 
  if(!supabase) return; 
  try{ await supabase.from('claims_issued').update({ used_at: new Date().toISOString(), used_by_discord_id: discord_id || null, used_from_ip: ip || null }).eq('jti', jti).is('used_at', null); } catch(e){ console.log('markClaimUsed err', e?.message || e); } 
}

async function checkClaimUsed(jti){ 
  if(!jti || !supabase) return false; 
  try{ const { data } = await supabase.from('claims_issued').select('used_at').eq('jti', jti).maybeSingle(); return !!(data?.used_at); } catch(e){ console.log('checkClaimUsed err', e?.message || e); return true; } 
}

async function logFailedAttempt({ email, card_last4, ip_address, user_agent, failure_type, error_message, plan_id, amount, raw_data }){
  if(!supabase) return;
  try{ await supabase.from('failed_attempts').insert({ email: email || null, card_last4: card_last4 || null, ip_address: ip_address || null, user_agent: user_agent || null, failure_type, error_message: error_message || null, plan_id: plan_id || null, amount: amount || null, raw_data: raw_data || null }); } catch(e){ console.log('logFailedAttempt err', e?.message || e); }
}

function buildWelcomeEmailHTML({ name, email, claim, membership_id }){
  const claimLink = `${BASE_URL}/discord/login?claim=${encodeURIComponent(claim)}`;
  const logoUrl = process.env.LOGO_URL || '';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Bienvenido</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;background:#0a0e1a;color:#e8f1ff;padding:24px;">
  <div style="max-width:640px;margin:0 auto;background:linear-gradient(180deg,#0f1428 0%,#0a0e1a 100%);padding:28px;border-radius:12px;">
    <div style="text-align:center">
      ${ logoUrl ? `<img src="${logoUrl}" alt="${APP_NAME}" style="width:96px;height:96px;border-radius:50%;margin-bottom:12px;">` : '' }
      <h1 style="color:#00ffff;margin:0 0 12px;">¡Bienvenido a ${APP_NAME}!</h1>
    </div>
    <p>Hola <strong>${escapeHtml(name)}</strong>,</p>
    <p>Tu pago fue procesado correctamente. Haz clic en el botón para acceder a Discord:</p>
    <p style="text-align:center"><a href="${claimLink}" style="display:inline-block;padding:12px 28px;background:#00ffff;color:#05121a;border-radius:10px;text-decoration:none;font-weight:700;">Acceder a Discord</a></p>
    <p style="font-size:12px;color:#8a9ab8;text-align:center;">Este enlace expira en 24 horas y es de un solo uso.</p>
    <hr style="border:none;border-top:1px solid rgba(255,255,255,0.03);margin:18px 0;">
    <p style="font-size:13px;color:#b7c9e8;">ID de membresía: ${escapeHtml(membership_id)}<br>Email: ${escapeHtml(email)}</p>
    <p style="font-size:12px;color:#778aa3;text-align:center;margin-top:18px;">© ${new Date().getFullYear()} ${APP_NAME}</p>
  </div>
</body>
</html>`;
}

async function handleConfirmedPayment({ plan_id, email, membership_id, user_name }){
  try{
    const jti = crypto.randomUUID();
    const payload = { membership_id, plan_id, user_name, jti };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h', jwtid: jti });

    await logEvent(membership_id || jti, 'payment_confirmed', { plan_id, email, membership_id, user_name });
    await createClaimRecord(jti, membership_id, plan_id);

    (async ()=>{
      try{
        const html = buildWelcomeEmailHTML({ name: user_name, email, claim: token, membership_id });
        await sgMail.send({ to: email, from: FROM_EMAIL, subject: `¡Bienvenido a ${APP_NAME}! 🚀`, html });
        console.log('📧 Email enviado a', email);
      }catch(e){ console.error('sendgrid error', e?.message || e); }
    })();

    return { claim: token, redirect: `${BASE_URL}/discord/login?claim=${encodeURIComponent(token)}` };
  } catch(e){
    console.error('handleConfirmedPayment error', e?.message || e);
    throw e;
  }
}

async function addDiscordRole(discordId, roleId){
  if(!discordId || !roleId || !GUILD_ID || !DISCORD_BOT_TOKEN) return;
  try{
    await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}/roles/${roleId}`, {
      method: 'PUT',
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
    });
  }catch(e){ console.log('addDiscordRole err', e?.message || e); }
}

async function removeDiscordRole(discordId, roleId){
  if(!discordId || !roleId || !GUILD_ID || !DISCORD_BOT_TOKEN) return;
  try{
    await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}/roles/${roleId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
    });
  }catch(e){ console.log('removeDiscordRole err', e?.message || e); }
}

function roleForPlan(planId){
  if (!planId) return null;
  if (planId === 'plan_mensual') return ROLE_ID_SENALES;
  if (planId === 'plan_trimestral') return ROLE_ID_MENTORIA;
  if (planId === 'plan_anual') return ROLE_ID_ANUAL;
  return ROLE_ID_MENTORIA;
}

async function sendChannelMessage(channelId, message) {
  if (!channelId || !DISCORD_BOT_TOKEN) return;
  try {
    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content: message })
    });
  } catch (err) {
    console.error('sendChannelMessage err', err?.message || err);
  }
}

// ============================================
// ENDPOINT: Braintree Webhook (ÚNICO QUE PROCESA PAGOS)
// ============================================
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
    try {
      notification = await gateway.webhookNotification.parse(bt_signature, bt_payload);
    } catch (e) {
      console.error('webhook parse error', e?.message || e);
      return res.status(400).send('invalid_webhook');
    }

    const event_id = notification.timestamp || Date.now();
    await logEvent(event_id, 'braintree_webhook', { kind: notification.kind, raw: notification });

    const kind = String(notification.kind || '').toLowerCase();

    // Suscripción exitosa
    if (notification.kind === braintree.WebhookNotification.Kind.SubscriptionChargedSuccessfully || kind.includes('subscription_charged_successfully') || kind.includes('subscription_charged')) {
      const subscription = notification.subscription;
      const plan_id = subscription.planId || null;
      const braintree_subscription_id = subscription.id;
      
      // Obtener info del cliente desde la transacción
      const transactions = subscription.transactions || [];
      const lastTransaction = transactions[0] || {};
      const email = lastTransaction.customer?.email || null;
      const user_name = lastTransaction.customer?.firstName || null;
      const card_last4 = lastTransaction.creditCard?.last4 || null;
      const card_type = lastTransaction.creditCard?.cardType || null;

      // Generar membership_id
      const membership_id = 'NAZA_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);

      console.log('✅ Webhook recibido: Pago exitoso');
      console.log('📧 Email:', email);
      console.log('👤 Usuario:', user_name);
      console.log('📦 Plan:', plan_id);

      if (email && supabase) {
        // Guardar en Supabase
        await supabase.from('memberships').insert({
          membership_id,
          email,
          user_name: user_name || null,
          plan_id,
          braintree_subscription_id,
          braintree_customer_id: lastTransaction.customer?.id || null,
          card_last4,
          card_type,
          status: 'active',
          activated_at: new Date().toISOString(),
          created_at: new Date().toISOString()
        });

        console.log('💾 Guardado en Supabase');

        // Enviar email con claim
        await handleConfirmedPayment({ plan_id, email, membership_id, user_name });

        await markWebhookProcessed(event_id);
      } else {
        await logEvent(event_id, 'webhook_missing_email', { subscription: notification.subscription });
      }
    }

    // Suscripción cancelada
    else if (notification.kind === braintree.WebhookNotification.Kind.SubscriptionCanceled || kind.includes('subscription_canceled') || kind.includes('subscription_expired')) {
      const subscription = notification.subscription || {};
      const braintree_subscription_id = subscription.id;

      if (braintree_subscription_id && supabase) {
        await supabase.from('memberships').update({ status: kind.includes('canceled') ? 'canceled' : 'expired', canceled_at: new Date().toISOString() }).eq('braintree_subscription_id', braintree_subscription_id);

        const { data: membership } = await supabase.from('memberships').select('membership_id').eq('braintree_subscription_id', braintree_subscription_id).maybeSingle();

        if (membership) {
          const { data: link } = await supabase.from('membership_links').select('discord_id').eq('membership_id', membership.membership_id).maybeSingle();
          const discordId = link?.discord_id || null;

          if (discordId) {
            const rolesToRemove = [ROLE_ID_SENALES, ROLE_ID_MENTORIA, ROLE_ID_ANUAL].filter(Boolean);
            for (const r of rolesToRemove) await removeDiscordRole(discordId, r);
            await logEvent(membership.membership_id, 'role_removed_via_webhook', { reason: notification.kind });
          }
        }

        await markWebhookProcessed(event_id);
      }
    }

    return res.status(200).send('ok');
  } catch (e) { 
    console.error('webhook error', e?.message || e); 
    return res.status(500).send('server_error'); 
  }
});

// ============================================
// Discord OAuth
// ============================================
function requireClaim(req, res, next){
  const { claim } = req.query || {};
  if (!claim) return res.status(401).send('🔒 Enlace inválido');
  try { req.claim = jwt.verify(claim, JWT_SECRET); next(); } catch (e) { return res.status(401).send('⛔ Enlace vencido'); }
}

app.get('/discord/login', requireClaim, (req, res) => {
  const state = jwt.sign({ ts: Date.now(), membership_id: req.claim.membership_id, jti: req.claim.jti, plan_id: req.claim.plan_id }, JWT_SECRET, { expiresIn: '10m' });
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

    if (await checkClaimUsed(st.jti)) return res.status(409).send('⛔ Enlace ya usado');

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
    } catch (e) {}

    const planId = String(st.plan_id || '').trim();
    const roleToAssign = roleForPlan(planId);

    if (roleToAssign) {
      try{ await addDiscordRole(me.id, roleToAssign); } catch (e) {}
    }

    await upsertLink(st.membership_id, me.id, me.username, me.email);
    await markClaimUsed(st.jti, me.id, ip_address);

    return res.redirect(SUCCESS_URL);
  } catch (e) { 
    console.error('callback error', e?.message || e); 
    return res.status(500).send('OAuth error'); 
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString(), version: '3.0 - Webhook Only' }));

app.listen(PORT, () => {
  console.log('🟢 NAZA.fx BOT v3.0 - WEBHOOK ONLY');
  console.log('📍 URL:', BASE_URL);
  console.log('📊 Supabase:', supabase ? 'CONNECTED' : 'NOT CONFIGURED');
  console.log('💳 Braintree:', BT_ENV === braintree.Environment.Production ? 'PRODUCTION' : 'SANDBOX');
  console.log('✅ Solo procesa WEBHOOKS de Braintree');
});
