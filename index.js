// index.js — NAZA.fx BOT (Render) — Whop ↔ Discord (OAuth2) + Supabase PRO + Dedupe + Email
// Requiere: discord.js v14, express, dotenv, body-parser, jsonwebtoken, @supabase/supabase-js, node-fetch, nodemailer

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const nodemailer = require('nodemailer');

// ================== Supabase (persistencia PRO) ==================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } }
);

// ===== Helpers de persistencia (DB) =====
async function linkGet(membership_id) {
  const { data, error } = await supabase
    .from('membership_links')
    .select('membership_id, discord_id')
    .eq('membership_id', membership_id)
    .maybeSingle();
  if (error) { console.log('supabase linkGet error:', error.message); return null; }
  return data; // { membership_id, discord_id } | null
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
  if (!error) return false;               // insertó → primera vez
  if (error.code === '23505') return true; // PK duplicada → ya usado
  console.log('supabase claimAlreadyUsed error:', error.message);
  return true; // ante error raro, bloquear
}

// ===== Dedupe de webhooks (Whop) + logs =====
function getEventIdFromWhop(body) {
  const candidates = [
    body?.id,
    body?.event_id,
    body?.eventId,
    body?.data?.id,
    body?.data?.payment_id,
    body?.data?.membership_id
  ].filter(Boolean);
  if (candidates.length > 0) return String(candidates[0]);
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

// ================== Discord client ==================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
  partials: [Partials.GuildMember]
});

client.once('ready', () => {
  console.log('✅ Bot conectado como', client.user.tag);
});

// ================== Utilidades Whop/Discord ==================

// (Opcional) extraer Discord ID si Whop lo envía como campo personalizado
function extractDiscordId(payload) {
  let discordId = null;

  const v2 = payload?.data?.membership?.custom_fields_responses_v2;
  if (Array.isArray(v2)) {
    const hit = v2.find(f => (String(f.label ?? f.question ?? '')).toLowerCase().includes('discord'));
    if (hit && hit.answer) discordId = String(hit.answer).trim();
  }

  if (!discordId) {
    const v1 = payload?.data?.custom_fields_responses;
    if (v1 && typeof v1 === 'object') {
      for (const [k, v] of Object.entries(v1)) {
        if (String(k).toLowerCase().includes('discord') && v) { discordId = String(v).trim(); break; }
      }
    }
  }

  if (!discordId && payload?.data?.discord_id) discordId = String(payload.data.discord_id).trim();

  if (discordId) {
    const onlyDigits = discordId.replace(/\D/g, '');
    if (onlyDigits.length >= 17 && onlyDigits.length <= 21) return onlyDigits;
  }
  return null;
}

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

// ================== Email (Gmail con App Password) ==================
const mailer = (process.env.GMAIL_USER && process.env.GMAIL_PASS)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
    })
  : null;

async function sendEmail(to, { subject, html }) {
  if (!mailer) {
    console.log('📧 [FAKE EMAIL] →', to, '|', subject, '|', html);
    return;
  }
  try {
    const info = await mailer.sendMail({
      from: process.env.FROM_EMAIL || process.env.GMAIL_USER,
      to,
      subject,
      html
    });
    console.log('📧 Email enviado:', info.messageId, '→', to);
  } catch (e) {
    console.log('❌ Error enviando email:', e?.message || e);
  }
}

// ================== Servidor Express ==================
const app = express();

// Guardamos el rawBody para (opcional) verificar firma de Whop
const rawBodySaver = (req, res, buf) => { req.rawBody = buf };
app.use(bodyParser.json({ type: '*/*', verify: rawBodySaver }));

app.get('/', (_req, res) => res.status(200).send('NAZA.fx BOT up ✔'));

// 🔐 (Opcional PRO) Verificación de firma Whop (si configuras WHOP_SIGNING_SECRET)
function verifyWhopSignature(req) {
  const secret = process.env.WHOP_SIGNING_SECRET;
  if (!secret) return true; // sin secreto → no bloquees (modo dev)
  const signature = req.get('Whop-Signature') || req.get('X-Whop-Signature');
  if (!signature) return false;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(req.rawBody || Buffer.from(''));
  const expected = hmac.digest('hex');
  return expected === signature;
}

// 🔒 middleware: exige claim en /discord/login
function requireClaim(req, res, next) {
  const { claim } = req.query || {};
  if (!claim) return res.status(401).send('🔒 Link inválido. Revisa tu correo de compra para reclamar acceso.');
  try {
    const payload = jwt.verify(claim, process.env.JWT_SECRET); // { whop_user_id, membership_id, jti, iat, exp }
    req.claim = payload;
    return next();
  } catch {
    return res.status(401).send('⛔ Claim inválido o vencido. Pide un nuevo enlace.');
  }
}

// ======= OAuth2: iniciar (protegido con claim) =======
app.get('/discord/login', requireClaim, (req, res) => {
  try {
    const state = jwt.sign(
      {
        ts: Date.now(),
        whop_user_id: req.claim.whop_user_id,
        membership_id: req.claim.membership_id,
        jti: req.claim.jti || null
      },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );

    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
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

// ======= OAuth2: callback (token → user → auto-join → rol) =======
app.get('/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Falta "code"');
    const st = jwt.verify(state, process.env.JWT_SECRET); // { membership_id, whop_user_id, jti, ts }

    // 1) token exchange
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI
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
    const ok = await joinGuildAndRoleWithAccessToken(
      process.env.GUILD_ID,
      process.env.ROLE_ID,
      me.id,
      accessToken,
      process.env.DISCORD_BOT_TOKEN
    );
    if (!ok) return res.status(200).send('⚠️ Autorizado, pero no se pudo asignar el rol. Tu ID: ' + me.id);

    // 6) guardar vínculo si no existía
    if (!existing || !existing.discord_id) await linkSet(st.membership_id, me.id);

    return res.status(200).send('✅ Acceso concedido. Revisa Discord.');
  } catch (e) {
    console.error('❌ Error en /discord/callback:', e?.message || e);
    return res.status(500).send('⚠️ Error al conectar Discord.');
  }
});

