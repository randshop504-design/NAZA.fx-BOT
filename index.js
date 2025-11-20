// index.js — NAZA.fx BOT (Node >=18)

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const braintree = require('braintree');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 30 * 1000,
  max: 30
});
app.use(limiter);

// CORS allowlist
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  }
};
app.use(cors(corsOptions));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const APP_NAME = process.env.APP_NAME || 'NAZA Trading Academy';

const SHARED_SECRET = process.env.SHARED_SECRET || process.env.X_SHARED_SECRET || 'change-this-shared-secret';
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-jwt-secret';
const FRONTEND_TOKEN = process.env.FRONTEND_TOKEN || null;

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });

// SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');
const FROM_EMAIL = process.env.FROM_EMAIL || `no-reply@nazatradingacademy.com`;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@nazatradingacademy.com';

// Braintree
const BT_ENV_RAW = (process.env.BRAINTREE_ENV || process.env.BT_ENVIRONMENT || 'sandbox').toLowerCase();
const BT_ENV = (BT_ENV_RAW === 'production' || BT_ENV_RAW === 'prod') ? braintree.Environment.Production : braintree.Environment.Sandbox;

const gateway = new braintree.BraintreeGateway({
  environment: BT_ENV,
  merchantId: process.env.BRAINTREE_MERCHANT_ID || '',
  publicKey: process.env.BRAINTREE_PUBLIC_KEY || '',
  privateKey: process.env.BRAINTREE_PRIVATE_KEY || ''
});

// Discord
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const GUILD_ID = process.env.GUILD_ID || '';
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL || `${BASE_URL}/discord/callback`;
const DISCORD_INVITE_URL = process.env.DISCORD_INVITE_URL || null;
const SUCCESS_URL = process.env.SUCCESS_URL || `${BASE_URL}/success`;

// Role IDs
const ROLE_ID_SENALES = process.env.ROLE_ID_SENALES || null;
const ROLE_ID_MENTORIA = process.env.ROLE_ID_MENTORIA || null;
const ROLE_ID_ANUAL = process.env.ROLE_ID_ANUAL || process.env.ROLE_ID_MENTORIA || null;

// Official plan ids
const PLAN_IDS = {
  MENSUAL: "plan_mensual",
  TRIMESTRAL: "plan_trimestral",
  ANUAL: "plan_anual"
};

// ---------------------------
// PRODUCT_NAME -> PLAN_ID MAP
// ---------------------------
const PRODUCT_NAME_TO_PLAN = {
  'plan mensual de señales 🛰️': PLAN_IDS.MENSUAL,
  'educación desde cero🧑‍🚀👩‍🚀': PLAN_IDS.TRIMESTRAL,
  'educación total 🏅': PLAN_IDS.ANUAL
};

// Normalización ligera (opción 2) — elimina emojis y limpia espacios
function removeEmojisAndTrim(s){
  if(!s) return '';
  return String(s)
    .replace(/([\u231A-\u32FF\uD83C-\uDBFF\uDC00-\uDFFF\u200D])/g, '')
    .replace(/\s+/g,' ')
    .trim();
}

function normalizeName(s){
  if(!s) return '';
  return removeEmojisAndTrim(String(s))
    .toLowerCase()
    .replace(/\s+/g,' ')
    .trim();
}

function resolvePlanId({ plan_id, product_name }){
  if (plan_id && String(plan_id).trim()) return String(plan_id).trim();

  const normalized = normalizeName(product_name);
  if (!normalized) return null;

  for (const [key, val] of Object.entries(PRODUCT_NAME_TO_PLAN)){
    if (normalizeName(key) === normalized) return val;
  }
  return null;
}

// Helpers
async function logEvent(event_id, event_type, data){
  try{
    await supabase.from('webhook_logs').insert({ event_id, event_type, data });
  } catch(e){}
}

async function upsertLink(membership_id, discord_id){
  try{
    await supabase.from('membership_links').upsert({ membership_id, discord_id }, { onConflict: 'membership_id' });
  } catch(e){}
}

async function createClaimRecord(jti, membership_id){
  try{
    await supabase.from('claims_issued').insert({ jti, membership_id });
  } catch(e){}
}

async function markClaimUsed(jti){
  try{
    await supabase.from('claims_issued')
      .update({ used_at: new Date().toISOString() })
      .eq('jti', jti)
      .is('used_at', null);
  } catch(e){}
}

async function checkClaimUsed(jti){
  try{
    const { data } = await supabase
      .from('claims_issued')
      .select('used_at')
      .eq('jti', jti)
      .maybeSingle();

    return !!(data?.used_at);
  } catch(e){
    return true;
  }
}

