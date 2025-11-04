// ==========================
// NAZA.fx BOT — INDEX FINAL PRO (Dark Email + OAuth2 + Supabase + Dedupe)
// ==========================

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
// node-fetch@3 es ESM; usamos import dinámico compatible con CJS:
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const nodemailer = require('nodemailer');

const app = express();

// ==========================
// ENV VARS
// ==========================
const {
  // Discord
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  GUILD_ID,
  ROLE_ID,

  // Seguridad
  JWT_SECRET,
  WHOP_SIGNING_SECRET,

  // Infra
  RENDER_EXTERNAL_URL,
  SUCCESS_URL,

  // Supabase
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,

  // Email (Gmail)
  GMAIL_USER,
  GMAIL_PASS,
  FROM_EMAIL,

  // Enlaces que aparecen en el correo
  DISCORD_DOWNLOAD_URL = 'https://discord.com/download',
  DISCORD_TUTORIAL_URL,
  WHATSAPP_URL,
  TELEGRAM_URL,

  // Logos (pon tus URLs públicas de Supabase)
  LOGO_URL,         // logo superior (redondo/circular visual)
  FOOTER_LOGO_URL,  // banner inferior rectangular

  // Modo pruebas
  TEST_MODE
} = process.env;

// ==========================
// SUPABASE CLIENT
// ==========================
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });

// ===== Helpers de persistencia (DB)
async function linkGet(membership_id) {
  const { data, error } = await supabase
    .from('membership_links')
    .select('membership_id, discord_id')
    .eq('membership_id', membership_id)
    .maybeSingle();
  if (error) { console.log('supabase linkGet error:', error.message); return null; }
  return data || null;
}

async function linkSet(membership_id, discord_id) {
  const { error } = await supabase
    .from('membership_links')
    .upsert({ membership_id, discord_id }, { onConflict: 'membership_id' });
  if (error) console.log('supabase linkSet error:', error.message);
}

async function claimAlreadyUsed(membership_id, jti) {
  if (!jti) return false;
  const { error } = await supabase
    .from('claims_used')
    .insert({ jti, membership_id });
  if (!error) return false;                // primera vez
  if (error.code === '23505') return true; // duplicado → ya usado
  console.log('supabase claimAlreadyUsed error:', error.message);
  return true; // por seguridad, bloquea si hay error desconocido
}

// ===== Dedupe de webhooks (Whop) + logs
function getEventIdFromWhop(body) {
  const c = [
    body?.id,
    body?.event_id,
    body?.eventId,
    body?.data?.id,
    body?.data?.payment_id,
    body?.data?.membership_id
  ].filter(Boolean);
  if (c.length) return String(c[0]);
  return crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex');
}

async function ensureEventNotProcessedAndLog({ event_id, event_type, body }) {
  const { error } = await supabase
    .from('webhook_logs')
    .insert({ event_id, event_type, data: body || null });
  if (!error) return { isDuplicate: false };
  if (error.code === '23505') return { isDuplicate: true }; // unique_violation
  console.log('supabase webhook_logs insert error:', error.message);
  return { isDuplicate: true, error };
}

// ==========================
// DISCORD CLIENT + Ping/Pong
// ==========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent // ← necesario para leer "ping"
  ],
  partials: [Partials.GuildMember]
});

client.once('ready', () => {
  console.log('✅ Bot conectado como', client.user.tag);
});

// Ping/Pong simple
client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.guild) return;
    const content = msg.content.trim().toLowerCase();
    if (content === 'ping' || content === '(ping)') {
      await msg.reply('pong 🏓');
    }
  } catch (e) {
    console.log('Error en messageCreate:', e?.message || e);
  }
});

// ==========================
// Discord helpers (roles / join)
// ==========================
async function addRoleIfMember(guildId, roleId, userId) {
  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      console.log('⚠️ Usuario no está en el servidor. userId=', userId);
      return { ok: false, reason: 'not_in_guild' };
    }
    if (!member.roles.cache.has(roleId)) await member.roles.add(roleId);
    console.log('✅ Rol asignado a', userId);
    return { ok: true };
  } catch (e) {
    console.error('❌ Error asignando rol:', e?.message || e);
    return { ok: false, reason: 'error' };
  }
}

