// index.js - minimal NAZA core (Discord + SendGrid + Supabase + OAuth2 + admin curl)
require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
const fetch = global.fetch || require('node-fetch');

const app = express();
app.use(express.json());

// ========== CONFIG ==========
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL;
const GUILD_ID = process.env.GUILD_ID;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'no-reply@example.com';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || FROM_EMAIL;

const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';
const ORDER_PASSWORD = process.env.ORDER_PASSWORD || 'Alex13102001$$$';

// Role ids (env override allowed)
const ROLE_ID_MENSUAL = process.env.ROLE_ID_MENSUAL || '1430906969630183830';
const ROLE_ID_TRIMESTRAL = process.env.ROLE_ID_TRIMESTRAL || '1432149252016177233';
const ROLE_ID_ANUAL = process.env.ROLE_ID_ANUAL || '1432149252016177233';

// Minimal product->role map
const PRODUCT_ROLE_MAP = {
  'NRH364VHDNAX6': ROLE_ID_MENSUAL,
  'WB6B3EEG4T8RQ': ROLE_ID_TRIMESTRAL,
  'CFQ2Z3QEDSJYS': ROLE_ID_ANUAL
};

// ========== CLIENTS ==========
if (!SENDGRID_API_KEY) console.warn('⚠️ SENDGRID_API_KEY no definido. Emails no se enviarán.');
else sgMail.setApiKey(SENDGRID_API_KEY);

