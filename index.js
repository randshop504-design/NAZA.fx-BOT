// ==========================
// NAZA.fx BOT — INDEX FINAL PRO (Ping Fix + Debug)
// ==========================
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const nodemailer = require('nodemailer');

const app = express();

// ===== ENV =====
const {
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  GUILD_ID,
  ROLE_ID,
  JWT_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
  RENDER_EXTERNAL_URL,
  SUCCESS_URL,
  GMAIL_USER, GMAIL_PASS, FROM_EMAIL,
  WHOP_SIGNING_SECRET,
  DISCORD_DOWNLOAD_URL = 'https://discord.com/download',
  DISCORD_TUTORIAL_URL = 'https://youtu.be/dQw4w9WgXcQ',
  WHATSAPP_URL = 'https://wa.me/50400000000',
  TELEGRAM_URL = 'https://t.me/naza_fx',
  TEST_MODE
} = process.env;

// ===== SUPABASE =====
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });

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
  const { error } = await supabase.from('claims_used').insert({ jti, membership_id });
  if (!error) return false;
  if (error.code === '23505') return true;
  console.log('supabase claimAlreadyUsed error:', error.message);
  return true;
}
function getEventIdFromWhop(body) {
  const c = [
    body?.id, body?.event_id, body?.eventId,
    body?.data?.id, body?.data?.payment_id, body?.data?.membership_id
  ].filter(Boolean);
  if (c.length) return String(c[0]);
  return crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex');
}
async function ensureEventNotProcessedAndLog({ event_id, event_type, body }) {
  const { error } = await supabase
    .from('webhook_logs')
    .insert({ event_id, event_type, data: body || null });
  if (!error) return { isDuplicate: false };
  if (error.code === '23505') return { isDuplicate: true };
  console.log('supabase webhook_logs insert error:', error.message);
  return { isDuplicate: true, error };
}

// ===== DISCORD CLIENT (con MessageContent + ping) =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent  // ¡importante!
  ],
  partials: [Partials.GuildMember]
});

client.once('ready', () => {
  console.log('✅ Bot conectado como', client.user.tag);
});

// Debug opcional para ver si llegan mensajes (borra luego si quieres)
client.on('messageCreate', (m) => {
  try {
    if (m.author.bot) return;
    // Loguea TODO para verificar recepción
    console.log('[DBG message]', m.guild?.name, '#'+m.channel?.name, '→', m.content);
  } catch {}
});

// Ping/Pong simple
client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.guild) return; // ignora DM
    const content = msg.content.trim().toLowerCase();
    if (content === 'ping' || content === '(ping)' || content === '!ping') {
      await msg.reply('pong 🏓');
    }
  } catch (e) {
    console.log('Error en messageCreate:', e?.message || e);
  }
});

// ===== Discord helpers =====
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
    const putRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken })
    });
    if (![201, 204].includes(putRes.status)) {
      const txt = await putRes.text().catch(() => '');
      console.log('⚠️ No se pudo unir al guild. status=', putRes.status, txt);
    }
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
    console.error('❌ Error joinGuildAndRoleWithAccessToken:', e?.message || e);
    return false;
  }
}

// ===== Email =====
const mailer = (GMAIL_USER && GMAIL_PASS)
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_PASS } })
  : null;

async function sendEmail(to, { subject, html }) {
  if (!mailer) {
    console.log('📧 [FAKE EMAIL] →', to, '|', subject, '|', (html||'').substring(0, 140)+'...');
    return;
  }
  try {
    const info = await mailer.sendMail({ from: FROM_EMAIL || GMAIL_USER, to, subject, html });
    console.log('📧 Email enviado:', info.messageId, '→', to);
  } catch (e) {
    console.log('❌ Error enviando email:', e?.message || e);
  }
}