async function joinGuildAndRoleWithAccessToken(guildId, roleId, userId, accessToken, botToken) {
  try {
    // join al guild (PUT members)
    const putRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken })
    });
    if (![201, 204].includes(putRes.status)) {
      const txt = await putRes.text().catch(() => '');
      console.log('⚠️ No se pudo unir al guild. status=', putRes.status, txt);
    }

    // asignar rol
    const roleRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bot ${botToken}` }
    });
    if (roleRes.status !== 204) {
      const txt = await roleRes.text().catch(() => '');
      console.log('⚠️ No se pudo asignar rol tras join. status=', roleRes.status, txt);
      return false;
    }

    console.log('✅ Usuario unido/asignado rol vía OAuth2:', userId);
    return true;
  } catch (e) {
    console.error('❌ Error en joinGuildAndRoleWithAccessToken:', e?.message || e);
    return false;
  }
}

// ==========================
// Email (Gmail con App Password) — auto fallback a FAKE
// ==========================
const mailer = (GMAIL_USER && GMAIL_PASS)
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_PASS } })
  : null;

async function sendEmail(to, { subject, html }) {
  if (!mailer) {
    console.log('📧 [FAKE EMAIL] →', to, '|', subject, '|', (html || '').substring(0, 140) + '...');
    return;
  }
  try {
    const info = await mailer.sendMail({
      from: FROM_EMAIL || GMAIL_USER,
      to,
      subject,
      html
    });
    console.log('📧 Email enviado:', info.messageId, '→', to);
  } catch (e) {
    console.log('❌ Error enviando email:', e?.message || e);
  }
}

// ==========================
// Email Template (DARK THEME + logos + íconos)
// ==========================
function buildWelcomeEmailHTML({
  username = 'Trader',
  claimLink, // ← link con ?claim=...
  logoUrl = LOGO_URL,
  footerLogoUrl = FOOTER_LOGO_URL,
  downloadUrl = DISCORD_DOWNLOAD_URL,
  tutorialUrl = DISCORD_TUTORIAL_URL,
  whatsappUrl = WHATSAPP_URL,
  telegramUrl = TELEGRAM_URL
} = {}) {
  const bg = '#0f1115';
  const panel = '#111827';
  const border = '#1f2937';
  const text = '#e5e7eb';
  const sub = '#9ca3af';
  const green = '#16A34A';     // Acceso (claim)
  const blue = '#0EA5E9';      // Descargar Discord
  const sky = '#38BDF8';       // Crear cuenta
  const wa = '#25D366';        // WhatsApp
  const tg = '#8B5CF6';        // Telegram

  const btn = (bgc, color = '#fff') => `display:inline-flex;align-items:center;gap:10px;padding:12px 16px;border-radius:10px;font-weight:700;text-decoration:none;color:${color};background:${bgc}`;
  const wrap = `font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;margin:auto;background:${bg};padding:24px;color:${text};border-radius:14px`;
  const h1 = 'margin:8px 0 18px;text-align:center;font-size:22px;color:#fff';
  const p = 'margin:0 0 14px;line-height:1.6;color:'+text;
  const card = `background:${panel};border:1px solid ${border};border-radius:12px;padding:16px`;

  // SVGs seguros inline
  const icDiscord = `<svg width="18" height="18" viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M20.317 4.369A19.79 19.79 0 0016.558 3c-.2.36-.433.85-.593 1.234a18.27 18.27 0 00-7.93 0A8.258 8.258 0 007.44 3c-1.4.256-2.73.69-3.76 1.369C.64 8.045-.23 11.6.07 15.105A19.9 19.9 0 006.08 18c.466-.64.88-1.33 1.23-2.055-.68-.26-1.33-.58-1.95-.95.16-.12.32-.25.47-.38 3.74 1.75 7.8 1.75 11.51 0 .16.13.32.26.48.38-.62.37-1.27.69-1.95.95.35.725.76 1.415 1.23 2.055A19.9 19.9 0 0023.93 15.1c.3-3.5-.57-7.056-3.613-10.731z"/></svg>`;
  const icPlay = `<svg width="18" height="18" viewBox="0 0 24 24" fill="#0b1020" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
  const icKey  = `<svg width="18" height="18" viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M14 3a7 7 0 00-6.93 6H1v4h4v4h4v4h4v-4h2l3-3a7 7 0 00-4-11zM9 9a5 5 0 115 5 5 5 0 01-5-5z"/></svg>`;
  const icWA   = `<svg width="18" height="18" viewBox="0 0 32 32" fill="#04210e" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M19.11 17.21c-.29-.15-1.7-.84-1.96-.93-.26-.1-.45-.15-.64.15-.19.3-.74.93-.9 1.12-.17.19-.33.22-.62.08-.29-.15-1.23-.45-2.35-1.44-.87-.77-1.46-1.72-1.63-2-.17-.3 0-.46.13-.6.14-.14.3-.33.45-.5.15-.18.19-.3.29-.49.1-.19.05-.37-.02-.52-.07-.15-.64-1.54-.88-2.1-.23-.56-.47-.48-.64-.49h-.54c-.19 0-.5.07-.76.37-.26.3-1 1-1 2.46s1.03 2.86 1.18 3.06c.15.2 2.02 3.09 4.9 4.33.69.3 1.23.48 1.65.62.69.22 1.32.19 1.82.12.56-.08 1.7-.69 1.94-1.36.24-.67.24-1.25.17-1.37-.07-.12-.26-.19-.55-.34z"/><path d="M26.83 5.17C24.53 2.87 21.39 1.6 18 1.6 9.93 1.6 3.6 7.94 3.6 16c0 2.25.57 4.45 1.65 6.4L3.2 30.4l8.13-2.02A14.25 14.25 0 0018 30.4c8.06 0 14.4-6.34 14.4-14.4 0-3.39-1.27-6.53-3.57-8.83zM18 27.6c-2.05 0-4.04-.54-5.8-1.56l-.42-.25-4.82 1.2 1.28-4.68-.28-.46a11.98 11.98 0 01-1.82-6.85C6.14 9.12 11.48 3.6 18 3.6c3.32 0 6.45 1.29 8.8 3.63 2.35 2.35 3.63 5.48 3.63 8.77 0 6.52-5.34 11.6-12.43 11.6z"/></svg>`;
  const icTG   = `<svg width="18" height="18" viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M9.04 15.47l-.37 5.23c.53 0 .76-.23 1.04-.5l2.5-2.38 5.18 3.8c.95.52 1.62.25 1.88-.88l3.41-15.95c.34-1.54-.56-2.14-1.56-1.77L1.38 9.7c-1.51.59-1.49 1.44-.26 1.82l4.8 1.5 11.16-7.03c.52-.32 1-.14.61.18"/></svg>`;

  return `
  <div style="${wrap}">
    <!-- Logo superior -->
    ${logoUrl ? `<div style="text-align:center;margin-bottom:12px;">
      <img src="${logoUrl}" alt="NAZA Logo" width="72" height="72" style="width:72px;height:72px;border-radius:999px;display:inline-block;object-fit:cover;">
    </div>` : ''}

    <!-- Título -->
    <h1 style="${h1}">NAZA Trading Academy</h1>

    <!-- Bienvenida -->
    <div style="${card};margin-bottom:16px;">
      <p style="${p}">¡Bienvenido, <b>${username}</b>! 🎉</p>
      <p style="${p}">Desde hoy formas parte de una comunidad enfocada en <b>libertad, resultados reales y crecimiento constante</b>. Aquí encontrarás <b>contenido, clases y señales</b> para operar con claridad y confianza.</p>
    </div>

    <!-- Nota importante -->
    <div style="${card};margin-bottom:16px;">
      <p style="${p}"><b>NOTA importante:</b> Usa el <b>mismo correo</b> con el que realizaste la compra cuando crees tu cuenta de Discord.</p>
    </div>

    <!-- Herramientas Discord -->
    <div style="display:block;gap:12px;margin-bottom:16px;text-align:center;">
      <div style="margin-bottom:10px;">
        <a href="${downloadUrl}" style="${btn(blue)}">${icDiscord} Descargar Discord</a>
      </div>
      ${tutorialUrl ? `<div><a href="${tutorialUrl}" style="${btn(sky,'#0b1020')}">${icPlay} Ver cómo crear tu cuenta</a></div>` : ''}
    </div>

    <!-- Acceso (claim) -->
    ${claimLink ? `<div style="${card};margin-bottom:16px;text-align:center;">
      <p style="${p}">Si al pagar no conectaste tu Discord, hazlo aquí:</p>
      <a href="${claimLink}" style="${btn(green)}">${icKey} Acceso al servidor (activar rol)</a>
      <p style="margin:8px 0 0;color:${sub};font-size:12px">Este enlace es <b>de un solo uso</b> y <b>expira en 24 horas</b>.</p>
    </div>` : ''}

    <!-- Comunidades -->
    <div style="${card};margin-bottom:16px;">
      <p style="${p}"><b>Comunidades privadas</b></p>
      <div style="display:block;gap:10px;">
        ${whatsappUrl ? `<div style="margin-bottom:10px;">
          <a href="${whatsappUrl}" style="${btn(wa,'#04210e')}">${icWA} Unirme a la comunidad en WhatsApp</a>
        </div>` : ''}
        ${telegramUrl ? `<div>
          <a href="${telegramUrl}" style="${btn(tg)}">${icTG} Unirme a la comunidad en Telegram</a>
        </div>` : ''}
      </div>
    </div>

    ${footerLogoUrl ? `<div style="text-align:center;margin-top:10px;">
      <img src="${footerLogoUrl}" alt="NAZA Footer" style="width:100%;max-width:640px;height:auto;border-radius:10px;display:inline-block;">
    </div>` : ''}
  </div>`;
}