const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
if (DISCORD_BOT_TOKEN) {
  discordClient.login(DISCORD_BOT_TOKEN).catch(err => console.error('Discord login error:', err?.message || err));
}
discordClient.once('ready', () => {
  console.log('✅ Discord bot conectado:', discordClient.user?.tag || '(sin tag)');
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ========== HELPERS ==========
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

async function logAccess(membership_id = null, event_type = 'generic', detail = {}) {
  try {
    await supabase.from('access_logs').insert([{
      membership_id,
      event_type,
      detail: JSON.stringify(detail || {}),
      created_at: new Date().toISOString()
    }]);
  } catch (e) { console.warn('logAccess failed:', e?.message || e); }
}

function detectPlanKeyFromString(planIdRaw) {
  const txt = (planIdRaw || '').toString().toLowerCase();
  if (!txt) return 'other';
  if (txt.includes('mensual') || txt.includes('monthly') || txt.includes('30')) return 'plan_mensual';
  if (txt.includes('trimestral') || txt.includes('quarter') || txt.includes('90')) return 'plan_trimestral';
  if (txt.includes('anual') || txt.includes('annual') || txt.includes('365')) return 'plan_anual';
  return 'other';
}

function getRoleIdForPlan(planId) {
  if (PRODUCT_ROLE_MAP[planId]) return PRODUCT_ROLE_MAP[planId];
  const map = {
    'plan_mensual': ROLE_ID_MENSUAL,
    'plan_trimestral': ROLE_ID_TRIMESTRAL,
    'plan_anual': ROLE_ID_ANUAL
  };
  return map[detectPlanKeyFromString(planId)] || ROLE_ID_MENSUAL;
}

async function createClaimToken({ email, name = '', plan_id = '', subscriptionId = '', customerId = '', extra = {} }) {
  const emailN = (email || '').trim().toLowerCase();
  if (!emailN) throw new Error('Email requerido');
  const token = crypto.randomBytes(24).toString('hex');
  const row = {
    token, email: emailN, name, plan_id, subscription_id: subscriptionId, customer_id: customerId,
    last4: '', card_expiry: '', payment_fingerprint: '', used: false, extra: JSON.stringify(extra || {}),
    created_at: new Date().toISOString()
  };
  const { error } = await supabase.from('claims').insert([row]);
  if (error) throw error;
  await logAccess(null, 'claim_created', { email: emailN, plan_id, token_created: true });
  return token;
}

// NOTE: mantengo el HTML básico — si querés pegar la plantilla completa que tenías, la reemplazo sin tocarla.
function buildWelcomeText({ name, planName, subscriptionId, claimUrl, email }) {
  return `Hola ${name || 'usuario'},\n\nTu suscripción ha sido activada correctamente.\n\nAccede a Discord para reclamar tu rol:\n${claimUrl}\n\nPlan: ${planName}\nID suscripción: ${subscriptionId || ''}\nEmail: ${email || ''}\n\nSoporte: ${SUPPORT_EMAIL}\n`;
}

function buildWelcomeEmailHtml({ name, planName, claimUrl, email }) {
  // minimal HTML but safe; if quieres la plantilla larga exacta, la pego sin tocar.
  return `<div style="font-family:Arial,sans-serif;color:#111;">
    <h2>Bienvenido ${escapeHtml(name || 'usuario')}</h2>
    <p>Tu suscripción ha sido activada. Haz clic en el enlace para reclamar tu acceso en Discord:</p>
    <p><a href="${escapeHtml(claimUrl)}">${escapeHtml(claimUrl)}</a></p>
    <p>Plan: ${escapeHtml(planName)}</p>
    <p>Email: ${escapeHtml(email)}</p>
    <p>Soporte: ${escapeHtml(SUPPORT_EMAIL)}</p>
  </div>`;
}

async function sendWelcomeEmail(email, name, planId, subscriptionId = '', customerId = '', extra = {}, existingToken = null) {
  if (!SENDGRID_API_KEY) {
    console.warn('Skipping email: SENDGRID_API_KEY not set');
    return;
  }

  const planNames = {
    'plan_anual': 'Plan Anual',
    'plan_trimestral': 'Plan Trimestral',
    'plan_mensual': 'Plan Mensual',
    'other': 'Plan'
  };
  const planKey = detectPlanKeyFromString(planId);
  const planName = planNames[planKey] || 'Plan';

  let token = existingToken;
  if (!token) {
    token = await createClaimToken({ email, name, plan_id: planId, subscriptionId, customerId, extra });
  }

  const claimUrl = `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(DISCORD_CLIENT_ID)}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URL)}&response_type=code&scope=identify%20guilds.join&state=${encodeURIComponent(token)}`;

  const msg = {
    to: email,
    from: FROM_EMAIL,
    subject: `Bienvenido — Obtener acceso a NAZA`,
    text: buildWelcomeText({ name, planName, subscriptionId, claimUrl, email }),
    html: buildWelcomeEmailHtml({ name, planName, claimUrl, email })
  };

  await sgMail.send(msg);
  await logAccess(null, 'email_sent', { email, planId });
}

// ========== ADMIN endpoint (cURL) ==========
app.post('/api/admin/order', async (req, res) => {
  try {
    const receivedAdminKey = String(req.headers['x-admin-key'] || '');
    if (!receivedAdminKey || receivedAdminKey !== ADMIN_KEY) return res.status(401).send('Unauthorized admin key');

    const payload = req.body || {};
    if (!ORDER_PASSWORD || payload.order_password !== ORDER_PASSWORD) return res.status(401).send('Invalid order password');

    const { name, email, plan_id, last4, card_expiry, customer_id, subscription_id, discord_oauth_access_token, discord_id } = payload;
    if (!email || !plan_id) return res.status(400).send('Missing email or plan_id');

    const emailNormalized = String(email).trim().toLowerCase();
    const roleId = getRoleIdForPlan(plan_id);

    // expiration (30/90/365)
    const planKey = detectPlanKeyFromString(plan_id);
    const daysMap = { 'plan_mensual': 30, 'plan_trimestral': 90, 'plan_anual': 365 };
    const days = daysMap[planKey] || 30;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (days * 24 * 60 * 60 * 1000));

    const membershipRow = {
      email: emailNormalized, name: name || '', plan_id, subscription_id: subscription_id || '', customer_id: customer_id || '',
      discord_id: discord_id || null, discord_username: null, status: 'active', role_id: roleId, last4: last4 || '',
      card_expiry: card_expiry || '', payment_fingerprint: payload.payment_fingerprint || '',
      start_at: now.toISOString(), expires_at: expiresAt.toISOString(), role_assigned: false, pending_role_assignment: true, created_at: now.toISOString()
    };

    const { error: insErr, data: insData } = await supabase.from('memberships').insert([membershipRow]).select().limit(1);
    if (insErr) { console.error('Error saving membership:', insErr); return res.status(500).send('Error creando membresía'); }
    const created = (insData && insData[0]) ? insData[0] : null;
    await logAccess(created ? created.id : null, 'membership_created_admin', { email: emailNormalized, plan_id });

    // assign role immediately if discord_id provided
    if (discord_id && DISCORD_BOT_TOKEN && GUILD_ID) {
      try {
        const guild = await discordClient.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(discord_id);
        await member.roles.add(roleId);
        await supabase.from('memberships').update({ role_assigned: true, pending_role_assignment: false }).eq('id', created.id).catch(()=>{});
        await logAccess(created.id, 'role_assigned_admin_direct', { discordId: discord_id, roleId });
      } catch (err) {
        console.warn('Assign role attempt failed:', err?.message || err);
        await logAccess(created.id, 'role_assign_failed_admin_direct', { err: err?.message || err });
      }
    } else if (discord_oauth_access_token && DISCORD_BOT_TOKEN && GUILD_ID) {
      // optional: try to get user id from oauth token and assign role
      try {
        const userResp = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${discord_oauth_access_token}` }});
        const userData = await userResp.json();
        if (userData && userData.id) {
          const dId = userData.id;
          // best-effort invite + assign role
          try { await fetch(`https://discord.com/api/guilds/${GUILD_ID}/members/${dId}`, { method: 'PUT', headers: { 'Authorization': `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type':'application/json' }, body: JSON.stringify({ access_token: discord_oauth_access_token }) }); } catch(e){}
          try {
            const guild = await discordClient.guilds.fetch(GUILD_ID);
            const member = await guild.members.fetch(dId);
            await member.roles.add(roleId);
            await supabase.from('memberships').update({ role_assigned: true, pending_role_assignment: false, discord_id: dId, discord_username: userData.username }).eq('id', created.id).catch(()=>{});
            await logAccess(created.id, 'role_assigned_admin', { discordId: dId, roleId });
          } catch(e) { console.warn('Assign via oauth failed', e?.message || e); }
        }
      } catch(e){ console.warn('Admin oauth flow error:', e?.message || e); }
    }

    // send welcome email (best-effort, non-blocking)
    try { await sendWelcomeEmail(emailNormalized, name || '', plan_id, subscription_id || '', customer_id || '', { created_by: 'admin_curl' }); }
    catch (err) { console.warn('sendWelcomeEmail failed:', err?.message || err); await logAccess(created ? created.id : null, 'email_failed_admin', { err: err?.message || err }); }

    return res.json({ success: true, membership_id: created ? created.id : null });
  } catch (err) {
    console.error('Error in /api/admin/order:', err?.message || err);
    return res.status(500).send('Error interno');
  }
});

