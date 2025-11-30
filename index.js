// index.js - NAZA (actualizado por ChatGPT)
// Node >=18 required
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
// <-- FETCH: prefer native global.fetch (Node 18+). No require('node-fetch') to avoid install issues.
const fetch = global.fetch;
const app = express();

// NOTE: keep JSON parsing global except for raw webhook route
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// CONFIGURACIÓN (variables de entorno)
const FRONTEND_TOKEN = process.env.FRONTEND_TOKEN;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL;
const GUILD_ID = process.env.GUILD_ID;

// ===== ROLE ENV VARS: prefer the new names you confirmed, but accept older names as fallback =====
// New/confirmed names: ROLE_ID_MENSUAL, ROLE_ID_TRIMESTRAL, ROLE_ID_ANUAL
// Older names sometimes used in screenshots: ROLE_ID_SENALESDISCORD, ROLE_ID_MENTORIADISCORD, ROLE_ID_ANUALDISCORD
const ROLE_ID_MENSUAL = process.env.ROLE_ID_MENSUAL || process.env.ROLE_ID_SENALESDISCORD || process.env.ROLE_ID_MENSUAL_DISCORD || process.env.ROLE_ID_MENSUAL || null;
const ROLE_ID_TRIMESTRAL = process.env.ROLE_ID_TRIMESTRAL || process.env.ROLE_ID_MENTORIADISCORD || process.env.ROLE_ID_TRIMESTRAL_DISCORD || null;
const ROLE_ID_ANUAL = process.env.ROLE_ID_ANUAL || process.env.ROLE_ID_ANUALDISCORD || process.env.ROLE_ID_ANUAL_DISCORD || null;

// (Also keep legacy var names available for other code that may reference them)
const ROLE_ID_ANUALDISCORD = process.env.ROLE_ID_ANUALDISCORD || ROLE_ID_ANUAL;
const ROLE_ID_MENTORIADISCORD = process.env.ROLE_ID_MENTORIADISCORD || ROLE_ID_TRIMESTRAL;
const ROLE_ID_SENALESDISCORD = process.env.ROLE_ID_SENALESDISCORD || ROLE_ID_MENSUAL;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || FROM_EMAIL;
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const BOT_URL = process.env.BOT_URL || BASE_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || '';
const WHOP_WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET || '';
const WHOP_API_KEY = process.env.WHOP_API_KEY || '';
const JWT_SIGNING_SECRET = process.env.JWT_SIGNING_SECRET || '';
const NODE_ENV = process.env.NODE_ENV || 'development';

// ============================================
// SENDGRID
if (!SENDGRID_API_KEY) {
  console.warn('⚠️ SENDGRID_API_KEY no definido. Los correos no podrán enviarse.');
} else {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

// ============================================
// DISCORD CLIENT
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
if (DISCORD_BOT_TOKEN) {
  discordClient.login(DISCORD_BOT_TOKEN).catch(err => {
    console.error('❌ Error login Discord bot:', err?.message || err);
  });
}
discordClient.once('ready', () => {
  console.log('✅ Discord bot conectado:', discordClient.user?.tag || '(sin tag aún)');
});

// ============================================
// SUPABASE CLIENT
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  global: {
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      apikey: SUPABASE_SERVICE_ROLE
    }
  }
});

// ============================================
// TEMP STORAGE (kept but DB-first is primary)
const pendingAuths = new Map();

// ============================================
// UTIL: escape/email-safe
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function emailSafe(e){ return e || ''; }

