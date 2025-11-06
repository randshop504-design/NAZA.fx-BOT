// NAZA.fx BOT — INDEX DEFINITIVO (Node 18+)
// Whop ↔ Render ↔ Discord + Supabase + Gmail
// Flujo: pago → /webhook/whop (valida + log + email) → /redirect (TyC) → claim 1-uso/24h → OAuth2 Discord → entra + rol
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

// fetch (Node 18+ ya trae global; polyfill por si acaso)
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
  INSTAGRAM_URL = 'https://instagram.com/',
  TIKTOK_URL = 'https://tiktok.com/@',
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
            <p style="${p}">Para activar tu acceso, acepta Términos y conecta tu Discord.</p>
            <div style="margin:18px 0">
              <a href="${redirectLink}" style="${btn}background:#2b6cff;color:#fff">Conectar con Discord</a>
              <p style="margin:8px 0 0;color:#98a1b3;font-size:12px">El botón muestra TyC y luego abre el login oficial de Discord.</p>
            </div>
            <div style="margin:18px 0 8px"><a href="${DISCORD_DOWNLOAD_URL}" style="${btn}background:#1f2633;color:#fff">⬇️ Descargar Discord</a></div>
            <div style="margin:8px 0 18px"><a href="${DISCORD_TUTORIAL_URL}" style="${btn}background:#1f2633;color:#fff">▶️ Ver tutorial</a></div>
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
  if (!error) return false;
  return error.code === '23505';
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

/* ========= Página post-pago (T&C) ========= */
app.get('/redirect', (req, res) => {
  const { claim = '', email = '', order_id = '' } = req.query || {};
  const page = `
  <!doctype html><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${APP_NAME} • Último paso</title>
  <style>
    body{margin:0;background:#0b0d10;color:#e6e9ef;font-family:system-ui,Segoe UI,Roboto,Arial}
    .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{width:100%;max-width:720px;background:#0f1217;border:1px solid #1b212a;border-radius:16px;padding:28px}
    h2{margin:0 0 10px} p{margin:0 0 10px;line-height:1.55}
    .pill{display:inline-block;border:1px solid #2a3240;border-radius:999px;padding:10px 18px;background:#0b0d10;cursor:pointer}
    .btn{padding:12
