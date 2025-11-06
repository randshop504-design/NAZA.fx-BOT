// NAZA.fx BOT — MODO SIMPLE (Node 18+)
// Render ↔ Discord + Supabase + Gmail  (sin depender del webhook para emitir el claim)
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

// fetch nativo en Node 18+
const fetch = globalThis.fetch;

const app = express();

/* ========= ENV ========= */
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_BASE_URL || `http://localhost:${PORT}`;

const APP_NAME = process.env.APP_NAME || 'NAZA Trading Academy';

const DISCORD_BOT_TOKEN     = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URL  = process.env.DISCORD_REDIRECT_URL || `${BASE_URL}/discord/callback`;
const GUILD_ID = process.env.GUILD_ID;
const ROLE_ID  = process.env.ROLE_ID;

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-please-long-random';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });

/* ========= Email (Gmail) ========= */
const {
  GMAIL_USER, GMAIL_PASS, FROM_EMAIL,
  DISCORD_DOWNLOAD_URL = 'https://discord.com/download',
  DISCORD_TUTORIAL_URL = 'https://youtu.be/_51EAeKtTs0',
  INSTAGRAM_URL = 'https://instagram.com/',
  TIKTOK_URL = 'https://tiktok.com/@',
  WHATSAPP_URL = 'https://wa.me/50400000000',
  TELEGRAM_URL = 'https://t.me/',
  LOGO_URL = '',
  FOOTER_IMAGE_URL = '',
} = process.env;

const mailer = (GMAIL_USER && GMAIL_PASS)
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: GMAIL_USER, pass: GMAIL_PASS }
    })
  : null;

async function sendEmail(to, { subject, html }) {
  if (!mailer) { console.log('📧 [FAKE EMAIL]', to, subject); return; }
  const info = await mailer.sendMail({ from: FROM_EMAIL || GMAIL_USER, to, subject, html });
  console.log('📧 Enviado:', info.messageId, '→', to);
}

function buildWelcomeEmailHTML({ email, claim, username = 'Trader' }) {
  const btn = 'display:inline-block;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700;';
  const p = 'margin:0 0 14px;line-height:1.6;';
  const connectLink = `${BASE_URL}/discord/login?claim=${encodeURIComponent(claim)}`;
  return `
  <div style="margin:0;padding:0;background:#0b0d10;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0b0d10">
      <tr><td align="center">
        <table role="presentation" width="640" style="max-width:640px;background:#0f1217;color:#e6e9ef;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;border:1px solid #1b212a;border-radius:12px;overflow:hidden;">
          ${LOGO_URL ? `<tr><td align="center" style="padding:22px"><img src="${LOGO_URL}" alt="logo" style="height:60px;border-radius:12px;border:1px solid #2a3240"></td></tr>` : ''}
          <tr><td align="center" style="padding:8px 24px 0">
            <h2 style="margin:0;font-size:22px;color:#fff">${APP_NAME}</h2>
            <p style="margin:6px 0 0;font-size:12px;color:#98a1b3">Si no ves este correo, revisa <b>Spam/Promociones</b>.</p>
          </td></tr>
          <tr><td style="padding:14px 24px">
            <p style="${p}">¡Bienvenido, <b>${username}</b>! 🎉</p>
            <p style="${p}">Haz clic para conectar tu Discord y activar tu acceso:</p>
            <div style="margin:18px 0">
              <a href="${connectLink}" style="${btn}background:#2b6cff;color:#fff">Conectar con Discord</a>
            </div>
            <div style="margin:12px 0">
              <a href="${DISCORD_DOWNLOAD_URL}" style="${btn}background:#1f2633;color:#fff">⬇️ Descargar Discord</a>
              <a href="${DISCORD_TUTORIAL_URL}" style="${btn}background:#1f2633;color:#fff;margin-left:8px">▶️ Ver tutorial</a>
            </div>
            <hr style="border:none;border-top:1px solid #2a3240;margin:22px 0">
            <div style="margin:8px 0 20px">
              <a href="${INSTAGRAM_URL}" style="${btn}background:#2a3240;color:#fff;margin-right:8px">📸 Instagram</a>
              <a href="${TIKTOK_URL}" style="${btn}background:#2a3240;color:#fff;margin-right:8px">🎵 TikTok</a>
              <a href="${WHATSAPP_URL}" style="${btn}background:#2a3240;color:#fff;margin-right:8px">💬 WhatsApp</a>
              <a href="${TELEGRAM_URL}" style="${btn}background:#2a3240;color:#fff">📣 Telegram</a>
            </div>
            <p style="color:#9ca3af;font-size:12px">Disclaimer: ${APP_NAME} es educativo; no es asesoría financiera.</p>
          </td></tr>
          ${FOOTER_IMAGE_URL ? `<tr><td><img src="${FOOTER_IMAGE_URL}" alt="banner" style="width:100%;display:block"></td></tr>` : ''}
        </table>
      </td></tr>
    </table>
  </div>`;
}