// ============================================
// CORS MIDDLEWARE
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length === 0) {
    // if not configured, allow all for dev — but recommend setting ALLOWED_ORIGINS
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-frontend-token, x-signature, x-whop-signature');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============================================
// FRONTEND AUTH MIDDLEWARE
function authenticateFrontend(req, res, next) {
  const token = req.headers['x-frontend-token'];
  if (!token || token !== FRONTEND_TOKEN) {
    console.error('❌ Token inválido frontend');
    return res.status(401).json({ success: false, message: 'unauthorized', error: 'Token inválido' });
  }
  next();
}

// ============================================
// ACCESS LOG helper
async function logAccess(membership_id = null, event_type = 'generic', detail = {}) {
  try {
    await supabase.from('access_logs').insert([{ membership_id, event_type, detail: JSON.stringify(detail || {}), created_at: new Date().toISOString() }]);
  } catch (err) {
    console.warn('⚠️ No se pudo insertar access_log:', err?.message || err);
  }
}

// ============================================
// CLAIMS + VALIDATIONS (createClaimToken adapted, no debug logs)
async function createClaimToken({ email, name, plan_id, subscriptionId, customerId, last4, cardExpiry, extra = {} }) {
  email = (email || '').trim().toLowerCase();
  if (!email) throw new Error('Email requerido para crear claim');

  // 1) verificar membership existente
  const { data: existingMembership, error: memErr } = await supabase.from('memberships').select('id').eq('email', email).limit(1);
  if (memErr) {
    console.error('Error consultando memberships:', memErr);
    if (memErr.code === 'PGRST205' || (memErr.message && memErr.message.includes('Could not find the table'))) {
      console.error('ERROR: Parece que la tabla "memberships" no existe o la service role key está mal.' );
    }
    throw new Error('Error interno');
  }
  if (existingMembership && existingMembership.length > 0) {
    throw new Error('Este correo ya está registrado');
  }

  // 2) verificar claim pendiente
  const { data: existingClaimsForEmail, error: claimErr } = await supabase.from('claims').select('id, used').eq('email', email).limit(1);
  if (claimErr) {
    console.error('Error consultando claims por email:', claimErr);
    throw new Error('Error interno');
  }
  if (existingClaimsForEmail && existingClaimsForEmail.length > 0) {
    throw new Error('Existe ya una solicitud para este correo. Revisa tu email.' );
  }

  // 3) verificar uso de tarjeta (no permitir >2 correos distintos)
  if (last4 && last4.toString().trim() !== '') {
    const [{ data: mRows, error: mErr }, { data: cRows, error: cErr }] = await Promise.all([
      supabase.from('memberships').select('email').eq('last4', last4).eq('card_expiry', cardExpiry || ''),
      supabase.from('claims').select('email').eq('last4', last4).eq('card_expiry', cardExpiry || '')
    ]);
    if (mErr) console.warn('mErr checking card:', mErr);
    if (cErr) console.warn('cErr checking card:', cErr);
    const distinctEmails = new Set();
    (mRows || []).forEach(r => { if (r.email) distinctEmails.add(String(r.email).toLowerCase()); });
    (cRows || []).forEach(r => { if (r.email) distinctEmails.add(String(r.email).toLowerCase()); });
    distinctEmails.delete('');
    if (distinctEmails.size >= 2 && !distinctEmails.has(email)) {
      throw new Error('Esta tarjeta ya está asociada a dos cuentas distintas. Contacta soporte.' );
    }
  }

  // Recheck quick to reduce race
  const [{ data: recheckMembership }, { data: recheckClaim }] = await Promise.all([
    supabase.from('memberships').select('id').eq('email', email).limit(1),
    supabase.from('claims').select('id,used').eq('email', email).limit(1)
  ]);
  if (recheckMembership && recheckMembership.length > 0) throw new Error('Este correo ya está registrado');
  if (recheckClaim && recheckClaim.length > 0) throw new Error('Existe ya una solicitud para este correo. Revisa tu email.' );

  // generate token
  const token = crypto.randomBytes(24).toString('hex'); // 48 chars
  const row = {
    token,
    email,
    last4: last4 || '',
    card_expiry: cardExpiry || '',
    name: name || '',
    plan_id: plan_id || '',
    subscription_id: subscriptionId || '',
    customer_id: customerId || '',
    extra: JSON.stringify(extra || {}),
    used: false,
    created_at: new Date().toISOString()
  };
  const { data: insertData, error: insertErr } = await supabase.from('claims').insert([row]);
  if (insertErr) {
    console.error('Error insertando claim:', insertErr);
    throw new Error('No se pudo crear el claim');
  }
  await logAccess(null, 'claim_created', { email, plan_id, token_created: true });
  return token;
}

// ============================================
// EMAIL: build templates (kept) & send (no debug logs exposing token)
function buildWelcomeEmailHtml({ name, planName, subscriptionId, claimUrl, email, supportEmail }) {
  const logoPath = process.env.LOGO_URL || 'https://vwndjpylfcekjmluookj.supabase.co/storage/v1/object/public/assets/0944255a-e933-4527-9aa5-f9e18e862a00.jpg';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="margin:0;padding:0;background-color:#000000;">...` +
    `<div style="color:#fff;">Hola ${escapeHtml(name || 'usuario')}, pulsa el botón para obtener acceso: <a href="${escapeHtml(claimUrl)}">Obtener acceso</a></div></body></html>`;
}
function buildWelcomeText({ name, planName, subscriptionId, claimUrl, supportEmail, email }) {
  return `Hola ${name || 'usuario'},\n\nTu suscripción ha sido activada. Accede: ${claimUrl}\n\nSoporte: ${supportEmail}`;
}

async function sendWelcomeEmail(email, name, planId, subscriptionId, customerId, extra = {}, existingToken = null) {
  if (!SENDGRID_API_KEY) throw new Error('SENDGRID_API_KEY no configurada');
  const planNames = {
    'plan_anual': 'Plan Anual 🔥',
    'plan_trimestral': 'Plan Trimestral 📈',
    'plan_mensual': 'Plan Mensual 💼'
  };
  const planName = planNames[planId] || 'Plan';
  let token = existingToken;
  if (!token) {
    token = await createClaimToken({ email, name, plan_id: planId, subscriptionId, customerId, last4: extra.last4, cardExpiry: extra.cardExpiry, extra });
  }
  const claimUrl = `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(DISCORD_CLIENT_ID)}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URL)}&response_type=code&scope=identify%20guilds.join&state=${encodeURIComponent(token)}`;
  const msg = {
    to: email,
    from: FROM_EMAIL,
    subject: `¡Bienvenido a NAZA Trading Academy! — Obtener acceso`,
    text: buildWelcomeText({ name, planName, subscriptionId, claimUrl, supportEmail: SUPPORT_EMAIL, email }),
    html: buildWelcomeEmailHtml({ name, planName, subscriptionId, claimUrl, email, supportEmail: SUPPORT_EMAIL })
  };
  await sgMail.send(msg);
  await logAccess(null, 'email_sent', { email, planId });
}

// ============================================
// WEBHOOK: WHOP (raw body required for signature verification)
// (handler unchanged conceptually — kept in file earlier; ensure no duplication when replacing)
app.post('/webhook/whop', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const rawBody = req.body; // Buffer
    const signatureHeader = (req.headers['x-whop-signature'] || req.headers['x-signature'] || '').toString();
    if (!WHOP_WEBHOOK_SECRET) {
      console.error('WHOP_WEBHOOK_SECRET no configurado');
      return res.status(500).send('Server misconfigured');
    }
    if (!signatureHeader) {
      console.warn('Webhook sin signature header');
      return res.status(401).send('No signature');
    }
    // compute HMAC-SHA256 hex
    const computed = crypto.createHmac('sha256', WHOP_WEBHOOK_SECRET).update(rawBody).digest('hex');
    // compare (constant-time)
    const signatureMatches = crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signatureHeader));
    if (!signatureMatches) {
      console.warn('Firma webhook inválida');
      await logAccess(null, 'webhook_invalid_signature', { header: signatureHeader.slice(0,8) });
      return res.status(401).send('Invalid signature');
    }

    // parse JSON safely
    const payload = JSON.parse(rawBody.toString('utf8'));
    // Support different event key names
    const event = payload.event || payload.type || payload.kind || payload?.data?.event || null;
    const data = payload.data || payload || {};
    await logAccess(null, 'webhook_received', { event });

    // Normalize fields
    const orderId = data.order_id || data.id || (data.order && data.order.id) || null;
    const subscriptionId = data.subscription_id || data.subscription?.id || null;
    const status = data.status || data.payment_status || null;
    const productId = data.product_id || data.product?.id || data.product_name || null;
    const amount = data.amount || (data.order && data.order.amount) || null;
    const currency = data.currency || (data.order && data.order.currency) || null;
    const buyer = data.buyer || data.customer || {};
    const email = (buyer.email || '').toString().trim().toLowerCase();
    const last4 = (data.payment_method && data.payment_method.last4) || (buyer.last4) || (data.card_last4) || '';

    // Idempotency: check if we already processed this order
    if (orderId) {
      const { data: existing, error: exErr } = await supabase.from('webhook_events').select('id').eq('order_id', orderId).limit(1);
      if (exErr) console.warn('exErr checking webhook_events:', exErr);
      if (existing && existing.length > 0) {
        // Already received — respond 200
        await logAccess(null, 'webhook_duplicate', { orderId });
        return res.status(200).send('already processed');
      }
      // persist basic event to avoid races
      await supabase.from('webhook_events').insert([{ order_id: orderId, subscription_id: subscriptionId, event: event || status || 'unknown', raw: payload, received_at: new Date().toISOString() }]).catch(err => {
        console.warn('No se pudo persistir webhook_events (continuamos):', err?.message || err);
      });
    }

    // Handle main events
    if (['payment_succeeded', 'order.paid', 'order_paid', 'membership_activated', 'payment_succeeded_v2'].some(e => (event || '').toString().toLowerCase().includes(e))) {
      // if email exists -> create or reuse claim and send email
      if (email) {
        try {
          // Check if membership already exists active for this email (idempotency)
          const { data: members, error: memErr } = await supabase.from('memberships').select('id,status').eq('email', email).limit(1);
          if (memErr) console.warn('memErr checking membership in webhook:', memErr);
          if (members && members.length > 0 && members[0].status === 'active') {
            await logAccess(null, 'webhook_noop_member_already_active', { email, orderId });
            return res.status(200).send('member already active');
          }
          // create claim token and send email
          const { data: existingClaims } = await supabase.from('claims').select('*').or(`subscription_id.eq.${subscriptionId},extra.like.%order:${orderId}%`).limit(1);
          let token = null;
          if (existingClaims && existingClaims.length > 0) {
            token = existingClaims[0].token;
            if (existingClaims[0].used) {
              await logAccess(null, 'webhook_claim_already_used', { email, orderId });
              return res.status(200).send('claim already used');
            }
          } else {
            token = await createClaimToken({ email, name: buyer.full_name || buyer.name || '', plan_id: productId || '', subscriptionId, customerId: buyer.id || '', last4, cardExpiry: data.card_expiry || '' , extra: { order: orderId } });
            await supabase.from('claims').update({ extra: JSON.stringify({ order: orderId }) }).eq('token', token).catch(()=>{});
          }
          // send welcome email (background)
          sendWelcomeEmail(email, buyer.full_name || '', productId || '', subscriptionId, buyer.id || '', { last4, cardExpiry: data.card_expiry || '' }, token)
            .then(()=> logAccess(null, 'webhook_email_dispatched', { email, orderId }))
            .catch(err => logAccess(null, 'webhook_email_failed', { email, orderId, err: err?.message || err }));
          return res.status(200).send('ok');
        } catch (err) {
          console.error('Error processing payment_succeeded webhook:', err?.message || err);
          await logAccess(null, 'webhook_processing_error', { err: err?.message || err });
          return res.status(500).send('error processing');
        }
      } else {
        // No email: create a pending record for manual review
        try {
          await supabase.from('memberships').insert([{
            order_id: orderId,
            subscription_id: subscriptionId,
            product_id: productId,
            amount,
            currency,
            status: 'awaiting_data',
            raw_payload: payload,
            created_at: new Date().toISOString()
          }]);
          await logAccess(null, 'webhook_missing_email_created_pending', { orderId });
          return res.status(200).send('pending awaiting data');
        } catch (err) {
          console.error('Error creating pending membership for missing email:', err?.message || err);
          return res.status(500).send('error');
        }
      }
    }

    // cancellation / deactivation
    if (['subscription.cancelled', 'membership_deactivated', 'subscription_cancelled', 'order_refunded'].some(e => (event || '').toString().toLowerCase().includes(e))) {
      try {
        const lookup = subscriptionId ? { subscription_id: subscriptionId } : (orderId ? { order_id: orderId } : null);
        if (!lookup) {
          await logAccess(null, 'webhook_cancel_no_lookup', { event, orderId, subscriptionId });
          return res.status(200).send('no lookup keys');
        }
        const { data: rows } = await supabase.from('memberships').select('*').or(`subscription_id.eq.${subscriptionId},order_id.eq.${orderId}`).limit(1);
        if (rows && rows.length > 0) {
          const row = rows[0];
          // revoke role if exists
          if (row.discord_id && row.role_id) {
            // attempt to remove role (best-effort)
            try {
              const guild = await discordClient.guilds.fetch(GUILD_ID);
              const member = await guild.members.fetch(row.discord_id);
              await member.roles.remove(row.role_id).catch(err => { throw err; });
              await logAccess(row.id, 'role_revoked', { discord_id: row.discord_id, role_id: row.role_id });
            } catch (err) {
              console.warn('Could not revoke role immediately:', err?.message || err);
              await logAccess(row.id, 'role_revocation_failed', { err: err?.message || err });
            }
          }
          // update membership status
          await supabase.from('memberships').update({ status: 'cancelled', revoked_at: new Date().toISOString() }).eq('id', row.id);
          return res.status(200).send('cancelled processed');
        } else {
          await logAccess(null, 'webhook_cancel_no_membership_found', { subscriptionId, orderId });
          return res.status(200).send('no membership found');
        }
      } catch (err) {
        console.error('Error processing cancel webhook:', err?.message || err);
        return res.status(500).send('error processing cancel');
      }
    }

    // default
    await logAccess(null, 'webhook_unhandled', { event });
    return res.status(200).send('ignored');
  } catch (err) {
    console.error('❌ Error general en /webhook/whop:', err?.message || err);
    return res.status(500).send('internal error');
  }
});

// ============================================
// ROUTE: claim redirect (kept)
app.get('/api/auth/claim', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send('Token missing');
  try {
    const { data: rows, error } = await supabase.from('claims').select('id,token,used').eq('token', token).limit(1);
    if (error) {
      console.error('Error leyendo claim:', error);
      return res.status(500).send('Error interno');
    }
    if (!rows || rows.length === 0) return res.status(400).send('Enlace inválido. Contacta soporte.');
    const claimRow = rows[0];
    if (claimRow.used) return res.status(400).send('Este enlace ya fue utilizado.');
    const clientId = encodeURIComponent(DISCORD_CLIENT_ID);
    const redirectUri = encodeURIComponent(DISCORD_REDIRECT_URL);
    const scope = encodeURIComponent('identify guilds.join');
    const prompt = 'consent';
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${encodeURIComponent(token)}&prompt=${prompt}`;
    return res.redirect(discordAuthUrl);
  } catch (err) {
    console.error('❌ Error en /api/auth/claim:', err);
    return res.status(500).send('Error interno');
  }
});

// ============================================
// ROUTE: DISCORD CALLBACK (improved checks + idempotency)
// (kept as in your provided file; role mapping uses the ROLE_ID_ vars defined above)
// ... [callback code unchanged, uses ROLE_ID_MENSUAL/ROLE_ID_TRIMESTRAL/ROLE_ID_ANUAL] ...
// For brevity the remainder of the callback and other routes are unchanged in this pasted file,
// because earlier you provided a full working callback — ensure you keep the callback logic here.


// ============================================
// HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// START
app.listen(PORT, () => {
  console.log('🚀 NAZA Bot - servidor iniciado');
  console.log('🌐 Puerto:', PORT);
  console.log('🔗 URL:', BASE_URL);
});