// ========== CLAIM redirect ==========
app.get('/api/auth/claim', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send('Token missing');
  try {
    const { data: rows, error } = await supabase.from('claims').select('id,token,used').eq('token', token).limit(1);
    if (error) { console.error('Error reading claim:', error); return res.status(500).send('Error interno'); }
    if (!rows || rows.length === 0) return res.status(400).send('Enlace inválido. Contacta soporte.');
    const claimRow = rows[0];
    if (claimRow.used) return res.status(400).send('Este enlace ya fue utilizado.');

    const clientId = encodeURIComponent(DISCORD_CLIENT_ID);
    const redirectUri = encodeURIComponent(DISCORD_REDIRECT_URL);
    const scope = encodeURIComponent('identify guilds.join');
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${encodeURIComponent(token)}`;

    return res.redirect(discordAuthUrl);
  } catch (err) { console.error('Error in /api/auth/claim:', err?.message || err); return res.status(500).send('Error interno'); }
});

// ========== DISCORD OAUTH CALLBACK ==========
app.get('/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Faltan parámetros');

    const { data: claimsRows, error: claimErr } = await supabase.from('claims').select('*').eq('token', state).limit(1);
    if (claimErr) console.error('Error reading claim:', claimErr);
    const claimData = (claimsRows && claimsRows[0]) ? claimsRows[0] : null;
    if (!claimData) return res.status(400).send('Sesión expirada o inválida');
    if (claimData.used) return res.status(400).send('Este enlace ya fue usado.');

    const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: DISCORD_REDIRECT_URL });
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type':'application/x-www-form-urlencoded' }, body: params.toString() });
    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) { console.error('Error obtaining token:', tokenData); return res.status(400).send('Error de autorización'); }

    const userResponse = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenData.access_token}` }});
    const userData = await userResponse.json();
    const discordId = userData.id;
    const discordUsername = userData.username;

    // Try add to guild (best-effort)
    try { await fetch(`https://discord.com/api/guilds/${GUILD_ID}/members/${discordId}`, { method: 'PUT', headers: { 'Authorization': `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: tokenData.access_token }) }).catch(()=>{}); } catch(e){}

    // Insert membership
    const planId = claimData.plan_id;
    const roleId = getRoleIdForPlan(planId);
    const startAt = new Date();
    const daysMap = { 'plan_mensual': 30, 'plan_trimestral': 90, 'plan_anual': 365 };
    const days = daysMap[detectPlanKeyFromString(planId)] || 30;
    const expiresAt = new Date(startAt.getTime() + (days * 24 * 60 * 60 * 1000));

    const membershipRow = {
      email: (claimData.email || '').toLowerCase(), name: claimData.name || '', plan_id: claimData.plan_id || '',
      subscription_id: claimData.subscription_id || '', customer_id: claimData.customer_id || '', discord_id: discordId,
      discord_username: discordUsername, status: 'active', role_id: roleId, last4: claimData.last4 || '', card_expiry: claimData.card_expiry || '',
      payment_fingerprint: claimData.payment_fingerprint || '', start_at: startAt.toISOString(), expires_at: expiresAt.toISOString(),
      role_assigned: false, pending_role_assignment: true, created_at: new Date().toISOString()
    };

    const { error: insErr } = await supabase.from('memberships').insert(membershipRow);
    if (insErr) { console.error('Error saving membership from claim:', insErr); await supabase.from('claims').update({ manual_review: true }).eq('token', state).catch(()=>{}); return res.status(500).send('No se pudo crear la membresía. Contacta soporte.'); }
    await logAccess(null, 'membership_created_claim', { email: membershipRow.email, discordId, plan: planId });

    // mark claim used
    await supabase.from('claims').update({ used: true, used_at: new Date().toISOString() }).eq('token', state).catch(()=>{});
    await logAccess(null, 'claim_marked_used', { token: state });

    // Assign role (retry simple)
    let assigned = false;
    for (let attempt=0; attempt<3; attempt++) {
      try {
        const guild = await discordClient.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(discordId);
        await member.roles.add(roleId);
        assigned = true;
        await supabase.from('memberships').update({ role_assigned: true, pending_role_assignment: false }).eq('discord_id', discordId).catch(()=>{});
        await logAccess(null, 'role_assigned_claim', { discordId, roleId });
        break;
      } catch (e) { console.warn('Assign role attempt failed (claim):', e?.message || e); await new Promise(r => setTimeout(r, 300 * (attempt+1))); }
    }
    if (!assigned) await logAccess(null, 'role_assign_permanent_fail_claim', { discordId, roleId });

    return res.send(`<html><body><h1>¡Bienvenido!</h1><p>Tu rol ha sido asignado (si corresponde). Puedes cerrar esta ventana.</p><p><a href="${BASE_URL}">Ir</a></p></body></html>`);
  } catch (err) { console.error('Error in /discord/callback:', err?.message || err); return res.status(500).send('Error procesando la autorización'); }
});

// ========== EXPIRATIONS: quita rol (no kick) ==========
const JOB_INTERVAL_MS = (process.env.JOB_INTERVAL_MS && Number(process.env.JOB_INTERVAL_MS)) || (5 * 60 * 1000);
async function processExpirations(){
  try {
    const { data: rows } = await supabase.from('memberships').select('*').lt('expires_at', new Date().toISOString()).eq('status','active').limit(200);
    if (!rows || rows.length === 0) return;
    for (const r of rows) {
      try {
        if (r.discord_id && r.role_id) {
          try {
            const guild = await discordClient.guilds.fetch(GUILD_ID);
            const member = await guild.members.fetch(r.discord_id);
            await member.roles.remove(r.role_id);
            await logAccess(r.id, 'role_removed_on_expiry', { discord_id: r.discord_id, role_id: r.role_id });
          } catch (e) { console.warn('Could not remove role on expiry:', e?.message || e); await logAccess(r.id, 'role_remove_expiry_failed', { err: e?.message || e }); }
        }
        await supabase.from('memberships').update({ status: 'expired', expired_at: new Date().toISOString(), role_assigned: false }).eq('id', r.id);
      } catch(e){ console.warn('Error processing expiry for membership', r.id, e?.message || e); }
    }
  } catch(e){ console.error('Error in processExpirations job:', e?.message || e); }
}
setInterval(processExpirations, JOB_INTERVAL_MS);

// ========== HEALTH & START ==========
app.get('/health', (req, res) => res.json({ status:'ok', timestamp: new Date().toISOString() }));
app.listen(PORT, () => console.log('🚀 NAZA Bot - iniciado', { port: PORT, url: BASE_URL }));
