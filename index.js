// index_whop_with_naza_email.js
// Node >=18 required
require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
// fetch: use global.fetch if available (Node 18+), otherwise try node-fetch (CommonJS fallback)
let fetch = global.fetch;
if (!fetch) {
  try {
    // require('node-fetch') might fail in ESM-only installs; this is a best-effort fallback
    // If your environment uses ESM-only node-fetch, keep native fetch (Node 18+) or use an adapter.
    // This fallback will work in many CommonJS deployments that have node-fetch installed.
    // eslint-disable-next-line global-require
    fetch = require('node-fetch');
  } catch (e) {
    // leave fetch undefined; code paths assume fetch exists in Node >=18
    fetch = undefined;
  }
}
const app = express();

// NOTE: we intentionally DO NOT call express.json() / urlencoded() here so the webhook route can receive raw body

// ============================================
// CONFIGURACIÓN (variables de entorno)
const FRONTEND_TOKEN = process.env.FRONTEND_TOKEN;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL;
const GUILD_ID = process.env.GUILD_ID;
// Role envs (use the ones you provided)
// Defaults set to your provided IDs (intencional: trimestral == anual)
const ROLE_ID_ANUAL = process.env.ROLE_ID_ANUAL || '1432149252016177233';
const ROLE_ID_MENSUAL = process.env.ROLE_ID_MENSUAL || '1430906969630183830';
const ROLE_ID_TRIMESTRAL = process.env.ROLE_ID_TRIMESTRAL || '1432149252016177233';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || FROM_EMAIL;
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const BOT_URL = process.env.BOT_URL || BASE_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || '';
const JWT_SIGNING_SECRET = process.env.JWT_SIGNING_SECRET || '';
const NODE_ENV = process.env.NODE_ENV || 'development';
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || ''; // optional for PayPal verification
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_SECRET = process.env.PAYPAL_SECRET || '';
const PAYPAL_ENV = process.env.PAYPAL_ENV || 'sandbox'; // 'live' or 'sandbox'

// ============================================
// PRODUCT ID -> ROLE mapping (use your known product ids)
const PRODUCT_ROLE_MAP = {
  // example product ids you showed earlier; adjust if different
  'NRH364VHDNAX6': ROLE_ID_MENSUAL,       // plan mensual
  'WB6B3EEG4T8RQ': ROLE_ID_TRIMESTRAL,    // plan trimestral
  'CFQ2Z3QEDSJYS': ROLE_ID_ANUAL,         // plan anual
  // keep old prod_* mapping if you also use them (safe to include)
  'prod_VD83C9VQ7qYjF': ROLE_ID_MENSUAL,
  'prod_8ITa0Ux0IajNA': ROLE_ID_TRIMESTRAL,
  'prod_7Uun6u558QKNs': ROLE_ID_ANUAL
};

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
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
function emailSafe(e){ return e || ''; }

// ============================================
// CORS MIDDLEWARE
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-frontend-token, x-signature');
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
    await supabase
      .from('access_logs')
      .insert([{ membership_id, event_type, detail: JSON.stringify(detail || {}), created_at: new Date().toISOString() }]);
  } catch (err) {
    console.warn('⚠️ No se pudo insertar access_log:', err?.message || err);
  }
}

// ============================================
// PLAN DETECTION (para cualquier producto/membresía)
function detectPlanKeyFromString(planIdRaw) {
  const txt = (planIdRaw || '').toString().toLowerCase();
  if (!txt) return 'other';

  if (
    txt.includes('plan_mensual') ||
    txt.includes('mensual') ||
    txt.includes('monthly') ||
    txt.includes('mes') ||
    txt.includes('30 dias') ||
    txt.includes('30 días')
  ) return 'plan_mensual';

  if (
    txt.includes('plan_trimestral') ||
    txt.includes('trimestral') ||
    txt.includes('quarter') ||
    txt.includes('3 meses') ||
    txt.includes('90 dias') ||
    txt.includes('90 días')
  ) return 'plan_trimestral';

  if (
    txt.includes('plan_anual') ||
    txt.includes('anual') ||
    txt.includes('annual') ||
    txt.includes('12 meses') ||
    txt.includes('year') ||
    txt.includes('1 año') ||
    txt.includes('1 ano')
  ) return 'plan_anual';

  return 'other';
}