// ==========================
// Express middlewares / health
// ==========================
const rawBodySaver = (req, res, buf) => { req.rawBody = buf };
app.use(bodyParser.json({ type: '*/*', verify: rawBodySaver }));

app.get('/', (_req, res) => res.status(200).send('NAZA.fx BOT up ✔'));

// (Opcional PRO) Verificación de firma Whop
function verifyWhopSignature(req) {
  if (!WHOP_SIGNING_SECRET) return true; // sin secreto, no bloqueamos (dev)
  const signature = req.get('Whop-Signature') || req.get('X-Whop-Signature');
  if (!signature) return false;
  const hmac = crypto.createHmac('sha256', WHOP_SIGNING_SECRET);
  hmac.update(req.rawBody || Buffer.from(''));
  const expected = hmac.digest('hex');
  return expected === signature;
}

// ======= OAuth2: exigir claim (un solo uso)
function requireClaim(req, res, next) {
  const { claim } = req.query || {};
  if (!claim) return res.status(401).send('🔒 Link inválido. Revisa tu correo de compra para reclamar acceso.');
  try {
    const payload = jwt.verify(claim, JWT_SECRET); // { whop_user_id, membership_id, jti, iat, exp }
    req.claim = payload;
    return next();
  } catch {
    return res.status(401).send('⛔ Claim inválido o vencido. Pide un nuevo enlace.');
  }
}