// Email
function buildWelcomeEmailHTML({ name, email, claim }){
  const link = `${BASE_URL}/discord/login?claim=${encodeURIComponent(claim)}`;
  return `
  <div style="padding:24px;background:#071022;color:#fff">
    <h1>NAZA Trading Academy</h1>
    <p>Hola ${name || ''}, gracias por unirte.</p>
    <a href="${link}" style="background:#18a957;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">Acceder al servidor</a>
  </div>`;
}

// Core handler
async function handleConfirmedPayment({ plan_id, email, membership_id, user_name }){
  const jti = crypto.randomUUID();
  const payload = { membership_id, plan_id, user_name };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h', jwtid: jti });

  await logEvent(membership_id, 'payment_confirmed', { plan_id, email, membership_id, user_name });
  await createClaimRecord(jti, membership_id);

  (async ()=>{
    try{
      await sgMail.send({
        to: email,
        from: FROM_EMAIL,
        subject: `${APP_NAME} — Acceso Discord`,
        html: buildWelcomeEmailHTML({ name: user_name, email, claim: token })
      });
    }catch(e){}
  })();

  return {
    claim: token,
    redirect: `${BASE_URL}/discord/login?claim=${encodeURIComponent(token)}`
  };
}

// ---------------- ROUTES ----------------

app.post('/api/payment/notify', async (req, res) => {
  try{
    const secret = req.get('X-SHARED-SECRET') || '';
    if(secret !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });

    const { plan_id: incoming_plan, product_name, email, membership_id, user_name } = req.body;

    const plan_id = resolvePlanId({ plan_id: incoming_plan, product_name });

    if(!plan_id || !email || !membership_id)
      return res.status(400).json({ error: 'missing_fields_or_plan_not_resolved' });

    const result = await handleConfirmedPayment({ plan_id, email, membership_id, user_name });

    return res.json({ ok: true, claim: result.claim, redirect: result.redirect });

  }catch(e){
    return res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/payment/confirm', async (req, res) => {
  try{
    const secret = req.get('X-SHARED-SECRET') || '';
    if(secret !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });

    const { plan_id: incoming_plan, product_name, email, membership_id, user_name } = req.body;

    const plan_id = resolvePlanId({ plan_id: incoming_plan, product_name });

    if(!plan_id || !email || !membership_id)
      return res.status(400).json({ error: 'missing_fields_or_plan_not_resolved' });

    const result = await handleConfirmedPayment({ plan_id, email, membership_id, user_name });

    return res.json({ ok: true, claim: result.claim, redirect: result.redirect });

  }catch(e){
    return res.status(500).json({ error: 'server_error' });
  }
});

// ---------- Discord OAuth ----------

function requireClaim(req, res, next){
  const { claim } = req.query;
  if(!claim) return res.status(401).send('Enlace inválido');
  try{
    req.claim = jwt.verify(claim, JWT_SECRET);
    next();
  }catch(e){
    return res.status(401).send('Enlace vencido');
  }
}

app.get('/discord/login', requireClaim, (req, res) => {
  const state = jwt.sign({
    ts: Date.now(),
    membership_id: req.claim.membership_id,
    plan_id: req.claim.plan_id
  }, JWT_SECRET, { expiresIn: '10m' });

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
  try{
    const { code, state } = req.query;
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

    const tJson = await tRes.json();
    const access_token = tJson.access_token;

    const meRes = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const me = await meRes.json();

    try{
      await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${me.id}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ access_token })
      });
    }catch(e){}

    let roleToAssign = null;
    const planId = String(st.plan_id || '').trim();

    if(planId === PLAN_IDS.MENSUAL) roleToAssign = ROLE_ID_SENALES;
    else if(planId === PLAN_IDS.TRIMESTRAL) roleToAssign = ROLE_ID_MENTORIA;
    else if(planId === PLAN_IDS.ANUAL) roleToAssign = ROLE_ID_ANUAL;

    if(roleToAssign){
      try{
        await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${me.id}/roles/${roleToAssign}`, {
          method: 'PUT',
          headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
        });
      }catch(e){}
    }

    await upsertLink(st.membership_id, me.id);

    return res.redirect(DISCORD_INVITE_URL || SUCCESS_URL);

  }catch(e){
    return res.status(500).send('OAuth error');
  }
});

// Health check for Render
app.get('/health', (_req, res) =>
  res.status(200).json({ ok: true, ts: new Date().toISOString() })
);

app.listen(PORT, () => {
  console.log('🟢 NAZA.fx BOT running on', BASE_URL);
});