function buildWelcomeEmailHTML({
  username = 'Trader',
  claimLink,
  discordDownloadUrl = DISCORD_DOWNLOAD_URL,
  discordTutorialUrl = DISCORD_TUTORIAL_URL,
  whatsappUrl = WHATSAPP_URL,
  telegramUrl = TELEGRAM_URL
} = {}) {
  const btn = 'display:inline-block;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700;';
  const p = 'margin:0 0 14px;line-height:1.5;';
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;margin:auto;padding:24px">
    <h2 style="margin:0 0 10px">¡Bienvenido a <span style="white-space:nowrap">NASA Strategic Academy</span>! 🎉</h2>
    <p style="${p}">Te felicito por dar este paso. Desde hoy formas parte de la comunidad enfocada en <b>libertad, resultados reales y crecimiento constante</b>.</p>
    <p style="${p}">Aquí encontrarás todo el <b>contenido, clases y señales</b> que te ayudarán a operar con claridad y confianza.</p>
    <div style="margin:18px 0 8px"><p style="${p}"><b>Nota:</b> Usa el <b>mismo correo</b> con el que realizaste la compra al crear tu cuenta de Discord.</p></div>
    <div style="margin:18px 0"><a href="${discordDownloadUrl}" style="${btn}background:#4f46e5;color:#fff">Descargar Discord</a></div>
    <div style="margin:8px 0 20px"><a href="${discordTutorialUrl}" style="${btn}background:#0ea5e9;color:#fff">Ver cómo crear tu cuenta</a></div>
    <div style="margin:22px 0">
      <p style="${p}">Si al pagar no conectaste tu Discord, reclámalo aquí:</p>
      <a href="${claimLink}" style="${btn}background:#16a34a;color:#fff">Acceso al servidor (activar rol)</a>
      <p style="margin:8px 0 0;color:#6b7280;font-size:12px">Enlace de <b>un solo uso</b> con vencimiento.</p>
    </div>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:26px 0" />
    <p style="${p}"><b>Comunidades privadas:</b></p>
    <p style="${p}"><a href="${telegramUrl}">Telegram</a> · <a href="${whatsappUrl}">WhatsApp</a></p>
    <p style="color:#6b7280;font-size:12px;margin-top:20px">Si no solicitaste este acceso, ignora este correo.</p>
  </div>`;
}

// ===== Express / webhooks =====
const rawBodySaver = (req, res, buf) => { req.rawBody = buf };
app.use(bodyParser.json({ type: '*/*', verify: rawBodySaver }));

app.get('/', (_req, res) => res.status(200).send('NAZA.fx BOT up ✔'));

function verifyWhopSignature(req) {
  if (!WHOP_SIGNING_SECRET) return true;
  const signature = req.get('Whop-Signature') || req.get('X-Whop-Signature');
  if (!signature) return false;
  const hmac = crypto.createHmac('sha256', WHOP_SIGNING_SECRET);
  hmac.update(req.rawBody || Buffer.from(''));
  const expected = hmac.digest('hex');
  return expected === signature;
}

function requireClaim(req, res, next) {
  const { claim } = req.query || {};
  if (!claim) return res.status(401).send('🔒 Link inválido. Revisa tu correo para reclamar acceso.');
  try {
    req.claim = jwt.verify(claim, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).send('⛔ Claim inválido o vencido. Pide un nuevo enlace.');
  }
}

app.get('/discord/login', requireClaim, (req, res) => {
  try {
    const state = jwt.sign(
      { ts: Date.now(), whop_user_id: req.claim.whop_user_id, membership_id: req.claim.membership_id, jti: req.claim.jti || null },
      JWT_SECRET, { expiresIn: '10m' }
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
    console.error('❌ /discord/login:', e?.message || e);
    return res.status(500).send('OAuth error');
  }
});

app.get('/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Falta "code"');
    const st = jwt.verify(state, JWT_SECRET);

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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
    const { access_token } = await tokenRes.json();

    const meRes = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    if (!meRes.ok) {
      const txt = await meRes.text().catch(() => '');
      console.log('⚠️ users/@me failed:', meRes.status, txt);
      return res.status(400).send('⚠️ Error al leer tu usuario de Discord.');
    }
    const me = await meRes.json();

    const existing = await linkGet(st.membership_id);
    if (existing && existing.discord_id && existing.discord_id !== me.id) {
      return res.status(403).send('⛔ Esta membresía ya está vinculada a otra cuenta de Discord.');
    }
    if (await claimAlreadyUsed(st.membership_id, st.jti)) {
      return res.status(409).send('⛔ Este enlace ya fue usado.');
    }

    const ok = await joinGuildAndRoleWithAccessToken(GUILD_ID, ROLE_ID, me.id, access_token, DISCORD_BOT_TOKEN);
    if (!ok) return res.status(200).send('⚠️ Autorizado, pero no se pudo asignar el rol. Tu ID: ' + me.id);

    if (!existing || !existing.discord_id) await linkSet(st.membership_id, me.id);

    return res.status(200).send('✅ Acceso concedido. Revisa Discord.');
  } catch (e) {
    console.error('❌ /discord/callback:', e?.message || e);
    return res.status(500).send('⚠️ Error al conectar Discord.');
  }
});

const okEvents = new Set(['payment_succeeded', 'membership_activated', 'membership_went_valid']);
const cancelEvents = new Set(['membership_cancelled','membership_cancelled_by_user','membership_expired','membership_deactivated']);

function newClaim({ membership_id, whop_user_id }) {
  return jwt.sign({ membership_id, whop_user_id, jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn: '24h' });
}

app.post('/webhook/whop', async (req, res) => {
  try {
    if (!verifyWhopSignature(req)) {
      console.log('⛔ Firma Whop inválida'); return res.status(401).json({ error: 'invalid_signature' });
    }
    const body = req.body || {};
    const action = body?.action || body?.event;

    const event_id = getEventIdFromWhop(body);
    const dedupe = await ensureEventNotProcessedAndLog({ event_id, event_type: action || 'unknown', body });
    if (dedupe.isDuplicate) {
      console.log('🚫 Webhook duplicado ignorado.', event_id, action);
      return res.status(200).json({ status: 'duplicate_ignored' });
    }

    const email = body?.data?.user?.email || body?.data?.email || null;
    const whop_user_id  = body?.data?.user?.id || body?.data?.user_id || null;
    const membership_id = body?.data?.id || body?.data?.membership_id || null;
    console.log('📦 Webhook Whop:', { action, email, whop_user_id, membership_id });

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
        const html = buildWelcomeEmailHTML({ username: body?.data?.user?.username || body?.data?.user?.name || 'Trader', claimLink: link });
        await sendEmail(email, { subject: 'Bienvenido a NASA Strategic Academy — Acceso y pasos (Discord)', html });
        console.log('🔗 Link generado para', email, link);
        return res.json({ status: 'claim_sent', email });
      }
      return res.json({ status: 'no_email_or_ids' });
    }

    if (cancelEvents.has(action)) {
      const linked = membership_id ? await linkGet(membership_id) : null;
      if (linked?.discord_id) {
        const url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${linked.discord_id}/roles/${ROLE_ID}`;
        const del = await fetch(url, { method: 'DELETE', headers: { 'Authorization': `Bot ${DISCORD_BOT_TOKEN}` } });
        if (del.status === 204) console.log('🗑️ Rol revocado:', linked.discord_id);
      } else {
        console.log('ℹ️ Cancelación sin vínculo.');
      }
      return res.json({ status: 'role_removed' });
    }

    return res.status(202).json({ status: 'ignored' });
  } catch (e) {
    console.error('❌ /webhook/whop:', e?.message || e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ===== Test helpers =====
if (TEST_MODE === 'true') {
  app.get('/test-claim', (req, res) => {
    const claim = jwt.sign({ membership_id: 'TEST-' + Date.now(), whop_user_id: 'TEST', jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn: '10m' });
    const base = SUCCESS_URL || `https://${(RENDER_EXTERNAL_URL || '').replace(/^https?:\/\//,'')}/discord/login`;
    const link = `${base}?claim=${claim}`;
    res.status(200).send(`Link de prueba:<br><a href="${link}">${link}</a>`);
  });
  app.get('/email-preview', (req, res) => {
    const claimLink = `${SUCCESS_URL}?claim=FAKE.TEST.CLAIM`;
    const html = buildWelcomeEmailHTML({ username: 'NAZA Tester', claimLink });
    res.set('Content-Type', 'text/html').send(html);
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🟢 Web server on ${PORT}`));
client.login(DISCORD_BOT_TOKEN);