// ======= OAuth2: iniciar
app.get('/discord/login', requireClaim, (req, res) => {
  try {
    const state = jwt.sign(
      { ts: Date.now(), whop_user_id: req.claim.whop_user_id, membership_id: req.claim.membership_id, jti: req.claim.jti || null },
      JWT_SECRET,
      { expiresIn: '10m' }
    );
    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: DISCORD_REDIRECT_URI,
      response_type: 'code',
      scope: 'identify guilds.join',
      state
    });
    const url = `https://discord.com/api/oauth2/authorize?${params.toString()}`;
    return res.redirect(url);
  } catch (e) {
    console.error('❌ Error en /discord/login:', e?.message || e);
    return res.status(500).send('OAuth error');
  }
});

// ======= OAuth2: callback
app.get('/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Falta "code"');
    const st = jwt.verify(state, JWT_SECRET); // { membership_id, whop_user_id, jti, ts }

    // 1) token exchange
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI
      })
    });
    if (!tokenRes.ok) {
      const txt = await tokenRes.text().catch(() => '');
      console.log('⚠️ token exchange failed:', tokenRes.status, txt);
      return res.status(400).send('⚠️ Error al obtener tokens de Discord.');
    }
    const tokens = await tokenRes.json();
    const accessToken = tokens.access_token;

    // 2) user
    const meRes = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!meRes.ok) {
      const txt = await meRes.text().catch(() => '');
      console.log('⚠️ users/@me failed:', meRes.status, txt);
      return res.status(400).send('⚠️ Error al leer tu usuario de Discord.');
    }
    const me = await meRes.json(); // { id, username, ... }

    // 3) 1 Discord por membresía
    const existing = await linkGet(st.membership_id);
    if (existing && existing.discord_id && existing.discord_id !== me.id) {
      return res.status(403).send('⛔ Esta membresía ya está vinculada a otra cuenta de Discord.');
    }

    // 4) claim de 1 solo uso
    if (await claimAlreadyUsed(st.membership_id, st.jti)) {
      return res.status(409).send('⛔ Este enlace ya fue usado.');
    }

    // 5) auto-join + rol
    const ok = await joinGuildAndRoleWithAccessToken(GUILD_ID, ROLE_ID, me.id, accessToken, DISCORD_BOT_TOKEN);
    if (!ok) return res.status(200).send('⚠️ Autorizado, pero no se pudo asignar el rol. Tu ID: ' + me.id);

    // 6) guardar vínculo si no existía
    if (!existing || !existing.discord_id) await linkSet(st.membership_id, me.id);

    return res.status(200).send('✅ Acceso concedido. Revisa Discord.');
  } catch (e) {
    console.error('❌ Error en /discord/callback:', e?.message || e);
    return res.status(500).send('⚠️ Error al conectar Discord.');
  }
});