/* ========= DB helpers ========= */
async function linkGet(membership_id) {
  if (!membership_id) return null;
  const { data } = await supabase.from('membership_links')
    .select('membership_id, discord_id').eq('membership_id', membership_id).maybeSingle();
  return data || null;
}
async function linkSet(membership_id, discord_id) {
  if (!membership_id || !discord_id) return;
  await supabase.from('membership_links').upsert({ membership_id, discord_id }, { onConflict: 'membership_id' });
}
async function claimAlreadyUsed(membership_id, jti) {
  if (!jti) return false;
  const { error } = await supabase.from('claims_used').insert({ jti, membership_id });
  if (!error) return false;
  return error.code === '23505';
}

/* ========= Parsers ========= */
app.use(express.json());

/* ========= Health ========= */
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

/* ========= Página post-pago SIMPLE ========= */
app.get('/redirect', (req, res) => {
  const { email = '', order_id = '' } = req.query || {};
  res.set('Content-Type', 'text/html').send(`
  <!doctype html><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${APP_NAME} • Activar acceso</title>
  <style>
    body{margin:0;background:#0b0d10;color:#e6e9ef;font-family:system-ui,Segoe UI,Roboto,Arial}
    .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{width:100%;max-width:720px;background:#0f1217;border:1px solid #1b212a;border-radius:16px;padding:28px}
    .row{display:flex;gap:10px;margin-top:12px}
    input{flex:1;background:#0b0d10;border:1px solid #2a3240;border-radius:10px;padding:12px 14px;color:#e6e9ef}
    .btn{padding:12px 18px;border:0;border-radius:10px;background:#2b6cff;color:#fff;font-weight:700;cursor:pointer}
    .hint{margin-top:10px;color:#98a1b3;font-size:14px}
    .alert{margin-top:16px;padding:12px 14px;border-radius:10px;background:#3a1111;color:#fff;border:1px solid #621a1a;display:none}
  </style>
  <div class="wrap"><div class="card">
    <h2>Último paso para activar tu acceso</h2>
    <p><b>Compra exitosa.</b> Te enviaremos un correo con tu botón de acceso (revisa <b>Spam/Promociones</b>).</p>

    <div class="row">
      <input id="email" type="email" placeholder="tu@email.com" value="${email}"/>
      <button class="btn" id="send">Obtener acceso</button>
    </div>

    <div class="row">
      <button class="btn" id="connectNow">Conectar ahora</button>
    </div>

    <div id="msg" class="alert"></div>
    <p class="hint">Si no te llega el correo, usa “Conectar ahora”.</p>
  </div></div>

  <script>
    const qEmail = ${JSON.stringify(email)};
    const qOrder = ${JSON.stringify(order_id)};
    const email = document.getElementById('email');
    const send  = document.getElementById('send');
    const now   = document.getElementById('connectNow');
    const msg   = document.getElementById('msg');

    function show(t){ msg.textContent=t; msg.style.display='block'; }

    async function getClaim() {
      const e = email.value.trim();
      if(!e) { show('Escribe tu correo.'); return null; }
      const r = await fetch('/api/claim/direct', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ email:e, order_id: qOrder })
      });
      const j = await r.json();
      if (!r.ok) { show(j.error || 'Error generando el acceso.'); return null; }
      return j.claim;
    }

    send.addEventListener('click', async ()=>{
      const claim = await getClaim();
      if (!claim) return;
      const r = await fetch('/email/send-access', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ email: email.value.trim(), claim })
      });
      if (r.ok) show('Correo enviado. Revisa Spam/Promociones.');
      else show('No se pudo enviar el correo.');
    });

    now.addEventListener('click', async ()=>{
      const claim = await getClaim();
      if (!claim) return;
      window.location.href = '/discord/login?claim=' + encodeURIComponent(claim);
    });
  </script>`);
});

