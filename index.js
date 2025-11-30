// server.js - NAZA Bot (versión revisada y con lógica WHOP+Discord)
// Requisitos: Node >= 18 recomendado (por global.fetch), instalar dependencias:
// npm i express body-parser @supabase/supabase-js discord.js @sendgrid/mail helmet express-rate-limit

const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');

const app = express();

// ============================================
// CONFIG / ENV
const FRONTEND_TOKEN = process.env.FRONTEND_TOKEN;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL;
const GUILD_ID = process.env.GUILD_ID;

const ROLE_ID_MENSUAL = process.env.ROLE_ID_MENSUAL || process.env.ROLE_ID_SENALESDISCORD || process.env.ROLE_ID_MENSUAL_DISCORD || null;
const ROLE_ID_TRIMESTRAL = process.env.ROLE_ID_TRIMESTRAL || process.env.ROLE_ID_MENTORIADISCORD || process.env.ROLE_ID_TRIMESTRAL_DISCORD || null;
const ROLE_ID_ANUAL = process.env.ROLE_ID_ANUAL || process.env.ROLE_ID_ANUALDISCORD || process.env.ROLE_ID_ANUAL_DISCORD || null;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'soporte@nazaacademy.com';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || FROM_EMAIL;
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const BOT_URL = process.env.BOT_URL || BASE_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || '';
const WHOP_WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET || '';
const WHOP_API_KEY = process.env.WHOP_API_KEY || '';
const JWT_SIGNING_SECRET = process.env.JWT_SIGNING_SECRET || '';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Fail-fast (en producción) si faltan envs críticas
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE', 'WHOP_WEBHOOK_SECRET'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length > 0) {
  const msg = `❌ Faltan ENV obligatorias: ${missing.join(', ')}`;
  if (NODE_ENV === 'production') {
    console.error(msg);
    process.exit(1);
  } else {
    console.warn(msg);
  }
}

// ============================================
// MIDDLEWARES GENERALES (ANTES del JSON parser)
app.use(helmet());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Utiles globales
const pendingAuths = new Map();

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function emailSafe(e){ return e || ''; }