// ======= Webhook de Whop
const okEvents = new Set(['payment_succeeded', 'membership_activated', 'membership_went_valid']);
const cancelEvents = new Set(['membership_cancelled','membership_cancelled_by_user','membership_expired','membership_deactivated']);

function newClaim({ membership_id, whop_user_id }) {
  return jwt.sign({ membership_id, whop_user_id, jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn: '24h' });
}

app.post('/webhook/whop', async (req, res) => {
  try {
    // Firma (opcional)
    if (!verifyWhopSignature(req)) {
      console.log('⛔ Firma de Whop inválida');
      return res.status(401).json({ error: 'invalid_signature' });
    }

    const body = req.body || {};
    const action = body?.action || body?.event;

    // Anti-duplicados
    const event_id = getEventIdFromWhop(body);
    const dedupe = await ensureEventNotProcessedAndLog({ event_id, event_type: action || 'unknown', body });
    if (dedupe.isDuplicate) {
      console.log('🚫 Webhook duplicado ignorado. event_id=', event_id, 'action=', action);
      return res.status(200).json({ status: 'duplicate_ignored' });
    }

    const email = body?.data?.user?.email || body?.data?.email || null;
    const whop_user_id  = body?.data?.user?.id || body?.data?.user_id || null;
    const membership_id = body?.data?.id || body?.data?.membership_id || null;

    console.log('📦 Webhook Whop:', { action, email, whop_user_id, membership_id });

    // Altas / renovaciones
    if (okEvents.has(action)) {
      const linked = membership_id ? await linkGet(membership_id) : null;
      if (linked?.discord_id) {
        await addRoleIfMember(GUILD_ID, ROLE_ID, linked.discord_id);
        return res.json({ status: 'role_ensured' });
      }
      if (email && whop_user_id && membership_id) {
        const claim = newClaim({ membership_id, whop_user_id });
        const base = SUCCESS_URL || `https://${(RENDER_EXTERNAL_URL || '').replace(/^https?:\/\//,'')}/discord/login`;
        const link = `${base}?claim=${claim}`;

        const html = buildWelcomeEmailHTML({
          username: body?.data?.user?.username || body?.data?.user?.name || 'Trader',
          claimLink: link
        });

        await sendEmail(email, {
          subject: 'Bienvenido a NAZA Trading Academy — Acceso y pasos (Discord)',
          html
        });

        console.log('🔗 Link generado para', email, link);
        return res.json({ status: 'claim_sent', email });
      }
      return res.json({ status: 'no_email_or_ids' });
    }

    // Bajas / expiraciones
    if (cancelEvents.has(action)) {
      const linked = membership_id ? await linkGet(membership_id) : null;
      if (linked?.discord_id) {
        const url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${linked.discord_id}/roles/${ROLE_ID}`;
        const del = await fetch(url, { method: 'DELETE', headers: { 'Authorization': `Bot ${DISCORD_BOT_TOKEN}` } });
        if (del.status === 204) console.log('🗑️ Rol revocado por cancelación/expiración:', linked.discord_id);
      } else {
        console.log('ℹ️ Cancelación sin vínculo — no se pudo revocar rol.');
      }
      return res.json({ status: 'role_removed' });
    }

    return res.status(202).json({ status: 'ignored' });
  } catch (e) {
    console.error('❌ Error en /webhook/whop:', e?.message || e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ====== Rutas de prueba (habilita con TEST_MODE=true)
if (TEST_MODE === 'true') {
  app.get('/test-claim', (req, res) => {
    const claim = jwt.sign(
      { membership_id: 'TEST-' + Date.now(), whop_user_id: 'TEST', jti: crypto.randomUUID() },
      JWT_SECRET,
      { expiresIn: '10m' }
    );
    const base = SUCCESS_URL || `https://${(RENDER_EXTERNAL_URL || '').replace(/^https?:\/\//,'')}/discord/login`;
    const link = `${base}?claim=${claim}`;
    console.log('🔗 Link de prueba:', link);
    res.status(200).send(`Link de prueba:<br><a href="${link}">${link}</a><br>(expira en 10 minutos)`);
  });

  app.get('/email-preview', (req, res) => {
    const claimLink = `${SUCCESS_URL || `https://${(RENDER_EXTERNAL_URL || '').replace(/^https?:\/\//,'')}/discord/login`}?claim=FAKE.TEST.CLAIM`;
    const html = buildWelcomeEmailHTML({
      username: 'NAZA Tester',
      claimLink
    });
    res.set('Content-Type', 'text/html').send(html);
  });
}

// ==========================
// Start server + Login bot
// ==========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🟢 Servidor web activo en puerto ${PORT}`);
});

client.login(DISCORD_BOT_TOKEN);
