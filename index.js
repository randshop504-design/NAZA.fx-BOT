// index_whop_with_naza_email.js
// Node >=18 required
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
const fetch = global.fetch || require('node-fetch');
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
const ROLE_ID_ANUALDISCORD = process.env.ROLE_ID_ANUALDISCORD;
const ROLE_ID_MENTORIADISCORD = process.env.ROLE_ID_MENTORIADISCORD;
const ROLE_ID_SENALESDISCORD = process.env.ROLE_ID_SENALESDISCORD;
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

  // mensual
  if (
    txt.includes('plan_mensual') ||
    txt.includes('mensual') ||
    txt.includes('monthly') ||
    txt.includes('mes') ||
    txt.includes('30 dias') ||
    txt.includes('30 días')
  ) return 'plan_mensual';

  // trimestral
  if (
    txt.includes('plan_trimestral') ||
    txt.includes('trimestral') ||
    txt.includes('quarter') ||
    txt.includes('3 meses') ||
    txt.includes('90 dias') ||
    txt.includes('90 días')
  ) return 'plan_trimestral';

  // anual
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
// CLAIMS + VALIDATIONS (createClaimToken adapted, con lógica de re-compra tras cancelación)
async function createClaimToken({ email, name, plan_id, subscriptionId, customerId, last4, cardExpiry, extra = {} }) {
  email = (email || '').trim().toLowerCase();
  if (!email) throw new Error('Email requerido para crear claim');

  // 1) verificar membership existente SOLO si está activa
  const { data: existingMembership, error: memErr } = await supabase
    .from('memberships')
    .select('id, status')
    .eq('email', email)
    .eq('status', 'active')
    .limit(1);
  if (memErr) {
    console.error('Error consultando memberships:', memErr);
    if (memErr.code === 'PGRST205' || (memErr.message && memErr.message.includes('Could not find the table'))) {
      console.error('ERROR: Parece que la tabla "memberships" no existe o la service role key está mal.');
    }
    throw new Error('Error interno');
  }
  if (existingMembership && existingMembership.length > 0) {
    throw new Error('Este correo ya está registrado');
  }

  // 2) verificar claim pendiente (solo used = false)
  const { data: existingClaimsForEmail, error: claimErr } = await supabase
    .from('claims')
    .select('id, used')
    .eq('email', email)
    .eq('used', false)
    .limit(1);
  if (claimErr) {
    console.error('Error consultando claims por email:', claimErr);
    throw new Error('Error interno');
  }
  if (existingClaimsForEmail && existingClaimsForEmail.length > 0) {
    throw new Error('Existe ya una solicitud para este correo. Revisa tu email.');
  }

  // 3) verificar uso de tarjeta (no permitir >2 correos distintos entre memberships activas y claims pendientes)
  if (last4 && last4.toString().trim() !== '') {
    const [{ data: mRows, error: mErr }, { data: cRows, error: cErr }] = await Promise.all([
      supabase
        .from('memberships')
        .select('email, status')
        .eq('last4', last4)
        .eq('card_expiry', cardExpiry || '')
        .eq('status', 'active'),
      supabase
        .from('claims')
        .select('email, used')
        .eq('last4', last4)
        .eq('card_expiry', cardExpiry || '')
        .eq('used', false)
    ]);
    if (mErr) console.warn('mErr checking card:', mErr);
    if (cErr) console.warn('cErr checking card:', cErr);
    const distinctEmails = new Set();
    (mRows || []).forEach(r => { if (r.email) distinctEmails.add(String(r.email).toLowerCase()); });
    (cRows || []).forEach(r => { if (r.email) distinctEmails.add(String(r.email).toLowerCase()); });
    distinctEmails.delete('');
    if (distinctEmails.size >= 2 && !distinctEmails.has(email)) {
      throw new Error('Esta tarjeta ya está asociada a dos cuentas distintas. Contacta soporte.');
    }
  }

  // Recheck quick to reduce race (mismas reglas: solo active + claims pendientes)
  const [{ data: recheckMembership }, { data: recheckClaim }] = await Promise.all([
    supabase
      .from('memberships')
      .select('id, status')
      .eq('email', email)
      .eq('status', 'active')
      .limit(1),
    supabase
      .from('claims')
      .select('id,used')
      .eq('email', email)
      .eq('used', false)
      .limit(1)
  ]);
  if (recheckMembership && recheckMembership.length > 0) throw new Error('Este correo ya está registrado');
  if (recheckClaim && recheckClaim.length > 0) throw new Error('Existe ya una solicitud para este correo. Revisa tu email.');

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
// --- REPLACED: long NAZA template (HTML + text) integrated here ---
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
  return `Hola ${name || 'usuario'}, ¡Bienvenido a NAZA Trading Academy!

Tu suscripción ha sido activada correctamente.

Entrega del servicio:
Todos los privilegios de tu plan —cursos, clases en vivo, análisis y canales exclusivos— se entregan a través de Discord. Al pulsar "Obtener acceso" se te asignará automáticamente el rol correspondiente y se desbloquearán los canales de tu plan.

Únete a la comunidad:
Para anuncios oficiales, horarios de clases y unirte a los chats (WhatsApp y Telegram), visita: https://nazatradingacademy.com

Si no tienes Discord:
- Descargar Discord: https://discord.com/download
- Cómo crear una cuenta (ES): https://youtu.be/-qgmEy1XjMg?si=vqXGRkIid-kgTCTr

Enlace para obtener acceso (un solo uso — válido hasta completar registro):
${claimUrl}

Detalles:
Plan: ${planName}
ID de suscripción: ${subscriptionId || ''}
Email: ${email || ''}

Soporte: ${supportEmail || SUPPORT_EMAIL || 'support@nazatradingacademy.com'}

Nota: El enlace es de un solo uso y funcionará hasta que completes el proceso en Discord.`;
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
// ROUTE: /webhook/whop (signature verification REMOVED)
app.post('/webhook/whop', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const rawBody = req.body; // Buffer
    // NOTE: signature verification intentionally removed per request.
    if (!rawBody || rawBody.length === 0) {
      await logAccess(null, 'webhook_empty_body', {});
      return res.status(400).send('Empty body');
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      console.error('Webhook: invalid JSON body', err?.message || err);
      await logAccess(null, 'webhook_invalid_json', {});
      return res.status(400).send('Invalid JSON');
    }

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
      const { data: existing, error: exErr } = await supabase
        .from('webhook_events')
        .select('id')
        .eq('order_id', orderId)
        .limit(1);
      if (exErr) console.warn('exErr checking webhook_events:', exErr);
      if (existing && existing.length > 0) {
        // Already received — respond 200
        await logAccess(null, 'webhook_duplicate', { orderId });
        return res.status(200).send('already processed');
      }
      // persist basic event to avoid races
      await supabase
        .from('webhook_events')
        .insert([{ order_id: orderId, subscription_id: subscriptionId, event: event || status || 'unknown', raw: payload, received_at: new Date().toISOString() }])
        .catch(err => { console.warn('No se pudo persistir webhook_events (continuamos):', err?.message || err); });
    }

    const eventLower = (event || '').toString().toLowerCase();

    // Handle main events: pago completado / membership activada
    if (
      eventLower.includes('payment_succeeded') ||
      eventLower.includes('order.paid') ||
      eventLower.includes('order_paid') ||
      eventLower.includes('membership_activated') ||
      eventLower.includes('payment_succeeded_v2') ||
      eventLower.includes('paid')
    ) {
      // ✅ EMAIL ES EL ÚNICO REQUISITO FIJO
      if (!email) {
        await logAccess(null, 'webhook_missing_email', { orderId, subscriptionId });
        return res.status(400).send('Missing email');
      }

      try {
        // Idempotencia por email: si ya hay membership activa, no hacemos nada
        const { data: members, error: memErr } = await supabase
          .from('memberships')
          .select('id,status')
          .eq('email', email)
          .limit(1);
        if (memErr) console.warn('memErr checking membership in webhook:', memErr);
        if (members && members.length > 0 && members[0].status === 'active') {
          await logAccess(null, 'webhook_noop_member_already_active', { email, orderId });
          return res.status(200).send('member already active');
        }

        // Intentar reusar claim por subscription/order o crear uno nuevo
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
          // crear claim (plan_id = productId opcional)
          token = await createClaimToken({
            email,
            name: buyer.full_name || buyer.name || '',
            plan_id: productId || '',
            subscriptionId,
            customerId: buyer.id || '',
            last4,
            cardExpiry: data.card_expiry || '',
            extra: { order: orderId }
          });
          // anotar orderId en extra (best-effort)
          await supabase
            .from('claims')
            .update({ extra: JSON.stringify({ order: orderId }) })
            .eq('token', token)
            .catch(()=>{});
        }

        // enviar email con link de activación (Discord OAuth + claim de un solo uso)
        sendWelcomeEmail(
          email,
          buyer.full_name || '',
          productId || '',
          subscriptionId,
          buyer.id || '',
          { last4, cardExpiry: data.card_expiry || '' },
          token
        )
          .then(()=> logAccess(null, 'webhook_email_dispatched', { email, orderId }))
          .catch(err => logAccess(null, 'webhook_email_failed', { email, orderId, err: err?.message || err }));

        return res.status(200).send('ok');
      } catch (err) {
        console.error('Error processing payment_succeeded webhook:', err?.message || err);
        await logAccess(null, 'webhook_processing_error', { err: err?.message || err });
        return res.status(500).send('error processing');
      }
    }

    // cancellation / deactivation → quitar rol (no kick)
    if (
      eventLower.includes('subscription.cancelled') ||
      eventLower.includes('subscription_cancelled') ||
      eventLower.includes('membership_deactivated') ||
      eventLower.includes('order_refunded') ||
      eventLower.includes('cancel')
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
          // revoke role if exists (sin sacar al usuario del servidor)
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
          // update membership status
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
    console.error('❌ Error general en /webhook/whop:', err?.message || err);
    return res.status(500).send('internal error');
  }
});

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
// ROUTE: DISCORD CALLBACK (improved checks + idempotency)
app.get('/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Faltan parámetros');

    // Retrieve auth data from pendingAuths or claims
    let authData = pendingAuths.get(state);
    let claimData = null;
    if (!authData) {
      const { data: claimsRows, error: claimErr } = await supabase
        .from('claims')
        .select('*')
        .eq('token', state)
        .limit(1);
      if (claimErr) console.error('Error leyendo claim de Supabase:', claimErr);
      else if (claimsRows && claimsRows.length > 0) claimData = claimsRows[0];
      if (claimData) {
        if (claimData.used) return res.status(400).send('Este enlace ya fue usado.');
        authData = {
          email: claimData.email,
          name: claimData.name,
          plan_id: claimData.plan_id,
          subscription_id: claimData.subscription_id,
          customer_id: claimData.customer_id,
          last4: claimData.last4,
          card_expiry: claimData.card_expiry
        };
      }
    }
    if (!authData) return res.status(400).send('Sesión expirada o inválida');

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

    // Add to guild (invite via OAuth2). Best-effort (may fail if already in guild)
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

    // Determine role basado en CUALQUIER texto del plan/producto
    const roleId = (function getRoleIdForPlan(planId) {
      const planKey = detectPlanKeyFromString(planId);
      const mapping = {
        'plan_mensual': ROLE_ID_SENALESDISCORD,
        'plan_trimestral': ROLE_ID_MENTORIADISCORD,
        'plan_anual': ROLE_ID_ANUALDISCORD
      };
      return mapping[planKey] || ROLE_ID_SENALESDISCORD;
    })(authData.plan_id);

    // BEFORE inserting: check conflicts (email/clan/last4) among active memberships
    const email = (authData.email || '').toLowerCase().trim();
    const last4 = authData.last4 || '';
    // check email conflict
    const { data: existingByEmail } = await supabase
      .from('memberships')
      .select('id,status')
      .eq('email', email)
      .eq('status','active')
      .limit(1);
    if (existingByEmail && existingByEmail.length > 0) {
      await logAccess(null, 'conflict_detected', { reason: 'email_active', email });
      await supabase.from('claims').update({ manual_review: true }).eq('token', state).catch(()=>{});
      return res.status(400).send('Conflicto: este correo ya tiene una membresía activa. Contacta soporte.');
    }
    // check last4 conflict
    if (last4 && last4.trim() !== '') {
      const { data: last4Rows } = await supabase
        .from('memberships')
        .select('email,status')
        .eq('last4', last4)
        .eq('status','active')
        .limit(2);
      if (last4Rows && last4Rows.length > 0) {
        const setEmails = new Set((last4Rows || []).map(r => (r.email || '').toLowerCase()));
        if (!setEmails.has(email) && setEmails.size >= 1) {
          await logAccess(null, 'conflict_detected', { reason: 'last4_conflict', last4, email });
          await supabase.from('claims').update({ manual_review: true }).eq('token', state).catch(()=>{});
          return res.status(400).send('Conflicto: tarjeta asociada a otra cuenta. Contacta soporte.');
        }
      }
    }

    // No conflicts detected -> proceed to insert membership
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
      last4: authData.last4 || '',
      card_expiry: authData.card_expiry || '',
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

    // mark claim used (if claim existed)
    if (claimData) {
      await supabase
        .from('claims')
        .update({ used: true, used_at: new Date().toISOString() })
        .eq('token', state)
        .catch(err => {
          console.warn('No se pudo marcar claim como usado:', err?.message || err);
        });
      await logAccess(null, 'claim_marked_used', { token: state });
    }

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
    if (!roleAssigned) {
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