// CORS Dinámico (compat con credentials)
// NOTA: en producción define ALLOWED_ORIGINS explícitamente
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');

  if (origin) {
    if (ALLOWED_ORIGINS.length === 0) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      if (ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
    }
  } else {
    if (ALLOWED_ORIGINS.length === 0) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-frontend-token, x-signature, x-whop-signature');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

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
// SUPABASE CLIENT
let supabase = null;
try {
  supabase = createClient(SUPABASE_URL || '', SUPABASE_SERVICE_ROLE || '', {
    global: {
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE || ''}`,
        apikey: SUPABASE_SERVICE_ROLE || ''
      }
    }
  });
} catch (e) {
  console.warn('⚠️ No se pudo inicializar Supabase:', e?.message || e);
}

// SENDGRID
if (!SENDGRID_API_KEY) {
  console.warn('⚠️ SENDGRID_API_KEY no definido. Los correos no podrán enviarse.');
} else {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

// DISCORD CLIENT (opcional)
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
if (DISCORD_BOT_TOKEN) {
  discordClient.login(DISCORD_BOT_TOKEN).catch(err => {
    console.error('❌ Error login Discord bot:', err?.message || err);
  });
  discordClient.once('ready', () => {
    console.log('✅ Discord bot conectado:', discordClient.user?.tag || '(sin tag aún)');
  });
} else {
  console.log('ℹ️ DISCORD_BOT_TOKEN no definido: el cliente Discord no se conectará.');
}

// ============================================
// ACCESS LOG helper (seguro)
async function logAccess(membership_id = null, event_type = 'generic', detail = {}) {
  try {
    if (!supabase) throw new Error('Supabase no inicializado');
    await supabase.from('access_logs').insert([{
      membership_id,
      event_type,
      detail: JSON.stringify(detail || {}),
      created_at: new Date().toISOString()
    }]);
  } catch (err) {
    console.warn('⚠️ No se pudo insertar access_log:', err?.message || err);
  }
}

// ============================================
// Funciones de ayuda para memberships / Discord

async function findMembership({ customerId, subscriptionId, email }) {
  if (!supabase) return null;
  try {
    // 1) customer_id
    if (customerId) {
      const { data, error } = await supabase
        .from('memberships')
        .select('id, email, discord_id, plan_id')
        .eq('customer_id', customerId)
        .limit(1);
      if (!error && data && data.length) return data[0];
    }
    // 2) subscription_id
    if (subscriptionId) {
      const { data, error } = await supabase
        .from('memberships')
        .select('id, email, discord_id, plan_id')
        .eq('subscription_id', subscriptionId)
        .limit(1);
      if (!error && data && data.length) return data[0];
    }
    // 3) email
    if (email) {
      const { data, error } = await supabase
        .from('memberships')
        .select('id, email, discord_id, plan_id')
        .eq('email', email.toLowerCase())
        .limit(1);
      if (!error && data && data.length) return data[0];
    }
  } catch (e) {
    console.warn('findMembership error:', e?.message || e);
  }
  return null;
}

// Detectar rol Discord según plan_id
function resolveRoleIdForPlan(plan_id) {
  if (!plan_id) return null;
  const p = String(plan_id).toLowerCase();
  if (p.includes('anual') || p.includes('year') || p.includes('annual') || p === 'plan_anual') {
    return ROLE_ID_ANUAL;
  }
  if (p.includes('trimes') || p.includes('quarter') || p === 'plan_trimestral') {
    return ROLE_ID_TRIMESTRAL;
  }
  // por defecto todo lo que parezca mensual
  if (p.includes('mensual') || p.includes('month') || p === 'plan_mensual') {
    return ROLE_ID_MENSUAL;
  }
  return null;
}

async function grantRoleInDiscord({ discord_id, plan_id, event }) {
  if (!discordClient || !DISCORD_BOT_TOKEN || !GUILD_ID) {
    console.warn('Discord no configurado correctamente, no se puede dar rol.');
    return;
  }
  if (!discord_id) {
    console.warn('Membership sin discord_id, no se puede dar rol.');
    return;
  }
  try {
    const guild = await discordClient.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discord_id).catch(() => null);
    if (!member) {
      console.warn('Miembro de Discord no encontrado para dar rol:', discord_id);
      return;
    }

    const roleId = resolveRoleIdForPlan(plan_id) || ROLE_ID_MENSUAL || ROLE_ID_TRIMESTRAL || ROLE_ID_ANUAL;
    if (!roleId) {
      console.warn('No hay ROLE_ID configurado para el plan_id:', plan_id);
      return;
    }

    if (!member.roles.cache.has(roleId)) {
      await member.roles.add(roleId).catch(err => {
        console.warn('No se pudo agregar rol:', roleId, err?.message || err);
      });
      console.log(`✅ Rol ${roleId} agregado a ${discord_id} por evento ${event}`);
    } else {
      console.log(`ℹ️ ${discord_id} ya tenía el rol ${roleId}`);
    }
  } catch (err) {
    console.error('Error grantRoleInDiscord:', err?.message || err);
  }
}

async function revokeRolesInDiscord({ discord_id, event }) {
  if (!discordClient || !DISCORD_BOT_TOKEN || !GUILD_ID) {
    console.warn('Discord no configurado correctamente, no se puede quitar rol.');
    return;
  }
  if (!discord_id) {
    console.warn('Membership sin discord_id, no se puede quitar rol.');
    return;
  }
  try {
    const guild = await discordClient.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discord_id).catch(() => null);
    if (!member) {
      console.warn('Miembro de Discord no encontrado para quitar rol:', discord_id);
      return;
    }

    const rolesToTry = [ROLE_ID_MENSUAL, ROLE_ID_TRIMESTRAL, ROLE_ID_ANUAL].filter(Boolean);
    for (const rid of rolesToTry) {
      if (member.roles.cache.has(rid)) {
        await member.roles.remove(rid).catch(err => {
          console.warn('No se pudo remover rol', rid, err?.message || err);
        });
      }
    }
    console.log(`✅ Roles de acceso revocados a ${discord_id} por evento ${event}`);
  } catch (err) {
    console.error('Error revokeRolesInDiscord:', err?.message || err);
  }
}

// ============================================
// createClaimToken (igual que tenías)
async function createClaimToken({ email, name, plan_id, subscriptionId, customerId, last4, cardExpiry, extra = {} }) {
  email = (email || '').trim().toLowerCase();
  if (!email) throw new Error('Email requerido para crear claim');

  if (!supabase) throw new Error('Servicio no disponible');

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

  const token = crypto.randomBytes(24).toString('hex');
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
    const msg = (insertErr && insertErr.message) || '';
    if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('duplicate')) {
      throw new Error('Existe ya una solicitud para este correo. Revisa tu email.');
    }
    throw new Error('No se pudo crear el claim');
  }
  await logAccess(null, 'claim_created', { email, plan_id, token_created: true });
  return token;
}

// ============================================
// WEBHOOK: WHOP (raw bytes para HMAC)
app.post('/webhook/whop', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

    // Logs simples para que tú veas qué manda WHOP
    console.log('FIRMA WHOP:', req.headers['x-whop-signature'] || req.headers['x-signature']);
    console.log('PAYLOAD WHOP (inicio):', rawBody.toString('utf8').slice(0, 400));

    // Normalizar header de firma
    let signatureHeader = (req.headers['x-whop-signature'] || req.headers['x-signature'] || '').toString();
    signatureHeader = signatureHeader.replace(/^sha256=/i, '')
                                     .replace(/^sha1=/i, '')
                                     .replace(/^v[0-9]+=|^signature=/i, '')
                                     .trim();

    if (!WHOP_WEBHOOK_SECRET) {
      console.error('WHOP_WEBHOOK_SECRET no configurado');
      return res.status(500).send('Server misconfigured');
    }
    if (!signatureHeader) {
      console.warn('Webhook sin signature header');
      await logAccess(null, 'webhook_no_signature', {});
      return res.status(401).send('No signature');
    }

    // Intentar decodificar header: hex o base64
    let headerBuf = null;
    try {
      headerBuf = Buffer.from(signatureHeader, 'hex');
      if (headerBuf.length !== 32) {
        headerBuf = Buffer.from(signatureHeader, 'base64');
      }
    } catch (e) {
      try {
        headerBuf = Buffer.from(signatureHeader, 'base64');
      } catch (e2) {
        console.warn('Signature header formato inválido (ni hex ni base64)');
        await logAccess(null, 'webhook_invalid_signature_format', { header_sample: signatureHeader.slice(0,8) });
        return res.status(401).send('Invalid signature format');
      }
    }

    const computed = crypto.createHmac('sha256', WHOP_WEBHOOK_SECRET).update(rawBody).digest();

    if (computed.length !== headerBuf.length) {
      console.warn('Signature length mismatch');
      await logAccess(null, 'webhook_invalid_signature_length', { header_sample: signatureHeader.slice(0,8) });
      return res.status(401).send('Invalid signature');
    }

    const signatureMatches = crypto.timingSafeEqual(computed, headerBuf);
    if (!signatureMatches) {
      console.warn('Firma webhook inválida (muestra):', signatureHeader.slice(0,8));
      await logAccess(null, 'webhook_invalid_signature', { header_sample: signatureHeader.slice(0,8) });
      return res.status(401).send('Invalid signature');
    }

    // Parse payload
    let payload = {};
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (parseErr) {
      payload = req.body || {};
    }

    const event = payload.event || payload.type || payload.kind || (payload.data && payload.data.event) || null;
    const data = payload.data || payload || {};

    // Extraer IDs típicos de WHOP
    const customerId = data.customer_id || data.customer?.id || data.user_id || null;
    const subscriptionId = data.subscription_id || data.subscription?.id || null;
    const email = data.customer?.email || data.email || null;

    await logAccess(null, 'webhook_received', { event, customerId, subscriptionId, email });

    // Eventos para DAR acceso
    const grantEvents = new Set([
      'subscription.created',
      'subscription.activated',
      'subscription.started',
      'access.granted'
    ]);

    // Eventos para QUITAR acceso
    const revokeEvents = new Set([
      'subscription.deleted',
      'subscription.canceled',
      'subscription.cancelled',
      'subscription.ended',
      'invoice.refund',
      'refund.created'
    ]);

    const status = String(
      data.status ||
      (data.subscription && data.subscription.status) ||
      ''
    ).toLowerCase();

    const isRevokeByStatus = (
      event === 'subscription.updated' ||
      event === 'subscription.status_changed'
    ) && ['canceled','cancelled','expired','past_due'].includes(status);

    const isGrant = grantEvents.has(event);
    const isRevoke = revokeEvents.has(event) || isRevokeByStatus;

    if (isGrant || isRevoke) {
      const membership = await findMembership({ customerId, subscriptionId, email });
      if (!membership) {
        console.warn('No se encontró membership para WHOP:', { customerId, subscriptionId, email });
        await logAccess(null, 'webhook_no_membership_found', { event, customerId, subscriptionId, email });
      } else {
        // DAR ACCESO
        if (isGrant) {
          await grantRoleInDiscord({ discord_id: membership.discord_id, plan_id: membership.plan_id, event });
          await logAccess(membership.id, 'access_granted', { event, membership_id: membership.id });
        }
        // QUITAR ACCESO
        if (isRevoke) {
          await revokeRolesInDiscord({ discord_id: membership.discord_id, event });
          await logAccess(membership.id, 'access_revoked', { event, membership_id: membership.id });
        }
      }
    } else {
      await logAccess(null, 'webhook_ignored_event', { event });
    }

    return res.status(200).send('ok');
  } catch (err) {
    console.error('❌ Error general en /webhook/whop:', err?.message || err);
    return res.status(500).send('internal error');
  }
});

// ============================================
// AHORA sí parse JSON para el RESTO de rutas
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Liveness endpoint
app.get('/health', (req, res) => {
  return res.status(200).json({ ok: true, uptime: process.uptime(), ts: new Date().toISOString() });
});

// Manejo global de errores del proceso
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
});

// START SERVER
app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 NAZA Bot - servidor iniciado');
  console.log('🌐 Puerto:', PORT);
  console.log('🔗 URL:', BASE_URL);
});