// ============================================
// CLAIMS + VALIDATIONS (store token in plain as you requested)
async function createClaimToken({ email, name, plan_id, subscriptionId, customerId, last4, cardExpiry, paymentFingerprint = '', extra = {} }) {
  email = (email || '').trim().toLowerCase();
  if (!email) throw new Error('Email requerido para crear claim');

  // Nota: quitamos las restricciones que impedían memberships/claims duplicados.
  // El sistema aceptará múltiples purchases por email — cada claim sigue siendo único.
  // (Si quieres reactivar alguna validación de límite, la podemos añadir después.)

  // 3) verificar uso de tarjeta / fingerprint
  if (paymentFingerprint && paymentFingerprint.toString().trim() !== '') {
    const [{ data: mRows, error: mErr }, { data: cRows, error: cErr }] = await Promise.all([
      supabase
        .from('memberships')
        .select('email, status')
        .eq('payment_fingerprint', paymentFingerprint)
        .eq('status', 'active'),
      supabase
        .from('claims')
        .select('email, used')
        .eq('payment_fingerprint', paymentFingerprint)
        .eq('used', false)
    ]);
    if (mErr) console.warn('mErr checking fingerprint:', mErr);
    if (cErr) console.warn('cErr checking fingerprint:', cErr);
    const distinctEmails = new Set();
    (mRows || []).forEach(r => { if (r.email) distinctEmails.add(String(r.email).toLowerCase()); });
    (cRows || []).forEach(r => { if (r.email) distinctEmails.add(String(r.email).toLowerCase()); });
    distinctEmails.delete('');
    if (distinctEmails.size >= 2 && !distinctEmails.has(email)) {
      throw new Error('Esta tarjeta/método de pago ya está asociada a dos cuentas distintas. Contacta soporte.');
    }
  }

  // generate plain token and store it directly (PLANO)
  const token = crypto.randomBytes(24).toString('hex'); // 48 chars plain token to email

  const row = {
    token, // token PLANO guardado
    email,
    name: name || '',
    plan_id: plan_id || '',
    subscription_id: subscriptionId || '',
    customer_id: customerId || '',
    last4: last4 || '',
    card_expiry: cardExpiry || '',
    payment_fingerprint: paymentFingerprint || '',
    used: false,
    extra: JSON.stringify(extra || {}),
    created_at: new Date().toISOString()
  };

  const { error: insertErr } = await supabase.from('claims').insert([row]);
  if (insertErr) {
    console.error('Error insertando claim:', insertErr);
    throw new Error('No se pudo crear el claim');
  }
  await logAccess(null, 'claim_created', { email, plan_id, token_created: true });
  return token;
}

// ============================================
// EMAIL: build templates & send
// (Kept your original HTML + text template unchanged — pasted as-is)

