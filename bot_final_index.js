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
const WAIT_FOR_WEBHOOK = (process.env.WAIT_FOR_WEBHOOK || 'true').toLowerCase() === 'true';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE) ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } }) : null;
if (!supabase) console.warn('⚠️ SUPABASE NOT CONFIGURED');

sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');
const FROM_EMAIL = process.env.FROM_EMAIL || 'support@nazatradingacademy.com';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@nazatradingacademy.com';

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
const DISCORD_INVITE_URL = process.env.DISCORD_INVITE_URL || null;
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

async function checkAndRegisterCard({ card_fingerprint, card_last4, card_type, membership_id }){
  if(!supabase || !card_fingerprint) return { is_suspicious: false, usage_count: 1 };

  try{
    const { data: existing } = await supabase.from('card_fingerprints').select('*').eq('card_fingerprint', card_fingerprint).maybeSingle();

    if (existing) {
      const already_linked = (existing.membership_ids || []).includes(membership_id);

      if (already_linked) {
        await supabase.from('card_fingerprints').update({ last_seen_at: new Date().toISOString() }).eq('card_fingerprint', card_fingerprint);
        return { is_suspicious: false, usage_count: existing.usage_count, is_renewal: true };
      }

      const new_count = (existing.usage_count || 1) + 1;
      const new_memberships = [...(existing.membership_ids || []), membership_id];

      await supabase.from('card_fingerprints').update({
        usage_count: new_count,
        membership_ids: new_memberships,
        last_seen_at: new Date().toISOString(),
        is_flagged: new_count > 2,
        flag_reason: new_count > 2 ? `used_in_${new_count}_accounts` : null
      }).eq('card_fingerprint', card_fingerprint);

      return { is_suspicious: new_count > 3, usage_count: new_count, is_renewal: false };
    } else {
      await supabase.from('card_fingerprints').insert({ card_fingerprint, card_last4, card_type, usage_count: 1, membership_ids: [membership_id] });
      return { is_suspicious: false, usage_count: 1, is_renewal: false };
    }
  } catch(e){
    console.log('checkAndRegisterCard error', e?.message || e);
    return { is_suspicious: false, usage_count: 1 };
  }
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
// NUEVO ENDPOINT: /api/frontend/confirm
// ============================================
app.post('/api/frontend/confirm', async (req, res) => {
  const ip_address = req.ip || req.connection.remoteAddress;
  const user_agent = req.get('user-agent') || '';

  try {
    // Validar origen
    const origin = req.get('Origin') || req.get('origin') || '';
    if (ALLOWED_ORIGINS.length > 0 && origin && !ALLOWED_ORIGINS.includes(origin)) {
      await logFailedAttempt({ ip_address, user_agent, failure_type: 'origin_not_allowed', error_message: `Origin: ${origin}` });
      return res.status(403).json({ error: 'origin_not_allowed' });
    }

    // Validar FRONTEND_TOKEN
    if (FRONTEND_TOKEN) {
      const sent = req.get('x-frontend-token') || req.body?.frontend_token || '';
      if (!sent || sent !== FRONTEND_TOKEN) {
        await logFailedAttempt({ ip_address, user_agent, failure_type: 'invalid_frontend_token' });
        return res.status(401).json({ error: 'invalid_frontend_token' });
      }
    }

    const { payment_method_nonce, plan_id, product_name, email, user_name, membership_id } = req.body || {};

    if (!payment_method_nonce || !plan_id || !email || !membership_id) {
      await logFailedAttempt({ email, ip_address, user_agent, failure_type: 'missing_fields' });
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    console.log('💳 Procesando pago con Braintree para:', email);

    // Crear cliente en Braintree
    const customerResult = await gateway.customer.create({
      email,
      firstName: user_name || 'Cliente',
      paymentMethodNonce: payment_method_nonce
    });

    if (!customerResult.success) {
      console.error('❌ Error creando cliente:', customerResult.message);
      await logFailedAttempt({ email, ip_address, user_agent, failure_type: 'braintree_customer_error', error_message: customerResult.message });
      return res.status(400).json({ error: 'customer_creation_failed', message: customerResult.message });
    }

    const customerId = customerResult.customer.id;
    const paymentMethodToken = customerResult.customer.paymentMethods[0].token;

    console.log('✅ Cliente creado:', customerId);

    // Crear suscripción
    const subscriptionResult = await gateway.subscription.create({
      paymentMethodToken,
      planId: plan_id
    });

    if (!subscriptionResult.success) {
      console.error('❌ Error creando suscripción:', subscriptionResult.message);
      await logFailedAttempt({ email, ip_address, user_agent, failure_type: 'braintree_subscription_error', error_message: subscriptionResult.message });
      return res.status(400).json({ error: 'subscription_creation_failed', message: subscriptionResult.message });
    }

    const subscriptionId = subscriptionResult.subscription.id;
    console.log('✅ Suscripción creada:', subscriptionId);

    // Guardar en base de datos
    if (supabase) {
      await supabase.from('memberships').upsert({
        membership_id,
        email,
        user_name: user_name || null,
        plan_id,
        plan_name: product_name || null,
        braintree_subscription_id: subscriptionId,
        braintree_customer_id: customerId,
        braintree_payment_method_token: paymentMethodToken,
        status: 'active',
        activated_at: new Date().toISOString(),
        ip_address,
        user_agent,
        created_at: new Date().toISOString()
      }, { onConflict: 'membership_id' });
    }

    // Generar claim y enviar email
    const result = await handleConfirmedPayment({ plan_id, email, membership_id, user_name });

    await logEvent(membership_id, 'payment_confirmed_frontend', { plan_id, email, subscriptionId });

    return res.json({ 
      ok: true, 
      claim: result.claim,
      message: 'payment_successful',
      membership_id 
    });

  } catch (e) {
    console.error('❌ Error en /api/frontend/confirm:', e?.message || e);
    await logFailedAttempt({ ip_address, user_agent, failure_type: 'server_error', error_message: e.message });
    return res.status(500).json({ error: 'server_error', message: e.message });
  }
});

// ============================================
// ENDPOINT ORIGINAL: /api/payment/process
// ============================================
app.post('/api/payment/process', async (req, res) => {
  const ip_address = req.ip || req.connection.remoteAddress;
  const user_agent = req.get('user-agent') || '';

  try {
    const origin = req.get('Origin') || req.get('origin') || '';
    if (ALLOWED_ORIGINS.length > 0 && origin && !ALLOWED_ORIGINS.includes(origin)) {
      await logFailedAttempt({ ip_address, user_agent, failure_type: 'origin_not_allowed', error_message: `Origin: ${origin}` });
      return res.status(403).json({ error: 'origin_not_allowed' });
    }

    if (FRONTEND_TOKEN) {
      const sent = req.get('x-frontend-token') || req.body?.frontend_token || '';
      if (!sent || sent !== FRONTEND_TOKEN) {
        await logFailedAttempt({ ip_address, user_agent, failure_type: 'invalid_frontend_token' });
        return res.status(401).json({ error: 'invalid_frontend_token' });
      }
    }

    const secret = req.get('X-SHARED-SECRET') || req.body?.shared_secret || '';
    if (!secret || secret !== SHARED_SECRET) {
      await logFailedAttempt({ ip_address, user_agent, failure_type: 'unauthorized' });
      return res.status(401).json({ error: 'unauthorized' });
    }

    const { product_name, plan_id, email, membership_id, user_name, payment_method_nonce } = req.body || {};

    if (!plan_id || !email || !membership_id) {
      await logFailedAttempt({ email, ip_address, user_agent, failure_type: 'missing_fields' });
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    try {
      if (supabase) {
        await supabase.from('memberships').upsert({
          membership_id,
          email,
          user_name: user_name || null,
          plan_id,
          plan_name: product_name || null,
          amount_paid: null,
          currency: 'USD',
          braintree_subscription_id: null,
          braintree_customer_id: null,
          braintree_payment_method_token: null,
          card_last4: null,
          card_type: null,
          status: 'pending',
          activated_at: null,
          ip_address,
          user_agent,
          payment_method_nonce: payment_method_nonce || null,
          created_at: new Date().toISOString()
        }, { onConflict: 'membership_id' });
      }

      await logEvent(membership_id || crypto.randomUUID(), 'subscription_requested', { plan_id, product_name, email });
      return res.json({ ok: true, message: 'created_pending_waiting_webhook', membership_id });
    } catch (e) {
      console.error('db insert error', e?.message || e);
      await logFailedAttempt({ email, ip_address, user_agent, failure_type: 'db_error', error_message: e.message });
      return res.status(500).json({ error: 'db_error', message: e.message });
    }

  } catch (e) {
    console.error('process error', e?.message || e);
    await logFailedAttempt({ ip_address: req.ip, user_agent: req.get('user-agent'), failure_type: 'server_error', error_message: e.message });
    return res.status(500).json({ error: 'server_error' });
  }
});

// ============================================
// ENDPOINT: Check Payment Status
// ============================================
app.get('/api/payment/status/:membership_id', async (req, res) => {
  try {
    const { membership_id } = req.params;

    if (!supabase) {
      return res.json({ status: 'unknown', message: 'database_not_configured' });
    }

    const { data } = await supabase
      .from('memberships')
      .select('status, activated_at')
      .eq('membership_id', membership_id)
      .maybeSingle();

    if (!data) {
      return res.json({ status: 'not_found' });
    }

    return res.json({
      status: data.status,
      activated_at: data.activated_at,
      is_active: data.status === 'active'
    });
  } catch (e) {
    console.error('status check error', e?.message || e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ============================================
// ENDPOINT: Braintree Webhook
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

    if (notification.kind === braintree.WebhookNotification.Kind.SubscriptionChargedSuccessfully || kind.includes('subscription_charged_successfully') || kind.includes('subscription_charged')) {
      const subscription = notification.subscription;
      const plan_id = subscription.planId || null;
      const braintree_subscription_id = subscription.id;

      let membership_id = null, email = null, user_name = null;

      if (supabase) {
        const { data } = await supabase.from('memberships').select('membership_id, email, user_name').eq('braintree_subscription_id', braintree_subscription_id).maybeSingle();
        if (data) {
          membership_id = data.membership_id;
          email = data.email;
          user_name = data.user_name;
        } else {
          const { data: pend } = await supabase.from('memberships').select('membership_id, email, user_name').eq('payment_method_nonce', notification.subscription && notification.subscription.id ? notification.subscription.id : '').maybeSingle();
          if (pend) {
            membership_id = pend.membership_id;
            email = pend.email;
            user_name = pend.user_name;
          }
        }
      }

      if (email && membership_id) {
        if (supabase) {
          await supabase.from('memberships').update({ status: 'active', activated_at: new Date().toISOString(), braintree_subscription_id }).eq('membership_id', membership_id);
        }

        try {
          const result = await handleConfirmedPayment({ plan_id: (plan_id || 'plan_unknown'), email, membership_id, user_name });
          try {
            if (supabase) {
              const { data: link } = await supabase.from('membership_links').select('discord_id').eq('membership_id', membership_id).maybeSingle();
              const discordId = link?.discord_id || null;
              if (discordId) {
                const roleId = roleForPlan(plan_id);
                if (roleId) {
                  await addDiscordRole(discordId, roleId);
                  await logEvent(membership_id, 'role_assigned_via_webhook', { discordId, roleId, plan_id });
                } else {
                  console.warn('No roleId resolved for plan', plan_id);
                }

                const channelId = DEFAULT_CHANNEL_ID;
                if (channelId) {
                  const msg = `Bienvenido <@${discordId}> — tu pago fue confirmado y el rol ha sido asignado. 🎉`;
                  await sendChannelMessage(channelId, msg);
                }
              } else {
                await logEvent(membership_id, 'no_discord_mapping', { membership_id, email });
              }
            }
          } catch (errAssign) {
            console.error('Error assigning role after webhook:', errAssign?.message || errAssign);
            await logEvent(membership_id, 'role_assign_error', { error: errAssign?.message || String(errAssign) });
          }

          await markWebhookProcessed(event_id);
        } catch(e){ console.error('handleConfirmedPayment error', e?.message || e); }
      } else {
        await logEvent(event_id, 'unmatched_webhook', { kind: notification.kind, subscription: notification.subscription });
      }
    }

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

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString(), version: '2.1' }));

app.listen(PORT, () => {
  console.log('🟢 NAZA.fx BOT v2.1 on', BASE_URL);
  console.log('🛡️  Anti-fraud: ENABLED');
  console.log('⏳ WAIT_FOR_WEBHOOK:', WAIT_FOR_WEBHOOK);
  console.log('📊 Supabase:', supabase ? 'CONNECTED' : 'NOT CONFIGURED');
  console.log('💳 Braintree:', BT_ENV === braintree.Environment.Production ? 'PRODUCTION' : 'SANDBOX');
  console.log('✅ Endpoint /api/frontend/confirm ACTIVO');
});