// ======= Webhook de Whop =======
const okEvents = new Set(['payment_succeeded', 'membership_activated', 'membership_went_valid']);
const cancelEvents = new Set(['membership_cancelled','membership_cancelled_by_user','membership_expired','membership_deactivated']);

function newClaim({ membership_id, whop_user_id }) {
  return jwt.sign(
    { membership_id, whop_user_id, jti: crypto.randomUUID() },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
}

app.post('/webhook/whop', async (req, res) => {
  try {
    // (Opcional) firma Whop
    if (!verifyWhopSignature(req)) {
      console.log('⛔ Firma de Whop inválida');
      return res.status(401).json({ error: 'invalid_signature' });
    }

    const body = req.body || {};
    const action = body?.action || body?.event;

    // 🧱 Anti-duplicados por event_id
    const event_id = getEventIdFromWhop(body);
    const dedupe = await ensureEventNotProcessedAndLog({
      event_id,
      event_type: action || 'unknown',
      body
    });
    if (dedupe.isDuplicate) {
      console.log('🚫 Webhook duplicado ignorado. event_id=', event_id, 'action=', action);
      return res.status(200).json({ status: 'duplicate_ignored' });
    }

    const email = body?.data?.user?.email || body?.data?.email || null;
    const whop_user_id  = body?.data?.user?.id || body?.data?.user_id || null;
    const membership_id = body?.data?.id || body?.data?.membership_id || null;

    console.log('📦 Webhook Whop:', { action, email, whop_user_id, membership_id });

    // Activaciones / renovaciones
    if (okEvents.has(action)) {
      const linked = membership_id ? await linkGet(membership_id) : null;
      if (linked?.discord_id) {
        await addRoleIfMember(process.env.GUILD_ID, process.env.ROLE_ID, linked.discord_id);
        return res.json({ status: 'role_ensured' });
      }
      if (email && whop_user_id && membership_id) {
        const claim = newClaim({ membership_id, whop_user_id });
        const base =
          process.env.SUCCESS_URL ||
          `https://${(process.env.RENDER_EXTERNAL_URL || '').replace(/^https?:\/\//,'')}/discord/login`;
        const link = `${base}?claim=${claim}`;
        await sendEmail(email, {
          subject: 'Reclama tu acceso al Discord (NAZA Trading Academy)',
          html: `Gracias por tu compra 👋<br>Conecta tu Discord y activa tu rol:<br>
                 <a href="${link}">${link}</a><br>
                 Este enlace expira en 24 horas.`
        });
        console.log('🔗 Link generado para', email, link);
        return res.json({ status: 'claim_sent', email });
      }
      return res.json({ status: 'no_email_or_ids' });
    }

    // Cancelación / expiración
    if (cancelEvents.has(action)) {
      const linked = membership_id ? await linkGet(membership_id) : null;
      if (linked?.discord_id) {
        const url = `https://discord.com/api/v10/guilds/${process.env.GUILD_ID}/members/${linked.discord_id}/roles/${process.env.ROLE_ID}`;
        const del = await fetch(url, { method: 'DELETE', headers: { 'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}` } });
        if (del.status === 204) console.log('🗑️ Rol revocado por cancelación/expiración:', linked.discord_id);
      } else {
        const discordId = extractDiscordId(body);
        if (discordId) {
          const url = `https://discord.com/api/v10/guilds/${process.env.GUILD_ID}/members/${discordId}/roles/${process.env.ROLE_ID}`;
          await fetch(url, { method: 'DELETE', headers: { 'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}` } });
          console.log('🗑️ Rol revocado (fallback) a', discordId);
        } else {
          console.log('ℹ️ Cancelación sin vínculo/ID — no se pudo revocar rol.');
        }
      }
      return res.json({ status: 'role_removed' });
    }

    return res.status(202).json({ status: 'ignored' });
  } catch (e) {
    console.error('❌ Error en /webhook/whop:', e?.message || e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ====== Rutas de prueba (habilita con TEST_MODE=true) ======
if (process.env.TEST_MODE === 'true') {
  app.get('/test-claim', (req, res) => {
    const claim = jwt.sign(
      { membership_id: 'TEST-' + Date.now(), whop_user_id: 'TEST', jti: crypto.randomUUID() },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );
    const base =
      process.env.SUCCESS_URL ||
      `https://${(process.env.RENDER_EXTERNAL_URL || '').replace(/^https?:\/\//,'')}/discord/login`;
    const link = `${base}?claim=${claim}`;
    console.log('🔗 Link de prueba:', link);
    res.status(200).send(`Link de prueba:<br><a href="${link}">${link}</a><br>(expira en 10 minutos)`);
  });

  app.get('/test-no-claim', (_req, res) => res.redirect('/discord/login'));

  app.get('/email-test', async (req, res) => {
    const to = req.query.to || 'tu-correo@ejemplo.com';
    await sendEmail(to, { subject: 'Prueba NAZA Trading', html: 'Hola 👋 funciona el correo.' });
    res.send('Enviado (revisa logs y tu inbox)');
  });
}

// ====== Arranque del server ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🟢 Servidor web activo en puerto ${PORT}`);
});

// ====== Login del bot ======
client.login(process.env.DISCORD_BOT_TOKEN);
