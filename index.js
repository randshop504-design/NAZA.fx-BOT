// NAZA.fx BOT — INDEX FINAL (Gmail fix + Redirect a invite)
// Whop ↔ Render ↔ Discord + Supabase + Gmail
// Flujo: pago → webhook (valida+log+email) → /redirect (TyC) → claim 1-uso/24h → OAuth2 → entra+rol → invite/canal

require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

// Node 18+ trae fetch; polyfill si hace falta
const fetch = globalThis.fetch || ((...a)=>import('node-fetch').then(({default:f})=>f(...a)));
const app = express();

/* ========= ENV ========= */
const PORT      = process.env.PORT || 3000;
const BASE_URL  = process.env.RENDER_EXTERNAL_URL || process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const APP_NAME  = process.env.APP_NAME || 'NAZA Trading Academy';

const DISCORD_BOT_TOKEN     = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URL  = process.env.DISCORD_REDIRECT_URL || `${BASE_URL}/discord/callback`;
const GUILD_ID = process.env.GUILD_ID || process.env.DISCORD_GUILD_ID;
const ROLE_ID  = process.env.ROLE_ID  || process.env.DISCORD_ROLE_ID_PRO;

// Redirección final tras OAuth (elige en este orden)
const FINAL_REDIRECT =
  process.env.DISCORD_INVITE_URL
  || (process.env.DISCORD_WELCOME_CHANNEL_ID ? `https://discord.com/channels/${GUILD_ID}/${process.env.DISCORD_WELCOME_CHANNEL_ID}` : null)
  || process.env.SUCCESS_URL
  || `${BASE_URL}/redirect`;

const WHOP_SIGNING_SECRET = process.env.WHOP_SIGNING_SECRET || process.env.WHOP_WEBHOOK_SECRET; // usa UNO (ws_…)
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-please-long-random';
const TEST_MODE  = String(process.env.TEST_MODE || 'false').toLowerCase()==='true';

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth:{ persistSession:false } });

/* ========= Email (Gmail) ========= */
const {
  GMAIL_USER, GMAIL_PASS, FROM_EMAIL,
  DISCORD_DOWNLOAD_URL = 'https://discord.com/download',
  DISCORD_TUTORIAL_URL = 'https://youtu.be/_51EAeKtTs0',
  WHATSAPP_URL = 'https://wa.me/50400000000',
  TELEGRAM_URL = 'https://t.me/',
  LOGO_URL = '',
  FOOTER_IMAGE_URL = '',
  // PNGs estables (no SVG) para Gmail
  ICON_WHATSAPP_URL = 'https://img.icons8.com/color/48/whatsapp--v1.png',
  ICON_TELEGRAM_URL = 'https://img.icons8.com/color/48/telegram-app.png',
  ADMIN_TEST_TOKEN
} = process.env;

// Transport principal (465)
function buildTransport465(){
  return nodemailer.createTransport({
    host:'smtp.gmail.com',
    port:465,
    secure:true,
    auth:{ user:GMAIL_USER, pass:GMAIL_PASS },
    pool:true,
    tls:{ rejectUnauthorized:true, ciphers:'TLSv1.2' }
  });
}
// Transport alterno (587 STARTTLS)
function buildTransport587(){
  return nodemailer.createTransport({
    host:'smtp.gmail.com',
    port:587,
    secure:false,
    auth:{ user:GMAIL_USER, pass:GMAIL_PASS },
    requireTLS:true,
    tls:{ minVersion:'TLSv1.2' }
  });
}

let mailer = (GMAIL_USER && GMAIL_PASS) ? buildTransport465() : null;

