// index.js — NAZA.fx BOT (final, Node 18, fetch nativo, SendGrid, Supabase)
// Flow:
// 1) Site (backend) -> POST /api/payment/notify (X-SHARED-SECRET header + body { plan_id, email, membership_id, user_name })
// 2) Bot issues 24h JWT claim, logs to Supabase, sends welcome email (SendGrid), returns redirect to /discord/login?claim=...
// 3) /discord/login -> starts Discord OAuth (requires claim)
// 4) /discord/callback -> exchange code, add to guild, assign role (exact match: plan_mensual => señales; plan_trimestral|plan_anual => mentoría), save link, mark claim used, redirect to DISCORD_INVITE_URL or SUCCESS_URL

require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');

const app = express();
app.use(express.json()); // JSON bodies

/* ================== REQUIRED ENV (use exact names) ==================
APP_BASE_URL
SHARED_SECRET
JWT_SECRET
SUPABASE_URL
SUPABASE_SERVICE_ROLE
SENDGRID_API_KEY
FROM_EMAIL
SUPPORT_EMAIL
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
DISCORD_BOT_TOKEN
GUILD_ID
DISCORD_REDIRECT_URL (optional, default BASE_URL/discord/callback)
DISCORD_INVITE_URL (fallback redirect)
ROLE_ID_SENALESDISCORD
ROLE_ID_MENTORIADISCORD
LOGO_URL (optional)
FOOTER_IMAGE_URL (optional)
================================================================== */

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const APP_NAME = process.env.APP_NAME || 'NAZA Trading Academy';

const SHARED_SECRET = process.env.SHARED_SECRET || 'NazaFxSuperSecretKey_2024_zzQ12AA';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-jwt-secret';

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });

// SendGrid
if (!process.env.SENDGRID_API_KEY) console.warn('⚠️ SENDGRID_API_KEY not set');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || `no-reply@nazatradingacademy.com`;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@nazatradingacademy.com';

// Discord / roles / redirects
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL || `${BASE_URL}/discord/callback`;
const DISCORD_INVITE_URL = process.env.DISCORD_INVITE_URL || null;
const SUCCESS_URL = process.env.SUCCESS_URL || `${BASE_URL}/success`;

const ROLE_ID_SENALES = process.env.ROLE_ID_SENALESDISCORD;
const ROLE_ID_MENTORIA = process.env.ROLE_ID_MENTORIADISCORD;
const ROLE_ID_ANUAL = process.env.ROLE_ID_ANUALDISCORD || ROLE_ID_MENTORIA;

// Assets
const LOGO_URL = process.env.LOGO_URL || '';
const FOOTER_IMAGE_URL = process.env.FOOTER_IMAGE_URL || '';
const DISCORD_DOWNLOAD_URL = process.env.DISCORD_DOWNLOAD_URL || 'https://discord.com/download';
const DISCORD_TUTORIAL_URL = process.env.DISCORD_TUTORIAL_URL || 'https://youtu.be/_51EAeKtTs0';

/* ================== Helpers ================== */
function escapeHtml(s){ if(!s) return ''; return String(s).replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]); }

async function logEvent(event_id, event_type, data){
  try{ await supabase.from('webhook_logs').insert({ event_id, event_type, data }); }
  catch(e){ console.log('logEvent error', e?.message || e); }
}
async function getLink(membership_id){
  if(!membership_id) return null;
  const { data } = await supabase.from('membership_links').select('membership_id,discord_id').eq('membership_id', membership_id).maybeSingle();
  return data || null;
}
async function upsertLink(membership_id, discord_id){
  if(!membership_id || !discord_id) return;
  try{ await supabase.from('membership_links').upsert({ membership_id, discord_id }, { onConflict: 'membership_id' }); }
  catch(e){ console.log('upsertLink error', e?.message || e); }
}
async function createClaimRecord(jti, membership_id){
  try{ await supabase.from('claims_issued').insert({ jti, membership_id }); } catch(e){ /* ignore dupes */ }
}
async function markClaimUsed(jti){
  try{ await supabase.from('claims_issued').update({ used_at: new Date().toISOString() }).eq('jti', jti).is('used_at', null); } catch(e){ console.log('markClaimUsed error', e?.message || e); }
}
async function checkClaimUsed(jti){
  if(!jti) return true;
  const { data } = await supabase.from('claims_issued').select('used_at').eq('jti', jti).maybeSingle();
  return !!(data?.used_at);
}

