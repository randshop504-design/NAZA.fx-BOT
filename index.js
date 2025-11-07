// NAZA.fx BOT — INDEX FINAL (Node 18+)
// Whop ↔ Render ↔ Discord + Supabase + Gmail
// Flujo: pago → /webhook/whop (valida/log/email) → /redirect (TyC) → claim 1-uso/24h → OAuth Discord → entra + rol
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

// fetch (Node 18+ global; polyfill por si acaso)
const fetch = globalThis.fetch || ((...a) => import('node-fetch').then(({ default: f }) => f(...a)));

const app = express();

/* ========= ENV ========= */
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_BASE_URL || `http://localhost:${PORT}`;

const APP_NAME = process.env.APP_NAME || 'NAZA Trading Academy';

const DISCORD_BOT_TOKEN     = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URL  = process.env.DISCORD_REDIRECT_URL || `${BASE_URL}/discord/callback`;
const GUILD_ID = process.env.GUILD_ID || process.env.DISCORD_GUILD_ID;
const ROLE_ID  = process.env.ROLE_ID  || process.env.DISCORD_ROLE_ID_PRO;

const WHOP_SIGNING_SECRET = process.env.WHOP_SIGNING_SECRET || process.env.WHOP_WEBHOOK_SECRET; // usa UNO (ws_…)
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-please-long-random';

const SUCCESS_URL = process.env.SUCCESS_URL || `${BASE_URL}/redirect`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });

/* ========= Email (Gmail) ========= */
const {
  GMAIL_USER, GMAIL_PASS, FROM_EMAIL,
  DISCORD_DOWNLOAD_URL = 'https://discord.com/download',
  DISCORD_TUTORIAL_URL = 'https://youtu.be/_51EAeKtTs0',
  WHATSAPP_URL = 'https://wa.me/50400000000',
  TELEGRAM_URL = 'https://t.me/',
  LOGO_URL = '',
  FOOTER_IMAGE_URL = '',
  ADMIN_TEST_TOKEN // para /webhook/mock
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

/* ========= Email HTML (oscuro; sin IG/TikTok) ========= */
function buildWelcomeEmailHTML({ email, order_id, username = 'Trader' }) {
  const btn = 'display:inline-block;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700;';
  const p = 'margin:0 0 14px;line-height:1.6;';
  const redirectLink = `${BASE_URL}/redirect?email=${encodeURIComponent(email || '')}&order_id=${encodeURIComponent(order_id || '')}`;
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
            <p style="${p}">Estás a un paso de activar tu acceso. Descarga Discord (si no lo tienes), mira el tutorial y usa el botón para activar tu rol.</p>
            <div style="margin:18px 0 8px"><a href="${DISCORD_DOWNLOAD_URL}" style="${btn}background:#2b6cff;color:#fff">⬇️ Descargar Discord</a></div>
            <div style="margin:8px 0 18px"><a href="${DISCORD_TUTORIAL_URL}" style="${btn}background:#1f2633;color:#fff">▶️ Ver cómo crear tu cuenta</a></div>
            <div style="margin:18px 0">
              <a href="${redirectLink}" style="${btn}background:#16a34a;color:#fff">✓ Acceso al servidor (activar rol)</a>
              <p style="margin:8px 0 0;color:#98a1b3;font-size:12px">Enlace de un solo uso, expira en 24 horas.</p>
            </div>
            <hr style="border:none;border-top:1px solid #2a3240;margin:22px 0">
            <div style="margin:8px 0 20px">
              <a href="${WHATSAPP_URL}" style="${btn}background:#25D366;color:#111;margin-right:8px">💬 WhatsApp</a>
              <a href="${TELEGRAM_URL}" style="${btn}background:#8B5CF6;color:#fff">📣 Telegram</a>
            </div>
            <p style="color:#9ca3af;font-size:12px">Disclaimer: ${APP_NAME} es educativo; no es asesoría financiera.</p>
          </td></tr>
          ${FOOTER_IMAGE_URL ? `<tr><td><img src="${FOOTER_IMAGE_URL}" alt="banner" style="width:100%;display:block"></td></tr>` : ''}
        </table>
      </td></tr>
    </table>
  </div>`;
}

async function sendAccessEmail({ to, email, order_id, username }) {
  const html = buildWelcomeEmailHTML({ email, order_id, username });
  await sendEmail(to, { subject: `${APP_NAME} — Acceso y pasos (Discord)`, html });
}

/* ========= Supabase helpers ========= */
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
  if (!error) return false;               // insertó OK ⇒ primera vez
  return error.code === '23505';          // UNIQUE violation ⇒ ya usado
}
async function logWebhook(event_id, event_type, data) {
  try { await supabase.from('webhook_logs').insert({ event_id, event_type, data }); }
  catch (e) { console.log('webhook_logs insert error:', e?.message || e); }
}

/* ========= Parsers: RAW solo webhook ========= */
function rawBodySaver(req, _res, buf) { if (buf?.length) req.rawBody = buf; }
app.use((req, res, next) => {
  if (req.path === '/webhook/whop') express.raw({ type: 'application/json', verify: rawBodySaver })(req, res, next);
  else express.json()(req, res, next);
});

/* ========= Health ========= */
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

/* ========= Página post-pago (oscura, con pleca) ========= */
app.get('/redirect', (req, res) => {
  const { claim = '', email = '', order_id = '' } = req.query || {};
  res.set('Content-Type', 'text/html').send(`
  <!doctype html><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${APP_NAME} • Último paso</title>
  <style>
    :root{--bg:#000;--card:#0b0d10;--line:#1b212a;--text:#e6e9ef;--muted:#9aa3b2;--primary:#2b6cff}
    *{box-sizing:border-box}body{margin:0;background:#000;color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial}
    .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{width:100%;max-width:760px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
    h1{margin:0 0 8px;font-size:28px;line-height:1.2}.lead{margin:0 0 20px;font-size:16px;color:var(--muted)}
    .section-title{margin:18px 0 8px;font-weight:700;font-size:14px;letter-spacing:.25px;color:#cdd3dd;text-transform:uppercase}
    .terms{margin:0 0 16px;line-height:1.65}
    .pill{display:inline-flex;align-items:center;gap:10px;padding:10px 14px;border-radius:999px;background:#0f1217;border:1px solid #1b212a;cursor:pointer;user-select:none}
    .toggle{width:42px;height:24px;background:#222a35;border:1px solid #33404f;border-radius:999px;position:relative;transition:.2s}
    .knob{width:18px;height:18px;background:#cfd6e3;border-radius:50%;position:absolute;top:50%;left:2px;transform:translateY(-50%);transition:.2s}
    .on .toggle{background:#1d3b1a;border-color:#275b20}.on .knob{left:22px;background:#a9f5b6}
    .btn{margin-top:16px;padding:14px 18px;border:0;border-radius:12px;font-weight:800;background:var(--primary);color:#fff;cursor:pointer;width:100%;font-size:16px}
    .btn[disabled]{opacity:.45;cursor:not-allowed;filter:saturate(.7)}
    .hint{margin-top:14px;color:var(--muted);font-size:14px}
    .alert{margin-top:14px;padding:12px 14px;border-radius:10px;background:#1a0f0f;color:#ffd5d5;border:1px solid #3a2222;display:none}
    .alert.show{display:block}
  </style>
  <div class="wrap"><div class="card">
    <h1>Último paso para activar tu acceso</h1>
    <p class="lead">Estás a un solo paso de pertenecer a la academia más grande de Latinoamérica.</p>

    <div class="section-title">Términos y Condiciones</div>
    <p class="terms">
      NAZA Trading Academy es una entidad dedicada a la educación de trading. En ningún momento se prometen
      resultados financieros instantáneos ni se realizan sugerencias directas de inversión. Todo el contenido
      tiene un fin <b>exclusivamente educativo</b>. El uso del servicio es de <b>total responsabilidad del consumidor</b>.
    </p>

    <button id="accept" class="pill" aria-pressed="false" type="button">
      <span class="toggle"><span class="knob"></span></span>
      <span>Acepto Términos y Condiciones</span>
    </button>

    <button id="go" class="btn" disabled>Obtener acceso</button>

    <div id="alert" class="alert">Aún no tenemos tu enlace seguro. Usa tu correo de bienvenida para generarlo.</div>
    <p class="hint">Si el botón no se habilita, revisa tu correo de bienvenida (Spam/Promociones) y vuelve a intentarlo.</p>
  </div></div>

  <script>
    const order_id = ${JSON.stringify(order_id)};
    const email    = ${JSON.stringify(email)};
    let claim      = ${JSON.stringify(claim)};
    const go = document.getElementById('go');
    const accept = document.getElementById('accept');
    const alertBox = document.getElementById('alert');

    accept.addEventListener('click', async ()=>{
      const on = accept.getAttribute('aria-pressed') !== 'true';
      accept.setAttribute('aria-pressed', on ? 'true' : 'false');
      accept.classList.toggle('on', on);
      go.disabled = !on;

      if (on && !claim && order_id && email) {
        try {
          const r = await fetch('/api/claim/issue', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ order_id, email })
          });
          const j = await r.json();
          if (r.ok && j.claim) { claim = j.claim; alertBox.classList.remove('show'); }
          else { alertBox.classList.add('show'); }
        } catch { alertBox.classList.add('show'); }
      }
    });

    go.addEventListener('click', ()=>{
      if (go.disabled) return;
      if (!claim) { alertBox.classList.add('show'); return; }
      window.location.href = '/discord/login?claim=' + encodeURIComponent(claim);
    });
  </script>`);
});

/* ========= Seguridad: requireClaim ========= */
function requireClaim(req, res, next) {
  const { claim } = req.query || {};
  if (!claim) return res.status(401).send('🔒 Enlace inválido. Abre el botón desde tu correo.');
  try {
    req.claim = jwt.verify(claim, JWT_SECRET); // { membership_id, whop_user_id, jti, exp }
    return next();
  } catch {
    return res.status(401).send('⛔ Enlace vencido o usado. Solicita uno nuevo.');
  }
}

/* ========= OAuth2 Discord ========= */
app.get('/discord/login', requireClaim, (req, res) => {
  const state = jwt.sign(
    { ts: Date.now(), membership_id: req.claim.membership_id, whop_user_id: req.claim.whop_user_id, jti: req.claim.jti },
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

    // Bloqueo estricto de reuso ANTES de otorgar rol (evita carrera)
    if (await claimAlreadyUsed(st.membership_id, st.jti))
      return res.status(409).send('⛔ Este enlace ya fue usado.');

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

    const existing = await linkGet(st.membership_id);
    if (existing?.discord_id && existing.discord_id !== me.id)
      return res.status(403).send('⛔ Esta membresía ya está vinculada a otra cuenta.');

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

    if (!existing?.discord_id) await linkSet(st.membership_id, me.id);

    res.redirect(SUCCESS_URL);
  } catch (e) {
    console.error('DISCORD_CALLBACK_ERROR', e?.message || e);
    res.status(500).send('OAuth error');
  }
});

/* ========= Emisión de claim tras aceptar TyC ========= */
app.post('/api/claim/issue', async (req, res) => {
  try {
    const { order_id, email } = req.body || {};
    if (!order_id || !email) return res.status(400).json({ error: 'order_id y email requeridos' });

    const okEvents = ['payment_succeeded', 'membership_activated', 'membership_went_valid'];
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // última hora

    const { data, error } = await supabase
      .from('webhook_logs')
      .select('event_type, data, received_at')
      .gte('received_at', since)
      .order('received_at', { ascending: false })
      .limit(120);

    if (error) return res.status(500).json({ error: 'db_error' });

    const found = (data || []).find(r => {
      try {
        const d = r.data?.data || r.data;
        const em = (d?.user?.email || d?.email || '').toLowerCase();
        const id = d?.id || d?.membership_id || d?.order_id || '';
        return okEvents.includes(r.event_type) &&
               em === String(email).toLowerCase() &&
               String(id) === String(order_id);
      } catch { return false; }
    });

    if (!found) return res.status(404).json({ error: 'pago_no_validado' });

    const whop_user_id  = found.data?.data?.user?.id || found.data?.data?.user_id || 'UNKNOWN';
    const membership_id = found.data?.data?.id || found.data?.data?.membership_id || String(order_id);

    const claim = jwt.sign({ membership_id, whop_user_id, jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ claim });
  } catch (e) {
    console.error('issue_claim error', e?.message || e);
    res.status(500).json({ error: 'server_error' });
  }
});

/* ========= Webhook Whop (firma flexible + logging + email) ========= */
function getSignatureHeader(req) {
  return req.get('Whop-Signature') || req.get('X-Whop-Signature') || req.get('whop-signature') || '';
}
function verifyWhopV1(req) {
  if (!WHOP_SIGNING_SECRET) return true; // modo debug
  const v1 = (() => {
    const raw = getSignatureHeader(req);           // "t=...,v1=abcdef..."
    if (!raw) return '';
    const parts = Object.fromEntries(raw.split(',').map(s => s.trim().split('=')));
    return parts.v1 || raw;                         // por si viene solo el hash
  })();
  if (!v1) return false;
  const expected = crypto.createHmac('sha256', WHOP_SIGNING_SECRET).update(req.rawBody || Buffer.from('')).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(v1, 'utf8')); }
  catch { return false; }
}

const okEvents = new Set(['payment_succeeded', 'membership_activated', 'membership_went_valid']);
const cancelEvents = new Set(['membership_cancelled', 'membership_cancelled_by_user', 'membership_expired', 'membership_deactivated']);

app.post('/webhook/whop', async (req, res) => {
  try {
    const sigPresent = !!getSignatureHeader(req);
    if (!verifyWhopV1(req)) {
      console.log(sigPresent ? '⛔ invalid_signature header:' + getSignatureHeader(req) : '⚠️ Header de firma no encontrado.');
      return res.status(401).json({ error: 'invalid_signature' });
    }

    const body = JSON.parse((req.rawBody || Buffer.from('{}')).toString('utf8'));
    const action = body?.action || body?.event || 'unknown';
    const event_id = body?.id || body?.event_id || crypto.randomUUID();

    await logWebhook(event_id, action, body);

    const email = body?.data?.user?.email || body?.data?.email || null;
    const memberId = body?.data?.id || body?.data?.membership_id || null;

    if (okEvents.has(action) && email) {
      await sendAccessEmail({
        to: email,
        email,
        order_id: memberId || '',
        username: body?.data?.user?.username || body?.data?.user?.name || 'Trader'
      });
      console.log('📧 Email post-pago enviado a', email);
      return res.json({ status: 'claim_email_sent' });
    }

    if (cancelEvents.has(action) && memberId) {
      const linked = await linkGet(memberId);
      if (linked?.discord_id) {
        await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${linked.discord_id}/roles/${ROLE_ID}`, {
          method: 'DELETE', headers: { Authorization: 'Bot ' + DISCORD_BOT_TOKEN }
        });
        console.log('🗑️ Rol revocado por', action, linked.discord_id);
      }
      return res.json({ status: 'role_revoked' });
    }

    res.json({ status: 'ignored' });
  } catch (e) {
    console.error('WHOP_WEBHOOK_ERROR', e?.message || e);
    res.status(500).json({ error: 'server_error' });
  }
});

/* ========= Reenvío manual del correo ========= */
app.post('/email/resend', async (req, res) => {
  try {
    const to = String(req.body.to || req.body.email || '').trim().toLowerCase();
    const order_id = String(req.body.order_id || '').trim();
    const username = String(req.body.username || 'Trader');
    if (!to) return res.status(400).json({ error: 'email requerido' });
    await sendAccessEmail({ to, email: to, order_id, username });
    res.json({ ok: true });
  } catch (e) {
    console.error('email/resend error', e?.message || e);
    res.status(500).json({ error: 'server_error' });
  }
});

/* ========= DEBUG ROUTES ========= */

// 1) Verificar SMTP (Gmail)
app.get('/smtp-verify', async (_req, res) => {
  try {
    if (!GMAIL_USER || !GMAIL_PASS) {
      return res.status(200).send('Mailer inactivo: faltan GMAIL_USER/GMAIL_PASS');
    }
    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: GMAIL_USER, pass: GMAIL_PASS }
    });
    await transport.verify();
    res.send('SMTP OK ✅');
  } catch (e) {
    res.status(500).send('SMTP ERROR: ' + (e?.message || e));
  }
});