function buildWelcomeEmailHtml({ name, planName, subscriptionId, claimUrl, email, supportEmail, token }) {
  const logoPath = process.env.LOGO_URL || 'https://vwndjpylfcekjmluookj.supabase.co/storage/v1/object/public/assets/0944255a-e933-4527-9aa5-f9e18e862a00.jpg';

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<style>
@media (prefers-color-scheme: dark) {
  .wrap { background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01)) !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background-color:#000000;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#000000" style="background-color:#000000;width:100%;min-width:100%;margin:0;padding:24px 0;">
    <tr>
      <td align="center" valign="top">
        <table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:680px;margin:0 auto;">
          <tr>
            <td style="padding:0 16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:12px;overflow:hidden;background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));box-shadow:0 10px 30px rgba(2,6,23,0.6);border:1px solid rgba(255,255,255,0.03);">
                <tr>
                  <td style="padding:28px 24px 8px 24px;text-align:center;">
                    <div style="width:96px;height:96px;border-radius:50%;overflow:hidden;margin:0 auto;display:block;border:4px solid rgba(255,255,255,0.04);box-shadow:0 8px 30px rgba(2,6,23,0.6);background:linear-gradient(135deg,#0f1720,#08101a);">
                      <img src="${logoPath}" alt="NAZA logo" width="96" height="96" style="display:block;width:96px;height:96px;object-fit:cover;transform:scale(1.12);border-radius:50%;" />
                    </div>
                    <h1 style="color:#ff9b3b;margin:18px 0 8px 0;font-size:26px;font-family:Arial,sans-serif;">NAZA Trading Academy</h1>
                    <div style="color:#cbd5e1;margin:6px 0 20px 0;font-size:16px;font-family:Arial,sans-serif;">¡Bienvenido! Tu suscripción ha sido activada correctamente.</div>
                  </td>
                </tr>

                <tr>
                  <td style="padding:20px 28px 28px 28px;color:#d6e6f8;font-family:Arial,sans-serif;line-height:1.5;">
                    <div style="font-size:15px;margin-bottom:16px;"><strong>Hola ${escapeHtml(name || 'usuario')},</strong></div>

                    <div style="background:linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.005));padding:18px;border-radius:10px;border:1px solid rgba(255,255,255,0.02);margin-top:0;">
                      <p style="margin:0 0 10px 0;"><strong>Entrega del servicio</strong></p>
                      <p style="margin:0;color:#d6e6f8">Todos los privilegios de tu plan —cursos, clases en vivo, análisis exclusivos y canales privados— se gestionan dentro de <strong>Discord</strong>. Al pulsar <em>Obtener acceso</em> recibirás el rol correspondiente y se te desbloquearán automáticamente los canales de tu plan.</p>
                    </div>

                    <div style="text-align:center;margin:22px 0;">
                      <a href="${escapeHtml(claimUrl)}" data-token="${token ? encodeURIComponent(token) : ''}" style="display:inline-block;background:#2d9bf0;color:#ffffff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;box-shadow:0 8px 30px rgba(45,155,240,0.15);font-family:Arial,sans-serif;">Obtener acceso</a>
                      <div style="color:#9fb0c9;font-size:13px;margin-top:8px;font-family:Arial,sans-serif;">(En caso de no haber reclamado)</div>
                    </div>

                    <div style="background:linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.005));padding:18px;border-radius:10px;border:1px solid rgba(255,255,255,0.02);margin-top:18px;">
                      <p style="margin:0 0 8px 0;"><strong>Únete a la comunidad y mantente al día</strong></p>
                      <p style="margin:0 0 12px 0;color:#d6e6f8">Para ver anuncios oficiales, horarios de clases, avisos de sesiones en vivo y formar parte de los chats (WhatsApp y Telegram), visita nuestro sitio y sigue las instrucciones para unirte a los grupos desde allí.</p>
                      <a href="https://nazatradingacademy.com" target="_blank" style="display:block;background:rgba(255,255,255,0.02);padding:14px;border-radius:8px;color:#bfe0ff;text-decoration:none;font-weight:600;border:1px solid rgba(255,255,255,0.02);font-family:Arial,sans-serif;">https://nazatradingacademy.com</a>
                    </div>

                    <div style="background:linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.005));padding:18px;border-radius:10px;border:1px solid rgba(255,255,255,0.02);margin-top:18px;">
                      <p style="margin:0 0 8px 0;"><strong>¿Nuevo en Discord o no tienes cuenta?</strong></p>
                      <p style="margin:0 0 12px 0;color:#d6e6f8">Si necesitas ayuda, usa los enlaces de abajo:</p>
                      <a href="https://discord.com/download" target="_blank" style="display:inline-block;padding:10px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.04);margin-right:12px;text-decoration:none;color:#d6e6f8;font-weight:600;background:transparent;font-family:Arial,sans-serif;">Descargar Discord</a>
                      <a href="https://youtu.be/-qgmEy1XjMg?si=vqXGRkIid-kgTCTr" target="_blank" style="display:inline-block;padding:10px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.04);text-decoration:none;color:#d6e6f8;font-weight:600;background:transparent;font-family:Arial,sans-serif;">Cómo crear una cuenta (ES)</a>
                    </div>

                    <div style="font-size:13px;color:#9fb0c9;margin-top:12px;font-family:Arial,sans-serif;">
                      <div><strong>Detalles de la suscripción:</strong></div>
                      <div style="margin-top:6px;">Plan: ${escapeHtml(planName)}</div>
                      <div>ID de suscripción: ${escapeHtml(subscriptionId || '')}</div>
                      <div>Email: ${escapeHtml(emailSafe(email) || '')}</div>
                      <div style="margin-top:6px;font-size:12px;color:#8fa6bf">El enlace es de un solo uso y funciona hasta que completes el registro en Discord. Si ya iniciaste sesión con OAuth2, no es necesario volver a usarlo.</div>
                    </div>

                  </td>
                </tr>

                <tr>
                  <td style="padding:18px;text-align:center;color:#98b0c8;font-size:13px;background:transparent;border-top:1px solid rgba(255,255,255,0.02);font-family:Arial,sans-serif;">
                    <div>©️ ${new Date().getFullYear()} NAZA Trading Academy</div>
                    <div style="margin-top:6px">Soporte: <a href="mailto:${supportEmail || SUPPORT_EMAIL || 'support@nazatradingacademy.com'}" style="color:#bfe0ff;text-decoration:none">${supportEmail || SUPPORT_EMAIL || 'support@nazatradingacademy.com'}</a></div>
                  </td>
                </tr>

              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildWelcomeText({ name, planName, subscriptionId, claimUrl, supportEmail, email, token }) {
  return `Hola ${name || 'usuario'}, ¡Bienvenido a NAZA Trading Academy!\n\nTu suscripción ha sido activada correctamente.\n\nEntrega del servicio:\nTodos los privilegios de tu plan —cursos, clases en vivo, análisis y canales exclusivos— se entregan a través de Discord. Al pulsar "Obtener acceso" se te asignará automáticamente el rol correspondiente y se desbloquearán los canales de tu plan.\n\nÚnete a la comunidad:\nPara anuncios oficiales, horarios de clases y unirte a los chats (WhatsApp y Telegram), visita: https://nazatradingacademy.com\n\nSi no tienes Discord:\n- Descargar Discord: https://discord.com/download\n- Cómo crear una cuenta (ES): https://youtu.be/-qgmEy1XjMg?si=vqXGRkIid-kgTCTr\n\nEnlace para obtener acceso (un solo uso — válido hasta completar registro):\n${claimUrl}\n\nDetalles:\nPlan: ${planName}\nID de suscripción: ${subscriptionId || ''}\nEmail: ${email || ''}\n\nSoporte: ${supportEmail || SUPPORT_EMAIL || 'support@nazatradingacademy.com'}\n\nNota: El enlace es de un solo uso y funcionará hasta que completes el proceso en Discord.`;
}

async function sendWelcomeEmail(email, name, planId, subscriptionId, customerId, extra = {}, existingToken = null) {
  if (!SENDGRID_API_KEY) throw new Error('SENDGRID_API_KEY no configurada');

  const planNames = {
    'plan_anual': 'Plan Anual 🔥',
    'plan_trimestral': 'Plan Trimestral 📈',
    'plan_mensual': 'Plan Mensual 💼',
    'other': 'Plan'
  };
  const planKey = detectPlanKeyFromString(planId);
  const planName = planNames[planKey] || 'Plan';

  let token = existingToken;
  if (!token) {
    token = await createClaimToken({
      email,
      name,
      plan_id: planId,
      subscriptionId,
      customerId,
      last4: extra.last4,
      cardExpiry: extra.cardExpiry,
      paymentFingerprint: extra.payment_fingerprint,
      extra
    });
  }

  // Discord OAuth link usando el token como state (claim de un solo uso)
  const claimUrl = `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(DISCORD_CLIENT_ID)}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URL)}&response_type=code&scope=identify%20guilds.join&state=${encodeURIComponent(token)}`;

  const msg = {
    to: email,
    from: FROM_EMAIL,
    subject: `¡Bienvenido a NAZA Trading Academy! — Obtener acceso`,
    text: buildWelcomeText({ name, planName, subscriptionId, claimUrl, supportEmail: SUPPORT_EMAIL, email, token }),
    html: buildWelcomeEmailHtml({ name, planName, subscriptionId, claimUrl, email, supportEmail: SUPPORT_EMAIL, token })
  };
  await sgMail.send(msg);
  await logAccess(null, 'email_sent', { email, planId });
}

// ============================================
// PayPal signature verification helper
async function verifyPayPalSignature(rawBodyText, headers) {
  if (!PAYPAL_WEBHOOK_ID || !PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
    // not configured -> skip verification
    return { ok: true, skipped: true, reason: 'no_config' };
  }

  try {
    const paypalApiBase = (PAYPAL_ENV === 'live') ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    // get access token
    const basicAuth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
    const tokenRes = await fetch(`${paypalApiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    const tokenJson = await tokenRes.json();
    const paypalToken = tokenJson && tokenJson.access_token;
    if (!paypalToken) {
      return { ok: false, reason: 'no_token', tokenJson };
    }

    // prepare verification payload
    const verificationBody = {
      auth_algo: headers['paypal-auth-algo'] || headers['paypal_auth_algo'],
      cert_url: headers['paypal-cert-url'] || headers['paypal_cert_url'],
      transmission_id: headers['paypal-transmission-id'] || headers['paypal_transmission_id'],
      transmission_sig: headers['paypal-transmission-sig'] || headers['paypal_transmission_sig'],
      transmission_time: headers['paypal-transmission-time'] || headers['paypal_transmission_time'],
      webhook_id: PAYPAL_WEBHOOK_ID,
      webhook_event: null
    };

    // try to parse raw body as JSON for webhook_event
    try {
      verificationBody.webhook_event = JSON.parse(rawBodyText);
    } catch (e) {
      // fallback: provide raw text as webhook_event.raw (PayPal expects object but we'll attempt)
      verificationBody.webhook_event = { raw: rawBodyText };
    }

    const verifyRes = await fetch(`${paypalApiBase}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${paypalToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(verificationBody)
    });

    const verifyJson = await verifyRes.json();
    if (verifyJson && (verifyJson.verification_status === 'SUCCESS' || verifyJson.verification_status === 'success')) {
      return { ok: true, verification: verifyJson };
    } else {
      return { ok: false, verification: verifyJson };
    }
  } catch (err) {
    return { ok: false, error: err?.message || err };
  }
}

// ============================================
// ROUTE: /webhook/paypal (raw body) — generic parser + idempotency + create plain claim + send email
app.post('/webhook/paypal', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  try {
    // Read raw body
    const rawBody = req.body; // Buffer or string
    let rawText = '';
    if (Buffer.isBuffer(rawBody)) rawText = rawBody.toString('utf8');
    else if (typeof rawBody === 'string') rawText = rawBody;
    else if (typeof rawBody === 'object' && rawBody !== null) {
      try { rawText = JSON.stringify(rawBody); } catch (e) { rawText = String(rawBody); }
    } else rawText = String(rawBody || '');

    // Normalize headers to lower-case access
    const headerLower = {};
    for (const k of Object.keys(req.headers || {})) headerLower[k.toLowerCase()] = req.headers[k];

    if (PAYPAL_WEBHOOK_ID) {
      const verify = await verifyPayPalSignature(rawText, {
        'paypal-auth-algo': headerLower['paypal-auth-algo'] || headerLower['paypal_auth_algo'] || headerLower['paypal-auth-algo'],
        'paypal-cert-url': headerLower['paypal-cert-url'] || headerLower['paypal_cert_url'],
        'paypal-transmission-id': headerLower['paypal-transmission-id'] || headerLower['paypal_transmission_id'],
        'paypal-transmission-sig': headerLower['paypal-transmission-sig'] || headerLower['paypal_transmission_sig'],
        'paypal-transmission-time': headerLower['paypal-transmission-time'] || headerLower['paypal_transmission_time']
      });
      if (!verify.ok) {
        await logAccess(null, 'paypal_signature_invalid', { reason: verify.reason || verify.verification || verify.error });
        console.warn('PayPal webhook signature verification failed:', verify);
        return res.status(400).send('invalid signature');
      }
    }

    // parse payload
    let payload = null;
    let parsedAs = 'unknown';
    try {
      payload = JSON.parse(rawText);
      parsedAs = 'json';
    } catch (err) {
      try {
        const urlParams = new URLSearchParams(rawText);
        const obj = {};
        for (const [k, v] of urlParams.entries()) obj[k] = v;
        if (Object.keys(obj).length > 0) {
          payload = obj;
          parsedAs = 'form';
        } else {
          if (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) {
            payload = req.body;
            parsedAs = 'object';
          } else {
            payload = { raw: rawText };
            parsedAs = 'text';
          }
        }
      } catch (err2) {
        payload = { raw: rawText };
        parsedAs = 'text';
      }
    }

    // Debug short
    try { console.log('PAYPAL WEBHOOK payload parsedAs=' + parsedAs + ':', rawText.slice(0, 1200)); } catch (e) {}

    const event = payload.event_type || payload.event || payload.type || payload.kind || null;
    const data = payload.resource || payload.data || payload || {};
    await logAccess(null, 'webhook_received', { provider: 'paypal', event, parsedAs });

    // Normalize fields (common PayPal names)
    const orderId = data.id || data.order_id || data.invoice_id || null;
    const subscriptionId = data.billing_agreement_id || data.subscription_id || null;
    const status = data.status || null;
    const productId = (data.plan_id || data.product_id || data.sku || data.item_id) || null;
    const amount = data.amount || (data.purchase_units && data.purchase_units[0] && data.purchase_units[0].amount && data.purchase_units[0].amount.value) || null;
    const currency = (data.amount && data.amount.currency) || (data.purchase_units && data.purchase_units[0] && data.purchase_units[0].amount && data.purchase_units[0].amount.currency_code) || null;
    const payer = data.payer || data.payer_info || data.customer || {};
    let email = (payer && (payer.email_address || payer.email)) ? String(payer.email_address || payer.email).trim().toLowerCase() : '';
    const payerId = payer && (payer.payer_id || payer.payerID || payer.id) ? (payer.payer_id || payer.payerID || payer.id) : '';
    // last4 detection if present
    const last4 = (data.last4 || (data.payment_source && data.payment_source.card && data.payment_source.card.last_digits) || '') || '';

    // Persist raw event (best-effort)
    await supabase
      .from('webhook_events')
      .insert([{ provider: 'paypal', order_id: orderId, subscription_id: subscriptionId, event: event || status || 'unknown', raw: rawText, parsed_as: parsedAs, received_at: new Date().toISOString() }])
      .catch(err => { console.warn('No se pudo persistir webhook_events (continuamos):', err?.message || err); });

    // Idempotency check by orderId
    if (orderId) {
      const { data: existing, error: exErr } = await supabase
        .from('webhook_events')
        .select('id, processed')
        .eq('order_id', orderId)
        .limit(1);
      if (exErr) console.warn('exErr checking webhook_events:', exErr);
      if (existing && existing.length > 0 && existing[0].processed) {
        await logAccess(null, 'webhook_duplicate_processed', { orderId });
        return res.status(200).send('already processed');
      }
    }

    const eventLower = (event || '').toString().toLowerCase();

    // Payment completed events detection (common PayPal event types include PAYMENT.CAPTURE.COMPLETED, BILLING.SUBSCRIPTION.CREATED, PAYMENT.SALE.COMPLETED)
    if (
      eventLower.includes('completed') ||
      eventLower.includes('paid') ||
      eventLower.includes('payment') ||
      eventLower.includes('sale.completed') ||
      eventLower.includes('payment.capture.completed') ||
      eventLower.includes('capture')
    ) {
      // If email missing, try to recover from PayPal order API (force mail)
      if (!email) {
        await logAccess(null, 'paypal_webhook_no_email_initial', { orderId });

        try {
          // 1. Obtener access token de PayPal
          const basicAuth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
          const paypalApiBase = (PAYPAL_ENV === 'live') ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
          const tokenRes = await fetch(`${paypalApiBase}/v1/oauth2/token`, {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${basicAuth}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials'
          });

          const tokenJson = await tokenRes.json();
          const paypalToken = tokenJson && tokenJson.access_token;
          if (!paypalToken) {
            await logAccess(null, 'paypal_webhook_no_email_failed', { orderId, reason: 'no_token', tokenJson });
            return res.status(200).send('ok_no_email');
          }

          // 2. Consultar la orden directamente en PayPal (si tenemos orderId)
          let orderDetails = null;
          if (orderId) {
            const orderRes = await fetch(`${paypalApiBase}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${paypalToken}`,
                'Content-Type': 'application/json'
              }
            }).catch(() => null);

            if (orderRes) {
              try { orderDetails = await orderRes.json(); } catch (e) { orderDetails = null; }
            }
          }

          // 3. Intentar extraer el email desde la respuesta de PayPal
          const recoveredEmail = (orderDetails && orderDetails.payer && (orderDetails.payer.email_address || orderDetails.payer.email)) || (orderDetails && orderDetails.payer_email) || '';
          if (recoveredEmail) {
            email = String(recoveredEmail).trim().toLowerCase();
            await logAccess(null, 'paypal_webhook_email_recovered', { orderId, email });
            // continuar el flujo normal usando `email`
          } else {
            await logAccess(null, 'paypal_webhook_no_email_final', { orderId });
            return res.status(200).send('ok_no_email');
          }
        } catch (err) {
          console.warn('Error recuperando email vía PayPal API:', err?.message || err);
          await logAccess(null, 'paypal_webhook_no_email_failed', { orderId, err: err?.message || err });
          return res.status(200).send('ok_no_email');
        }
      }

      try {
        // Permitimos crear nuevos claims/memberships aunque ya existan memberships activas.
        // (Esto permite compras múltiples por el mismo email.)

        // Try reuse claim by subscription/order
        const { data: existingClaims } = await supabase
          .from('claims')
          .select('*')
          .or(subscriptionId
              ? `subscription_id.eq.${subscriptionId},extra.like.%order:${orderId}%`
              : `extra.like.%order:${orderId}%`)
          .limit(1);

        let token = null;
        if (existingClaims && existingClaims.length > 0) {
          token = existingClaims[0].token;
          if (existingClaims[0].used) {
            await logAccess(null, 'webhook_claim_already_used', { email, orderId });
            return res.status(200).send('claim already used');
          }
        } else {
          // create claim (store token in plain)
          token = await createClaimToken({
            email,
            name: `${(payer.name && (payer.name.given_name || payer.name.full_name)) || ''}`,
            plan_id: productId || '',
            subscriptionId,
            customerId: payerId || '',
            last4,
            cardExpiry: data.card_expiry || '',
            paymentFingerprint: payerId || '',
            extra: { order: orderId }
          });
          // annotate claim with orderId in extra (best-effort)
          await supabase
            .from('claims')
            .update({ extra: JSON.stringify({ order: orderId }) })
            .eq('token', token)
            .catch(()=>{});
        }

        // mark webhook event processed (best-effort)
        await supabase.from('webhook_events')
          .update({ processed: true })
          .or(orderId ? `order_id.eq.${orderId}` : `subscription_id.eq.${subscriptionId}`)
          .catch(()=>{});

        // send welcome email with claim link
        sendWelcomeEmail(
          email,
          (payer && (payer.name && payer.name.given_name)) || '',
          productId || '',
          subscriptionId,
          payerId || '',
          { last4, cardExpiry: data.card_expiry || '', payment_fingerprint: payerId || '' },
          token
        )
          .then(()=> logAccess(null, 'webhook_email_dispatched', { email, orderId }))
          .catch(err => logAccess(null, 'webhook_email_failed', { email, orderId, err: err?.message || err }));

        return res.status(200).send('ok');
      } catch (err) {
        console.error('Error processing paypal webhook:', err?.message || err);
        await logAccess(null, 'webhook_processing_error', { err: err?.message || err });
        return res.status(500).send('error processing');
      }
    }

    // Cancellation / refund events: revoke role (no kick)
    if (
      eventLower.includes('cancel') ||
      eventLower.includes('refund') ||
      eventLower.includes('subscription.cancelled') ||
      eventLower.includes('subscription_revoked') ||
      eventLower.includes('subscription.canceled')
    ) {
      try {
        const lookup = subscriptionId ? { subscription_id: subscriptionId } : (orderId ? { order_id: orderId } : null);
        if (!lookup) {
          await logAccess(null, 'webhook_cancel_no_lookup', { event, orderId, subscriptionId });
          return res.status(200).send('no lookup keys');
        }
        const { data: rows } = await supabase
          .from('memberships')
          .select('*')
          .or(`subscription_id.eq.${subscriptionId},order_id.eq.${orderId}`)
          .limit(1);
        if (rows && rows.length > 0) {
          const row = rows[0];
          if (row.discord_id && row.role_id) {
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
          await supabase
            .from('memberships')
            .update({ status: 'cancelled', revoked_at: new Date().toISOString() })
            .eq('id', row.id);
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
    console.error('❌ Error general en /webhook/paypal:', err?.message || err);
    return res.status(500).send('internal error');
  }
});

// Restore express json/urlencoded for the rest of the app (moved AFTER webhook route on purpose)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// ROUTE: claim redirect
app.get('/api/auth/claim', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send('Token missing');
  try {
    const { data: rows, error } = await supabase
      .from('claims')
      .select('id,token,used')
      .eq('token', token)
      .limit(1);
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
    const discordAuthUrl =
      `https://discord.com/api/oauth2/authorize?client_id=${clientId}` +
      `&redirect_uri=${redirectUri}` +
      `&response_type=code` +
      `&scope=${scope}` +
      `&state=${encodeURIComponent(token)}` +
      `&prompt=${prompt}`;

    return res.redirect(discordAuthUrl);
  } catch (err) {
    console.error('❌ Error en /api/auth/claim:', err);
    return res.status(500).send('Error interno');
  }
});

// ============================================
// ROUTE: DISCORD CALLBACK
app.get('/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Faltan parámetros');

    // Retrieve claim row by token (plain)
    const { data: claimsRows, error: claimErr } = await supabase
      .from('claims')
      .select('*')
      .eq('token', state)
      .limit(1);
    if (claimErr) console.error('Error leyendo claim de Supabase:', claimErr);
    const claimData = (claimsRows && claimsRows[0]) ? claimsRows[0] : null;
    if (!claimData) return res.status(400).send('Sesión expirada o inválida');
    if (claimData.used) return res.status(400).send('Este enlace ya fue usado.');

    // Exchange code for token
    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: DISCORD_REDIRECT_URL
    });
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) {
      console.error('❌ Error obteniendo token:', tokenData);
      return res.status(400).send('Error de autorización');
    }

    // Get user info
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userData = await userResponse.json();
    const discordId = userData.id;
    const discordUsername = userData.username;

    // Add to guild (invite via OAuth2). Best-effort
    try {
      await fetch(`https://discord.com/api/guilds/${GUILD_ID}/members/${discordId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ access_token: tokenData.access_token })
      }).catch(err => console.warn('Invite add maybe failed:', err?.message || err));
    } catch (err) {
      console.warn('Invite to guild failed:', err?.message || err);
    }

    // Prepare authData from claim
    const authData = {
      email: claimData.email,
      name: claimData.name,
      plan_id: claimData.plan_id,
      subscription_id: claimData.subscription_id,
      customer_id: claimData.customer_id,
      last4: claimData.last4,
      card_expiry: claimData.card_expiry,
      payment_fingerprint: claimData.payment_fingerprint
    };

    // Determine role
    const roleId = (function getRoleIdForPlan(planId) {
      if (PRODUCT_ROLE_MAP[planId]) return PRODUCT_ROLE_MAP[planId];
      const planKey = detectPlanKeyFromString(planId);
      const mapping = {
        'plan_mensual': ROLE_ID_MENSUAL,
        'plan_trimestral': ROLE_ID_TRIMESTRAL,
        'plan_anual': ROLE_ID_ANUAL
      };
      return mapping[planKey] || ROLE_ID_MENSUAL;
    })(authData.plan_id);

    // Antifraude checks BEFORE inserting membership
    const email = (authData.email || '').toLowerCase().trim();
    const last4 = authData.last4 || '';
    const paymentFingerprint = authData.payment_fingerprint || '';

    // Removed blocking check: allow multiple memberships per same email (as requested)
    // check payment fingerprint conflict remains
    if (paymentFingerprint && paymentFingerprint.trim() !== '') {
      const { data: fpRows } = await supabase
        .from('memberships')
        .select('email,status')
        .eq('payment_fingerprint', paymentFingerprint)
        .eq('status','active')
        .limit(2);
      if (fpRows && fpRows.length > 0) {
        const setEmails = new Set((fpRows || []).map(r => (r.email || '').toLowerCase()));
        if (!setEmails.has(email) && setEmails.size >= 1) {
          await supabase.from('claims').update({ manual_review: true }).eq('token', state).catch(()=>{});
          await logAccess(null, 'conflict_detected', { reason: 'fingerprint_conflict', paymentFingerprint, email });
          return res.status(400).send('Conflicto: método de pago asociado a otra cuenta. Contacta soporte.');
        }
      }
    }

    // compute start_at and expires_at (30/90/365)
    const startAt = new Date();
    const planKey = detectPlanKeyFromString(authData.plan_id);
    const daysMap = { 'plan_mensual': 30, 'plan_trimestral': 90, 'plan_anual': 365 };
    const days = daysMap[planKey] || 30;
    const expiresAt = new Date(startAt.getTime() + (days * 24 * 60 * 60 * 1000));

    // Insert membership
    const membershipRow = {
      email,
      name: authData.name,
      plan_id: authData.plan_id,
      subscription_id: authData.subscription_id,
      customer_id: authData.customer_id,
      discord_id: discordId,
      discord_username: discordUsername,
      status: 'active',
      role_id: roleId,
      last4: last4 || '',
      card_expiry: authData.card_expiry || '',
      payment_fingerprint: paymentFingerprint || '',
      start_at: startAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      role_assigned: false,
      pending_role_assignment: true,
      created_at: new Date().toISOString()
    };

    try {
      const { error: insErr } = await supabase.from('memberships').insert(membershipRow);
      if (insErr) {
        console.error('❌ Error guardando en Supabase memberships:', insErr);
        await supabase.from('claims').update({ manual_review: true }).eq('token', state).catch(()=>{});
        return res.status(500).send('No se pudo crear la membresía. Contacta soporte.');
      }
      await logAccess(null, 'membership_created', { email, discordId, plan: authData.plan_id });
    } catch (err) {
      console.error('❌ Error con Supabase (memberships):', err);
      return res.status(500).send('Error interno');
    }

    // mark claim used (atomic-ish)
    await supabase
      .from('claims')
      .update({ used: true, used_at: new Date().toISOString() })
      .eq('token', state)
      .catch(err => {
        console.warn('No se pudo marcar claim como usado:', err?.message || err);
      });
    await logAccess(null, 'claim_marked_used', { token: state });

    // Assign role with retry/backoff
    let roleAssigned = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const guild = await discordClient.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(discordId);
        await member.roles.add(roleId);
        roleAssigned = true;
        await logAccess(null, 'role_assigned', { discordId, roleId });
        break;
      } catch (err) {
        console.warn(`Attempt ${attempt+1} failed assigning role:`, err?.message || err);
        await logAccess(null, 'role_assign_failed', { attempt: attempt+1, err: err?.message || err });
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
    if (roleAssigned) {
      await supabase
        .from('memberships')
        .update({ role_assigned: true, pending_role_assignment: false })
        .eq('discord_id', discordId)
        .catch(()=>{});
    } else {
      await logAccess(null, 'role_assign_permanent_fail', { discordId, roleId });
    }

    if (pendingAuths.has(state)) pendingAuths.delete(state);

    const successRedirect = FRONTEND_URL ? `${FRONTEND_URL}/gracias` : 'https://discord.gg/sXjU5ZVzXU';
    return res.send(`
      <!DOCTYPE html><html><head><meta charset="UTF-8"><title>¡Bienvenido!</title></head>
      <body style="font-family:Arial,Helvetica,sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="background:rgba(255,255,255,0.08);padding:32px;border-radius:12px;text-align:center;">
          <h1>🎉 ¡Bienvenido!</h1>
          <p>Tu rol ha sido asignado correctamente. Serás redirigido en unos segundos...</p>
          <a href="${successRedirect}" style="display:inline-block;margin-top:12px;padding:12px 20px;border-radius:8px;background:#fff;color:#667eea;text-decoration:none;font-weight:bold;">Ir a Discord</a>
        </div>
        <script>setTimeout(()=>{ window.location.href='${successRedirect}' }, 3000);</script>
      </body></html>`);
  } catch (error) {
    console.error('❌ Error en callback:', error?.message || error);
    return res.status(500).send('Error procesando la autorización');
  }
});

// ============================================
// Background jobs: expirations and pending role retries
const JOB_INTERVAL_MS = (process.env.JOB_INTERVAL_MS && Number(process.env.JOB_INTERVAL_MS)) || (5 * 60 * 1000);

async function processExpirations() {
  try {
    const { data: rows } = await supabase
      .from('memberships')
      .select('*')
      .lt('expires_at', new Date().toISOString())
      .eq('status', 'active')
      .limit(100);
    if (!rows || rows.length === 0) return;
    for (const r of rows) {
      try {
        if (r.discord_id && r.role_id) {
          try {
            const guild = await discordClient.guilds.fetch(GUILD_ID);
            const member = await guild.members.fetch(r.discord_id);
            await member.roles.remove(r.role_id).catch(e => { throw e; });
            await logAccess(r.id, 'role_removed_on_expiry', { discord_id: r.discord_id, role_id: r.role_id });
          } catch (err) {
            console.warn('Could not remove role on expiry:', err?.message || err);
            await logAccess(r.id, 'role_remove_expiry_failed', { err: err?.message || err });
          }
        }
        await supabase.from('memberships').update({ status: 'expired', expired_at: new Date().toISOString(), role_assigned: false }).eq('id', r.id);
      } catch (err) {
        console.warn('Error processing expiry for membership', r.id, err?.message || err);
      }
    }
  } catch (err) {
    console.error('Error in processExpirations job:', err?.message || err);
  }
}

async function retryPendingRoleAssignments() {
  try {
    const { data: rows } = await supabase
      .from('memberships')
      .select('*')
      .eq('pending_role_assignment', true)
      .eq('status', 'active')
      .limit(100);
    if (!rows || rows.length === 0) return;
    for (const r of rows) {
      try {
        if (!r.discord_id || !r.role_id) continue;
        try {
          const guild = await discordClient.guilds.fetch(GUILD_ID);
          const member = await guild.members.fetch(r.discord_id);
          await member.roles.add(r.role_id);
          await supabase.from('memberships').update({ role_assigned: true, pending_role_assignment: false }).eq('id', r.id);
          await logAccess(r.id, 'role_reassigned_by_job', { discord_id: r.discord_id, role_id: r.role_id });
        } catch (err) {
          console.warn('Retry assign failed for', r.id, err?.message || err);
          await logAccess(r.id, 'role_reassign_failed', { err: err?.message || err });
        }
      } catch (err) {
        console.warn('Error in retry loop:', err?.message || err);
      }
    }
  } catch (err) {
    console.error('Error in retryPendingRoleAssignments job:', err?.message || err);
  }
}

setInterval(() => {
  processExpirations();
  retryPendingRoleAssignments();
}, JOB_INTERVAL_MS);

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