/* ================== Email builder (SendGrid) ================== */
function buildWelcomeEmailHTML({ name, email, claim, membership_id }){
  const claimLink = `${BASE_URL}/discord/login?claim=${encodeURIComponent(claim)}`;
  return `
  <div style="background:#071022;padding:24px;color:#e6eef8;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto">
      <tr><td align="center" style="padding:18px 0">
        ${LOGO_URL ? `<img src="${LOGO_URL}" alt="NAZA Trading Academy" style="width:120px;border-radius:8px;display:block;margin-bottom:12px">` : ''}
        <h1 style="margin:6px 0 0;font-size:26px;color:#fff">NAZA Trading Academy</h1>
        <p style="margin:8px 0 0;color:#bfc9d6">Bienvenido${name? ' ' + escapeHtml(name):''} — gracias por unirte a NAZA Trading Academy.</p>
      </td></tr>

      <tr><td align="center" style="padding:18px 16px">
        <p style="color:#d6dbe6;margin-bottom:12px">Para acceder a tus beneficios descarga Discord:</p>
        <a href="${DISCORD_DOWNLOAD_URL}" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#4b6bff;color:#fff;text-decoration:none;margin:6px">⬇️ Descargar Discord</a>
        <a href="${DISCORD_TUTORIAL_URL}" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#1f2633;color:#fff;text-decoration:none;margin:6px">▶️ Cómo crear tu cuenta (ES)</a>
      </td></tr>

      <tr><td align="center" style="padding:18px 16px">
        <p style="color:#d6dbe6;margin-bottom:10px">Acceso a Discord:</p>
        <a href="${claimLink}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#18a957;color:#fff;text-decoration:none;font-weight:700">Acceder al servidor</a>
        <div style="color:#98a3b4;font-size:12px;margin-top:8px">Enlace de un solo uso, expira en 24 horas.</div>
      </td></tr>

      <tr><td style="padding:18px 24px;color:#9fb6a3;font-size:13px">
        <p style="margin:6px 0">Soporte: <a href="mailto:${SUPPORT_EMAIL}" style="color:#cdebd8">${SUPPORT_EMAIL}</a></p>
        <p style="margin:6px 0">Sitio oficial: <a href="https://nazatradingacademy.com" style="color:#cdebd8">nazatradingacademy.com</a></p>
      </td></tr>

      ${FOOTER_IMAGE_URL ? `<tr><td align="center"><img src="${FOOTER_IMAGE_URL}" alt="" style="width:100%;display:block;margin-top:8px;border-radius:8px"></td></tr>` : ''}
    </table>
  </div>`;
}

/* ================== Endpoint: POST /api/payment/notify ==================
  Headers: X-SHARED-SECRET
  Body: { plan_id, email, membership_id, user_name }
====================================================================== */
app.post('/api/payment/notify', async (req, res) => {
  try {
    const secret = req.get('X-SHARED-SECRET') || '';
    if (!secret || secret !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });

    const { plan_id, email, membership_id, user_name } = req.body || {};
    if (!plan_id || !email || !membership_id) return res.status(400).json({ error: 'missing_fields' });

    // create single-use claim
    const jti = crypto.randomUUID();
    const payload = { membership_id, plan_id, user_name, jti };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h', jwtid: jti });

    // log + save claim
    await logEvent(membership_id || jti, 'payment_notify', { plan_id, email, membership_id, user_name });
    await createClaimRecord(jti, membership_id);

    // send welcome email (non-blocking)
    (async () => {
      try {
        const html = buildWelcomeEmailHTML({ name: user_name, email, claim: token, membership_id });
        await sgMail.send({ to: email, from: FROM_EMAIL, subject: `${APP_NAME} — Acceso y pasos (Discord)`, html });
        console.log('📧 Welcome email sent to', email);
      } catch (e) {
        console.error('sendgrid error', e?.message || e);
      }
    })();

    return res.json({ ok: true, claim: token, redirect: `${BASE_URL}/discord/login?claim=${encodeURIComponent(token)}` });
  } catch (e) {
    console.error('notify error', e?.message || e);
    return res.status(500).json({ error: 'server_error' });
  }
});

/* ================== Middleware / OAuth start ================== */
function requireClaim(req, res, next){
  const { claim } = req.query || {};
  if (!claim) return res.status(401).send('🔒 Enlace inválido. Abre desde tu correo o desde tu sitio.');
  try {
    req.claim = jwt.verify(claim, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).send('⛔ Enlace inválido o vencido.');
  }
}

app.get('/discord/login', requireClaim, (req, res) => {
  const state = jwt.sign({ ts: Date.now(), membership_id: req.claim.membership_id, jti: req.claim.jti, plan_id: req.claim.plan_id }, JWT_SECRET, { expiresIn: '10m' });
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

/* ================== OAuth callback ================== */
app.get('/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('missing_code_or_state');

    const st = jwt.verify(state, JWT_SECRET);
    if (await checkClaimUsed(st.jti)) return res.status(409).send('⛔ Este enlace ya fue usado.');

    // token exchange
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
    if (!tRes.ok) return res.status(400).send('Error obtaining token');
    const tJson = await tRes.json();
    const access_token = tJson.access_token;

    // get user
    const meRes = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${access_token}` }});
    if (!meRes.ok) return res.status(400).send('Error reading user');
    const me = await meRes.json();

    // join guild (best-effort)
    try {
      await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${me.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token })
      });
    } catch (e) { console.warn('join guild failed', e?.message || e); }

    // determine role based on exact plan_id values
    let roleToAssign = null;
    const planId = String(st.plan_id || '').trim();

    if (planId === 'plan_mensual') {
      roleToAssign = ROLE_ID_SENALES;
    } else if (planId === 'plan_trimestral' || planId === 'plan_anual') {
      roleToAssign = ROLE_ID_MENTORIA;
    } else {
      roleToAssign = ROLE_ID_MENTORIA; // default fallback
    }

    if (roleToAssign) {
      try{
        await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${me.id}/roles/${roleToAssign}`, {
          method: 'PUT', headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
        });
      } catch (e) { console.warn('assign role failed', e?.message || e); }
    }

    // persist link and mark claim used
    await upsertLink(st.membership_id, me.id);
    await markClaimUsed(st.jti);

    // redirect final (invite or success)
    const redirectTo = DISCORD_INVITE_URL || SUCCESS_URL;
    return res.redirect(redirectTo);
  } catch (e) {
    console.error('callback error', e?.message || e);
    return res.status(500).send('OAuth error');
  }
});

/* ================== Debug / health ================== */
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get('/_debug/logs', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('webhook_logs').select('event_type, received_at').order('received_at', { ascending: false }).limit(30);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

/* ================== Start server ================== */
app.listen(PORT, () => {
  console.log('🟢 NAZA.fx BOT running on', BASE_URL);
  console.log('POST /api/payment/notify → expects X-SHARED-SECRET');
  console.log('Discord OAuth callback:', DISCORD_REDIRECT_URL);
});