// Envío con reintento (465 → 587)
async function sendEmail(to, { subject, html }) {
  if (!GMAIL_USER || !GMAIL_PASS) {
    console.log('📧 [FAKE EMAIL] Falta GMAIL_USER/GMAIL_PASS →', to, subject);
    return;
  }
  try {
    const info = await mailer.sendMail({ from: FROM_EMAIL || GMAIL_USER, to, subject, html });
    console.log('📧 Enviado (465):', info.messageId, '→', to);
  } catch (e) {
    console.error('❌ SEND_EMAIL_ERROR (465):', e && (e.response || e.message || e));
    try {
      const alt = buildTransport587();
      const info2 = await alt.sendMail({ from: FROM_EMAIL || GMAIL_USER, to, subject, html });
      console.log('📧 Enviado (587):', info2.messageId, '→', to);
      mailer = alt; // si 587 funcionó, dejamos este
    } catch (e2) {
      console.error('❌ SEND_EMAIL_ERROR (587):', e2 && (e2.response || e2.message || e2));
      throw e2;
    }
  }
}

function buildWelcomeEmailHTML({ email, order_id, username='Trader' }) {
  const btn = 'display:inline-block;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700;';
  const p   = 'margin:0 0 14px;line-height:1.6;';
  const redirectLink = `${BASE_URL}/redirect?email=${encodeURIComponent(email||'')}&order_id=${encodeURIComponent(order_id||'')}`;
  return `
  <div style="margin:0;padding:0;background:#0b0d10;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0b0d10">
      <tr><td align="center">
        <table role="presentation" width="640" style="max-width:640px;background:#0f1217;color:#e6e9ef;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;border:1px solid #1b212a;border-radius:12px;overflow:hidden;">
          ${LOGO_URL ? `<tr><td align="center" style="padding:22px"><img src="${LOGO_URL}" alt="logo" style="height:64px;border-radius:12px;border:1px solid #2a3240;display:block"></td></tr>` : ''}
          <tr><td align="center" style="padding:8px 24px 0">
            <h2 style="margin:0;font-size:22px;color:#fff">${APP_NAME}</h2>
            <p style="margin:6px 0 0;font-size:12px;color:#98a1b3">Si no ves este correo, revisa <b>Spam/Promociones</b>.</p>
          </td></tr>
          <tr><td style="padding:14px 24px">
            <p style="${p}">¡Bienvenido, <b>${username}</b>! 🎉</p>
            <p style="${p}">Desde hoy formas parte de una comunidad enfocada en libertad, resultados reales y crecimiento constante.</p>

            <div style="margin:18px 0">
              <a href="${DISCORD_DOWNLOAD_URL}" style="${btn}background:#5b6cff;color:#fff">⬇️ Descargar Discord</a>
              <a href="${DISCORD_TUTORIAL_URL}" style="${btn}background:#1f2633;color:#fff;margin-left:8px">▶️ Ver cómo crear tu cuenta</a>
            </div>

            <p style="margin:18px 0 8px;color:#9fb6a3">Si al pagar no conectaste tu Discord, reclámalo aquí:</p>
            <div style="margin:8px 0 18px">
              <a href="${redirectLink}" style="${btn}background:#18a957;color:#fff">Acceso al servidor (activar rol)</a>
              <div style="margin-top:6px;color:#98a1b3;font-size:12px">Enlace de un solo uso, expira en 24 horas.</div>
            </div>

            <hr style="border:none;border-top:1px solid #2a3240;margin:22px 0">

            <p style="${p}">Comunidades privadas</p>
            <div style="margin:10px 0 22px">
              <a href="${WHATSAPP_URL}" style="${btn}background:#1f6f3f;color:#fff">
                <img src="${ICON_WHATSAPP_URL}" alt="WhatsApp" width="18" height="18" style="vertical-align:middle;margin-right:8px;border:0;display:inline-block">WhatsApp
              </a>
              <a href="${TELEGRAM_URL}" style="${btn}background:#433e96;color:#fff;margin-left:8px">
                <img src="${ICON_TELEGRAM_URL}" alt="Telegram" width="18" height="18" style="vertical-align:middle;margin-right:8px;border:0;display:inline-block">Telegram
              </a>
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

/* ========= Parsers: RAW solo /webhook/whop ========= */
function rawBodySaver(req,_res,buf){ if (buf?.length) req.rawBody = buf; }
app.use((req,res,next)=>{
  if (req.path === '/webhook/whop') express.raw({ type:'application/json', verify: rawBodySaver })(req,res,next);
  else express.json()(req,res,next);
});

/* ========= Health ========= */
app.get('/health', (_req,res)=>res.json({ ok:true, ts:new Date().toISOString() }));

/* ========= Página post-pago (negra + TyC + switch) ========= */
app.get('/redirect', (req,res)=>{
  const { claim = '', email = '', order_id = '' } = req.query || {};
  res.set('Content-Type','text/html').send(`
  <!doctype html><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${APP_NAME} • Último paso</title>
  <style>
    :root{color-scheme:dark light}
    body{margin:0;background:#0b0d10;color:#e6e9ef;font-family:system-ui,Segoe UI,Roboto,Arial}
    .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{width:100%;max-width:820px;background:#0f1217;border:1px solid #1b212a;border-radius:16px;padding:28px}
    h1{margin:0 0 8px;font-size:40px;line-height:1.1}
    p{margin:0 0 12px;line-height:1.6}
    .title{font-weight:800}
    .pill{display:inline-flex;align-items:center;gap:10px;border:1px solid #2a3240;border-radius:999px;padding:10px 18px;background:#0b0d10;cursor:pointer}
    .switch{width:44px;height:24px;border-radius:999px;background:#243044;position:relative;transition:.2s}
    .dot{width:18px;height:18px;border-radius:50%;background:#9db0cf;position:absolute;top:3px;left:4px;transition:.2s}
    .switch[aria-checked="true"]{background:#1a7f45}
    .switch[aria-checked="true"] .dot{left:22px;background:#cdebd8}
    .btn{padding:16px 20px;border:0;border-radius:12px;background:#2b6cff;color:#fff;font-weight:800;font-size:20px}
    .btn[disabled]{opacity:.45;cursor:not-allowed}
    .hint{margin-top:16px;color:#98a1b3;font-size:14px}
    .warn{margin-top:16px;padding:14px;border-radius:12px;background:#3a1e1e;color:#ffd6d6;border:1px solid #5a2a2a}
  </style>
  <div class="wrap"><div class="card">
    <h1 class="title">Último paso para activar tu acceso</h1>
    <p>Estás a un solo paso de pertenecer a la academia más grande de Latinoamérica.</p>

    <h3 style="margin:18px 0 8px">TÉRMINOS Y CONDICIONES</h3>
    <p>NAZA Trading Academy es una entidad dedicada a la educación de trading. En ningún momento se prometen resultados financieros instantáneos ni se realizan sugerencias directas de inversión. Todo el contenido tiene un fin <b>exclusivamente educativo</b>. El uso del servicio es de <b>total responsabilidad del consumidor</b>.</p>

    <div style="margin:18px 0">
      <button id="accept" class="pill">
        <span id="sw" class="switch" role="switch" aria-checked="false"><span class="dot"></span></span>
        <span>Acepto Términos y Condiciones</span>
      </button>
    </div>

    <div style="margin-top:10px"><button id="go" class="btn" disabled>Obtener acceso</button></div>
    <div class="warn" id="warn" style="display:${claim?'none':'block'}">Aún no tenemos tu enlace seguro. Usa tu correo de bienvenida para generarlo.</div>
    <p class="hint">Si el botón no se habilita, revisa tu correo de bienvenida (Spam/Promociones) y vuelve a intentarlo.</p>
  </div></div>

  <script>
    const order_id = ${JSON.stringify(order_id)};
    const email    = ${JSON.stringify(email)};
    let claim      = ${JSON.stringify(claim)};
    const go = document.getElementById('go');
    const accept = document.getElementById('accept');
    const sw = document.getElementById('sw');
    const warn = document.getElementById('warn');

    function toggle(){
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
      go.disabled = !on;
    }
    accept.addEventListener('click', async ()=>{
      toggle();
      if (sw.getAttribute('aria-checked')==='true' && !claim && order_id && email){
        try{
          const r = await fetch('/api/claim/issue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order_id,email})});
          const j = await r.json(); if(r.ok && j.claim){ claim = j.claim; warn.style.display='none'; }
        }catch(e){}
      }
    });
    document.getElementById('go').addEventListener('click', ()=>{
      if (go.disabled) return;
      if (!claim){ alert('No se pudo generar tu enlace aún. Revisa tu correo.'); return; }
      location.href = '/discord/login?claim='+encodeURIComponent(claim);
    });
  </script>`);
});

/* ========= Seguridad: requireClaim para OAuth ========= */
function requireClaim(req,res,next){
  const { claim } = req.query || {};
  if(!claim) return res.status(401).send('🔒 Enlace inválido. Abre el botón desde tu correo.');
  try{ req.claim = jwt.verify(claim, JWT_SECRET); next(); }
  catch{ return res.status(401).send('⛔ Enlace vencido o usado. Solicita uno nuevo.'); }
}

/* ========= OAuth2 Discord ========= */
app.get('/discord/login', requireClaim, (req,res)=>{
  const state = jwt.sign(
    { ts:Date.now(), membership_id:req.claim.membership_id, whop_user_id:req.claim.whop_user_id, jti:req.claim.jti },
    JWT_SECRET, { expiresIn:'10m' }
  );
  const params = new URLSearchParams({
    client_id:DISCORD_CLIENT_ID, redirect_uri:DISCORD_REDIRECT_URL,
    response_type:'code', scope:'identify guilds.join', prompt:'consent', state
  });
  res.redirect('https://discord.com/api/oauth2/authorize?'+params.toString());
});

app.get('/discord/callback', async (req,res)=>{
  try{
    const { code, state } = req.query;
    if(!code) return res.status(400).send('Falta code');
    const st = jwt.verify(state, JWT_SECRET);

    const tRes = await fetch('https://discord.com/api/oauth2/token',{
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({
        client_id:DISCORD_CLIENT_ID, client_secret:DISCORD_CLIENT_SECRET,
        grant_type:'authorization_code', code, redirect_uri:DISCORD_REDIRECT_URL
      })
    });
    if(!tRes.ok) return res.status(400).send('Error al obtener token');
    const { access_token } = await tRes.json();

    const meRes = await fetch('https://discord.com/api/v10/users/@me',{ headers:{ Authorization:`Bearer ${access_token}` }});
    if(!meRes.ok) return res.status(400).send('Error leyendo usuario');
    const me = await meRes.json();

    if (await claimAlreadyUsed(st.membership_id, st.jti))
      return res.status(409).send('⛔ Este enlace ya fue usado.');

    const existing = await linkGet(st.membership_id);
    if (existing?.discord_id && existing.discord_id !== me.id)
      return res.status(403).send('⛔ Esta membresía ya está vinculada a otra cuenta.');

    // Join + role
    await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${me.id}`,{
      method:'PUT', headers:{ Authorization:'Bot '+DISCORD_BOT_TOKEN, 'Content-Type':'application/json' },
      body: JSON.stringify({ access_token })
    }).catch(()=>{});
    await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${me.id}/roles/${ROLE_ID}`,{
      method:'PUT', headers:{ Authorization:'Bot '+DISCORD_BOT_TOKEN }
    });

    if (!existing?.discord_id) await linkSet(st.membership_id, me.id);

    // Redirección final (usa tu invite si lo pusiste)
    res.redirect(FINAL_REDIRECT);
  }catch(e){
    console.error('DISCORD_CALLBACK_ERROR', e?.message || e);
    res.status(500).send('OAuth error');
  }
});

/* ========= Emisión de claim tras TyC ========= */
app.post('/api/claim/issue', async (req,res)=>{
  try{
    const { order_id, email } = req.body || {};
    if(!order_id || !email) return res.status(400).json({ error:'order_id y email requeridos' });

    const okEvents = ['payment_succeeded','membership_activated','membership_went_valid'];
    const since = new Date(Date.now()-24*60*60*1000).toISOString();

    const { data, error } = await supabase
      .from('webhook_logs')
      .select('event_type, data, received_at')
      .gte('received_at', since)
      .order('received_at',{ ascending:false })
      .limit(200);

    if (error) return res.status(500).json({ error:'db_error' });

    const found = (data||[]).find(r=>{
      try{
        const d  = r.data?.data || r.data;
        const em = (d?.user?.email || d?.email || '').toLowerCase();
        const id = d?.id || d?.membership_id || d?.order_id || '';
        return okEvents.includes(r.event_type) &&
               em === String(email).toLowerCase() &&
               String(id) === String(order_id);
      }catch{ return false; }
    });

    if (!found && !TEST_MODE) return res.status(404).json({ error:'pago_no_validado' });

    const whop_user_id  = found?.data?.data?.user?.id || found?.data?.data?.user_id || 'UNKNOWN';
    const membership_id = found?.data?.data?.id || found?.data?.data?.membership_id || String(order_id);

    const claim = jwt.sign({ membership_id, whop_user_id, jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn:'24h' });
    return res.json({ claim });
  }catch(e){
    console.error('issue_claim error', e?.message || e);
    res.status(500).json({ error:'server_error' });
  }
});

/* ========= Webhook Whop (firma flexible + logging + email) ========= */
function getWhopSignatureHeader(req){
  const names = ['Whop-Signature','X-Whop-Signature','whop-signature','x-whop-signature','WHOP-SIGNATURE','X-WHOP-SIGNATURE'];
  for (const n of names){ const v = req.get(n); if (v) return v; }
  return null;
}
function verifyWhopSignature(req){
  const sigHeader = getWhopSignatureHeader(req);
  if (!WHOP_SIGNING_SECRET) return { ok:true, reason:'sin_secret' };
  if (!sigHeader)          return { ok:TEST_MODE, reason:'header_missing' };
  // "t=...,v1=abcdef..." o "abcdef"
  const parts = Object.fromEntries(sigHeader.split(',').map(s=>s.trim().split('=')));
  const v1 = parts.v1 || sigHeader.trim();
  const expected = crypto.createHmac('sha256', WHOP_SIGNING_SECRET).update(req.rawBody).digest('hex');
  let ok = false;
  try{ ok = crypto.timingSafeEqual(Buffer.from(expected,'utf8'), Buffer.from(v1,'utf8')); }catch{ ok = false; }
  return { ok: ok || TEST_MODE, reason: ok ? 'valid' : (TEST_MODE ? 'test_mode' : 'mismatch') };
}

const OK_EVENTS     = new Set(['payment_succeeded','membership_activated','membership_went_valid']);
const CANCEL_EVENTS = new Set(['membership_cancelled','membership_cancelled_by_user','membership_expired','membership_deactivated']);

app.post('/webhook/whop', async (req,res)=>{
  try{
    const sig = verifyWhopSignature(req);
    if (!sig.ok) {
      console.log('⚠️ invalid_signature (motivo:', sig.reason, ')');
      return res.status(401).json({ error:'invalid_signature' });
    }

    const body   = JSON.parse(req.rawBody.toString('utf8'));
    const action = body?.action || body?.event || 'unknown';
    const event_id = body?.id || body?.event_id || crypto.randomUUID();

    await logWebhook(event_id, action, body);

    const email    = body?.data?.user?.email || body?.data?.email || null;
    const memberId = body?.data?.id || body?.data?.membership_id || null;

    if (OK_EVENTS.has(action) && email) {
      try {
        await sendAccessEmail({
          to:email, email,
          order_id: memberId || '',
          username: body?.data?.user?.username || body?.data?.user?.name || 'Trader'
        });
        console.log('📧 Post-pago enviado a', email);
      } catch (e) {
        console.error('❌ ERROR al enviar post-pago:', e?.response || e?.message || e);
      }
      return res.json({ status:'processed' });
    }

    if (CANCEL_EVENTS.has(action) && memberId) {
      const linked = await linkGet(memberId);
      if (linked?.discord_id){
        await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${linked.discord_id}/roles/${ROLE_ID}`,{
          method:'DELETE', headers:{ Authorization:'Bot '+DISCORD_BOT_TOKEN }
        });
        console.log('🗑️ Rol revocado por', action, linked.discord_id);
      }
      return res.json({ status:'role_revoked' });
    }

    res.json({ status:'ignored' });
  }catch(e){
    console.error('WHOP_WEBHOOK_ERROR', e?.message || e);
    res.status(500).json({ error:'server_error' });
  }
});

/* ========= Utilidades ========= */
app.post('/email/resend', async (req,res)=>{
  try{
    const to = String(req.body.to || req.body.email || '').trim().toLowerCase();
    const order_id = String(req.body.order_id || '').trim();
    const username = String(req.body.username || 'Trader');
    if (!to) return res.status(400).json({ error:'email requerido' });
    await sendAccessEmail({ to, email:to, order_id, username });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error:'server_error' }); }
});

/* ========= DEBUG (quítalas al lanzar) ========= */
app.get('/smtp-verify', async (_req,res)=>{
  try{
    if(!GMAIL_USER || !GMAIL_PASS) return res.status(200).send('Mailer inactivo: faltan GMAIL_USER/GMAIL_PASS');
    await mailer.verify();
    res.send('SMTP OK ✅ (465)');
  }catch(e){
    try{
      const alt = buildTransport587();
      await alt.verify();
      res.send('SMTP OK ✅ (587)');
      mailer = alt;
    }catch(e2){
      res.status(500).send('SMTP ERROR: '+(e2?.response || e2?.message || e2));
    }
  }
});

app.get('/debug/webhook-logs', async (_req,res)=>{
  try{
    const { data, error } = await supabase.from('webhook_logs')
      .select('event_type, received_at').order('received_at',{ascending:false}).limit(20);
    if (error) return res.status(500).json({ error:error.message });
    res.json(data||[]);
  }catch(e){ res.status(500).json({ error:String(e) }); }
});

app.get('/debug/verify-signature', (req,res)=>{
  const names = ['Whop-Signature','X-Whop-Signature','whop-signature','x-whop-signature','WHOP-SIGNATURE','X-WHOP-SIGNATURE'];
  const seen = names.map(n=>`${n}: ${req.get(n) || '-'}`).join(' | ');
  res.send('Headers → ' + seen);
});

// Enviar email de prueba SIN pagar (GET)
app.get('/mail/test', async (req,res)=>{
  try{
    const to = String(req.query.to || '').trim().toLowerCase();
    const id = String(req.query.id || 'TEST-1');
    if (!to) return res.status(400).send('Falta ?to=');
    await sendAccessEmail({ to, email:to, order_id:id, username:'Tester' });
    res.send('OK, test email enviado a '+to);
  }catch(e){ res.status(500).send('MAIL_TEST_ERROR: '+(e?.response || e?.message || e)); }
});

// Forzar email con datos en query (sin supabase) — útil si el webhook aún no llega
app.get('/mail/force', async (req,res)=>{
  try{
    const to = String(req.query.to || '').trim().toLowerCase();
    const id = String(req.query.id || 'TEST-FORCE');
    if (!to) return res.status(400).send('Falta ?to=');
    await sendAccessEmail({ to, email:to, order_id:id, username:'Trader' });
    res.send('OK, force email enviado a '+to);
  }catch(e){ res.status(500).send('MAIL_FORCE_ERROR: '+(e?.response || e?.message || e)); }
});

// Mock de webhook (sin Whop, para test)
app.get('/webhook/mock', async (req,res)=>{
  try{
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
    res.json({ ok:true, inserted: body });
  }catch(e){ res.status(500).json({ error: e?.message || String(e) }); }
});

console.log('🔧 Debug routes enabled');

/* ========= Start ========= */
app.listen(PORT, ()=>{
  console.log('🟢 NAZA.fx BOT on', BASE_URL);
  console.log('Redirect (T&C):', `${BASE_URL}/redirect`);
  console.log('Discord callback:', DISCORD_REDIRECT_URL);
  console.log('Webhook Whop:', `${BASE_URL}/webhook/whop`);
});