// 2) Últimos logs del webhook (compacto)
app.get('/debug/webhook-logs', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('webhook_logs')
      .select('event_type, received_at').order('received_at', { ascending: false }).limit(10);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// 3) Probar verificación de firma (GET instruye; POST verifica con body)
app.get('/debug/verify-signature', (req, res) => {
  res.status(200).send('Usa POST con body JSON a /debug/verify-signature. Header admitido: Whop-Signature / X-Whop-Signature / whop-signature');
});
app.post('/debug/verify-signature', (req, res) => {
  try {
    const header = getSignatureHeader(req) || null;
    const expected = WHOP_SIGNING_SECRET
      ? crypto.createHmac('sha256', WHOP_SIGNING_SECRET).update(Buffer.from(JSON.stringify(req.body || {}))).digest('hex')
      : null;
    res.json({ received_header: header, expected_if_signed: expected });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// 4) Simular un webhook OK (sin Whop) — requiere ADMIN_TEST_TOKEN
app.get('/webhook/mock', async (req, res) => {
  try {
    if (!ADMIN_TEST_TOKEN || req.query.token !== ADMIN_TEST_TOKEN) return res.status(401).send('UNAUTHORIZED');
    const body = {
      action: req.query.action || 'payment_succeeded',
      data: {
        id: req.query.membership_id || 'TEST-' + Date.now(),
        membership_id: req.query.membership_id || 'TEST-' + Date.now(),
        user: { id: req.query.user_id || 'U-' + Date.now(), email: req.query.email || 'test@example.com' },
        email: req.query.email || 'test@example.com'
      }
    };
    await supabase.from('webhook_logs').insert({ event_id: crypto.randomUUID(), event_type: body.action, data: body });
    if (body.data?.email) {
      await sendAccessEmail({ to: body.data.email, email: body.data.email, order_id: body.data.membership_id, username: 'Tester' });
    }
    res.json({ ok: true, inserted: body });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

console.log('🔧 Debug routes enabled');

/* ========= Start ========= */
app.listen(PORT, () => {
  console.log('🟢 NAZA.fx BOT on', BASE_URL);
  console.log('Redirect (T&C):', `${BASE_URL}/redirect`);
  console.log('Discord callback:', DISCORD_REDIRECT_URL);
  console.log('Webhook Whop:', `${BASE_URL}/webhook/whop`);
});
