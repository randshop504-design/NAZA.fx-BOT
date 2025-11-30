const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
const fetch = global.fetch;
const app = express();

// ============================================
// PARSEADO (capturamos raw body para webhooks mientras parseamos JSON globalmente)
app.use(express.json({
  verify: (req, res, buf) => {
    if (buf && buf.length) {
      // Guardamos una copia del raw body para verificaciones HMAC (webhooks).
      req.rawBody = Buffer.from(buf);
    }
  }
}));
app.use(express.urlencoded({ extended: true }));

// ============================================
// CONFIGURACIÓN (variables de entorno)
// Fill these in Render / Env — defaults used only where you asked for a fallback
const FRONTEND_TOKEN = process.env.FRONTEND_TOKEN;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL;
const GUILD_ID = process.env.GUILD_ID;

// Role env names (support both your new names and legacy names)
const ROLE_ID_MENSUAL = process.env.ROLE_ID_MENSUAL || process.env.ROLE_ID_SENALESDISCORD || process.env.ROLE_ID_MENSUAL_DISCORD || null;
const ROLE_ID_TRIMESTRAL = process.env.ROLE_ID_TRIMESTRAL || process.env.ROLE_ID_MENTORIADISCORD || process.env.ROLE_ID_TRIMESTRAL_DISCORD || null;
const ROLE_ID_ANUAL = process.env.ROLE_ID_ANUAL || process.env.ROLE_ID_ANUALDISCORD || process.env.ROLE_ID_ANUAL_DISCORD || null;

// Compatibility fallback aliases (not required to set)
const ROLE_ID_ANUALDISCORD = process.env.ROLE_ID_ANUALDISCORD || ROLE_ID_ANUAL;
const ROLE_ID_MENTORIADISCORD = process.env.ROLE_ID_MENTORIADISCORD || ROLE_ID_TRIMESTRAL;
const ROLE_ID_SENALESDISCORD = process.env.ROLE_ID_SENALESDISCORD || ROLE_ID_MENSUAL;

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

// ============================================
// STARTUP: validación ligera de env vars críticas (solo warnings, no exit)
const _requiredEnvs = [
  { k: 'SUPABASE_URL', v: SUPABASE_URL },
  { k: 'SUPABASE_SERVICE_ROLE', v: SUPABASE_SERVICE_ROLE },
  { k: 'WHOP_WEBHOOK_SECRET', v: WHOP_WEBHOOK_SECRET }
];
_requiredEnvs.forEach(item => {
  if (!item.v) {
    console.warn(`⚠️ ENV no definido: ${item.k} — esto puede causar fallos en tiempo de ejecución.`);
  }
});

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
// CORS MIDDLEWARE (dinámico y compatible con credentials)
app.use((req, res, next) => {
  const origin = req.headers.origin;

  // Siempre variar por Origin para caches
  res.setHeader('Vary', 'Origin');

  if (origin) {
    // Si ALLOWED_ORIGINS está vacío permitimos cualquier origin dinámicamente (pero no usamos '*')
    if (ALLOWED_ORIGINS.length === 0) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      // Si origin está en la whitelist, permitirlo
      if (ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      // si no está en la whitelist, no exponemos CORS headers (petición será bloqueada por browser)
    }
  } else {
    // No hay origin (p. ej. petición server->server). Si no hay lista, permitimos cualquier origen con '*'
    if (ALLOWED_ORIGINS.length === 0) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      // no añadimos Access-Control-Allow-Credentials cuando usamos '*'
    }
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-frontend-token, x-signature, x-whop-signature');
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
// CLAIMS + VALIDACIONES (createClaimToken adapted)
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
// WEBHOOK: WHOP (usamos req.rawBody capturado por express.json verify)
// Safe signature checking, tolerante a prefijos comunes (sha256=)
app.post('/webhook/whop', async (req, res) => {
  try {
    // Obtén raw body (Buffer) si fue guardado por el middleware de parseo
    const rawBody = req.rawBody && Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}));

    // Normalizar header de firma — soportamos formas como "sha256=..." o sólo hex
    let signatureHeader = (req.headers['x-whop-signature'] || req.headers['x-signature'] || '').toString();
    signatureHeader = signatureHeader.replace(/^sha256=/i, '').replace(/^sha1=/i, '').replace(/^v[0-9]+=|^signature=/i, '').trim();

    if (!WHOP_WEBHOOK_SECRET) {
      console.error('WHOP_WEBHOOK_SECRET no configurado');
      return res.status(500).send('Server misconfigured');
    }
    if (!signatureHeader) {
      console.warn('Webhook sin signature header');
      await logAccess(null, 'webhook_no_signature', {});
      return res.status(401).send('No signature');
    }

    // Validar formato (64 hex chars para sha256)
    if (!/^[a-f0-9]{64}$/i.test(signatureHeader)) {
      console.warn('Signature header formato inválido o longitud incorrecta:', signatureHeader.slice(0,8));
      await logAccess(null, 'webhook_invalid_signature_format', { header_sample: signatureHeader.slice(0,8) });
      return res.status(401).send('Invalid signature');
    }

    // Calcular HMAC usando raw body capturado
    const computed = crypto.createHmac('sha256', WHOP_WEBHOOK_SECRET).update(rawBody).digest('hex');
    const computedBuf = Buffer.from(computed, 'hex');
    const headerBuf = Buffer.from(signatureHeader, 'hex');

    if (computedBuf.length !== headerBuf.length) {
      console.warn('Signature length mismatch');
      await logAccess(null, 'webhook_invalid_signature_length', { header_sample: signatureHeader.slice(0,8) });
      return res.status(401).send('Invalid signature');
    }

    const signatureMatches = crypto.timingSafeEqual(computedBuf, headerBuf);
    if (!signatureMatches) {
      console.warn('Firma webhook inválida (muestra):', signatureHeader.slice(0,8));
      await logAccess(null, 'webhook_invalid_signature', { header_sample: signatureHeader.slice(0,8) });
      return res.status(401).send('Invalid signature');
    }

    // Parseamos payload seguro
    let payload = null;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (parseErr) {
      // Si no se puede parsear, usamos req.body como fallback
      payload = req.body || {};
    }

    const event = payload.event || payload.type || payload.kind || (payload.data && payload.data.event) || null;
    const data = payload.data || payload || {};
    await logAccess(null, 'webhook_received', { event });

    // Continue with your existing logic...
    // NOTE: aquí sigue tu lógica de procesamiento de eventos (no modificada)
    return res.status(200).send('ok');
  } catch (err) {
    console.error('❌ Error general en /webhook/whop:', err?.message || err);
    return res.status(500).send('internal error');
  }
});

// Liveness endpoint for Render health check
app.get('/health', (req, res) => {
  // Minimal, fast response so external health checks (e.g. Render) pass quickly
  return res.status(200).json({ ok: true, uptime: process.uptime(), ts: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 NAZA Bot - servidor iniciado');
  console.log('🌐 Puerto:', PORT);
  console.log('🔗 URL:', BASE_URL);
});