/* ========= Emisión de claim (SIN webhook) ========= */
app.post('/api/claim/direct', async (req, res) => {
  try {
    const { email, order_id } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email requerido' });
    const membership_id = String(order_id || 'ORDER-' + Date.now());
    const claim = jwt.sign(
      { membership_id, email: String(email).toLowerCase(), jti: crypto.randomUUID() },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    return res.json({ claim });
  } catch (e) {
    console.error('claim/direct error', e?.message || e);
    res.status(500).json({ error: 'server_error' });
  }
});

/* ========= Enviar correo con el botón ========= */
app.post('/email/send-access', async (req, res) => {
  try {
    const to = String(req.body.email || '').trim().toLowerCase();
    const claim = String(req.body.claim || '');
    if (!to || !claim) return res.status(400).json({ error: 'email y claim requeridos' });
    const html = buildWelcomeEmailHTML({ email: to, claim, username: 'Trader' });
    await sendEmail(to, { subject: `${APP_NAME} — Conectar con Discord`, html });
    res.json({ ok: true });
  } catch (e) {
    console.error('email/send-access error', e?.message || e);
    res.status(500).json({ error: 'server_error' });
  }
});

/* ========= Seguridad: requireClaim ========= */
function requireClaim(req, res, next) {
  const { claim } = req.query || {};
  if (!claim) return res.status(401).send('🔒 Enlace inválido.');
  try {
    req.claim = jwt.verify(claim, JWT_SECRET); // { membership_id, email, jti, exp }
    return next();
  } catch {
    return res.status(401).send('⛔ Enlace vencido o usado.');
  }
}

/* ========= OAuth2 Discord ========= */
app.get('/discord/login', requireClaim, (req, res) => {
  const state = jwt.sign(
    { ts: Date.now(), membership_id: req.claim.membership_id, jti: req.claim.jti },
    JWT_SECRET, { expiresIn: '10m' }
  );
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URL,
    response_type: 'code',
    scope: 'identify guilds.join',
    prompt: 'consent',
    state
  });
  res.redirect('https://discord.com/api/oauth2/authorize?' + params.toString());
});

app.get('/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Falta code');
    const st = jwt.verify(state, JWT_SECRET);

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
    if (!tRes.ok) return res.status(400).send('Error al obtener token');
    const { access_token } = await tRes.json();

    const meRes = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    if (!meRes.ok) return res.status(400).send('Error leyendo usuario');
    const me = await meRes.json();

    // Evitar reuso del claim
    if (await claimAlreadyUsed(st.membership_id, st.jti))
      return res.status(409).send('⛔ Este enlace ya fue usado.');

    // Join + role
    await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${me.id}`, {
      method: 'PUT',
      headers: { Authorization: 'Bot ' + DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token })
    }).catch(() => {});
    await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${me.id}/roles/${ROLE_ID}`, {
      method: 'PUT',
      headers: { Authorization: 'Bot ' + DISCORD_BOT_TOKEN }
    });

    // Guardar vínculo si no existe
    const existing = await linkGet(st.membership_id);
    if (!existing?.discord_id) await linkSet(st.membership_id, me.id);

    res.send('✅ Acceso activado. Ya puedes cerrar esta pestaña y entrar al Discord.');
  } catch (e) {
    console.error('DISCORD_CALLBACK_ERROR', e?.message || e);
    res.status(500).send('OAuth error');
  }
});

/* ========= Debug rápido ========= */
app.get('/smtp-verify', async (_req, res) => {
  try {
    if (!GMAIL_USER || !GMAIL_PASS) return res.status(200).send('Mailer inactivo: faltan GMAIL_USER/GMAIL_PASS');
    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: GMAIL_USER, pass: GMAIL_PASS }
    });
    await transport.verify();
    res.send('SMTP OK ✅');
  } catch (e) { res.status(500).send('SMTP ERROR: ' + (e?.message || e)); }
});

app.listen(PORT, () => {
  console.log('🟢 NAZA.fx BOT (Modo Simple) on', BASE_URL);
  console.log('Redirect:', `${BASE_URL}/redirect`);
  console.log('Discord callback:', DISCORD_REDIRECT_URL);
});
