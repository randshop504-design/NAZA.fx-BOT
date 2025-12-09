// index.js - NAZA Bot (final, robusto) - VALIDACIÓN de contraseña tolerante
require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
const fetch = global.fetch || (() => { try { return require('node-fetch'); } catch(e){ return null; } })();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =================== CONFIG
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'no-reply@example.com';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@example.com';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL || '';
const GUILD_ID = process.env.GUILD_ID || '';
const ROLE_ID_ANUALDISCORD = process.env.ROLE_ID_ANUALDISCORD || process.env.ROLE_ID_ANUAL || '';
const ROLE_ID_MENTORIADISCORD = process.env.ROLE_ID_MENTORIADISCORD || process.env.ROLE_ID_TRIMESTRAL || '';
const ROLE_ID_SENALESDISCORD = process.env.ROLE_ID_SENALESDISCORD || process.env.ROLE_ID_MENSUAL || '';
const FRONTEND_URL = process.env.FRONTEND_URL || '';

// IMPORTANT: default literal password requested by user
const API_PASSWORD = process.env.API_PASSWORD || 'Alex13102001$$$';
const FRONTEND_TOKEN = process.env.x_frontend_token || process.env.FRONTEND_TOKEN || process.env.x_frontend_token || process.env.FRONTEND_TOKEN || process.env.FRONTEND_TOKEN || 'naza_frontend_secret_2024';

// Configure SendGrid
if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);
else console.warn('⚠️ SENDGRID_API_KEY no definido. No se enviarán correos.');

// Supabase client (service role)
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.warn('⚠️ SUPABASE variables no encontradas.');
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  global: {
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      apikey: SUPABASE_SERVICE_ROLE
    }
  }
});

// Discord client
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
if (DISCORD_BOT_TOKEN) {
  discordClient.login(DISCORD_BOT_TOKEN).catch(err => console.error('Error login Discord:', err));
} else {
  console.warn('⚠️ DISCORD_BOT_TOKEN no definido.');
}
discordClient.once('ready', () => {
  console.log('✅ Discord listo:', discordClient.user?.tag || '(sin tag aún)');
});

// Utilities
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// NEW: Validate password from body OR header 'x-admin-key'
// Accepts:
//  - JSON body: { password: "Alex13102001$$$" }
//  - HTTP header: "x-admin-key: Alex13102001$$$"
function validatePasswordFromBody(req) {
  try {
    const sentBody = (req.body && req.body.password) ? String(req.body.password) : '';
    const sentHeader = req.headers && (req.headers['x-admin-key'] || req.headers['x-admin_key'] || req.headers['x-adminkey']) ? String(req.headers['x-admin-key'] || req.headers['x-admin_key'] || req.headers['x-adminkey']) : '';
    // Accept either location. Exact literal comparison.
    if (sentBody && sentBody === API_PASSWORD) return true;
    if (sentHeader && sentHeader === API_PASSWORD) return true;
    return false;
  } catch (err) {
    console.warn('validatePasswordFromBody exception', err);
    return false;
  }
}

// Log masked API_PASSWORD at startup (not full value)
function maskedSecret(s) {
  if (!s) return '(empty)';
  if (s.length <= 6) return '******';
  return s.slice(0,2) + '...' + s.slice(-2);
}
console.log('🔐 API_PASSWORD (masked) =', maskedSecret(API_PASSWORD));
console.log('🔐 FRONTEND_TOKEN (masked) =', maskedSecret(FRONTEND_TOKEN));

// ================= Email templates (bienvenida + expiración)
function buildWelcomeEmailHtml({ name, planName, subscriptionId, claimUrl, email, supportEmail, token }) {
  const logoPath = process.env.LOGO_URL || '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"/></head><body style="background:#000;color:#fff;font-family:Arial,sans-serif;padding:24px;">
    <div style="max-width:680px;margin:0 auto;background:rgba(255,255,255,0.02);padding:24px;border-radius:12px;">
      <h1 style="color:#ff9b3b;">NAZA Trading Academy</h1>
      <p>Hola ${escapeHtml(name || 'usuario')},</p>
      <p>Tu suscripción (${escapeHtml(planName)}) está activa. Pulsa el botón para obtener acceso en Discord.</p>
      <p style="text-align:center;"><a href="${claimUrl}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#2d9bf0;color:#fff;text-decoration:none;">Obtener acceso</a></p>
      <p>Si hay problemas, contacta: <a href="mailto:${supportEmail}">${supportEmail}</a></p>
    </div>
  </body></html>`;
}

function buildExpiryEmailHtml({ name, planName, membershipId, email, reactivateUrl }) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"/></head><body style="background:#000;color:#fff;font-family:Arial,sans-serif;padding:24px;">
    <div style="max-width:680px;margin:0 auto;background:rgba(255,255,255,0.02);padding:24px;border-radius:12px;">
      <h2 style="color:#ff9b3b;">Tu acceso ha expirado</h2>
      <p>Hola ${escapeHtml(name || 'usuario')},</p>
      <p>Tu suscripción ${escapeHtml(planName || '')} asociada a ${escapeHtml(email || '')} ha expirado y tus permisos en Discord fueron revocados.</p>
      <p style="text-align:center;"><a href="${reactivateUrl}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#2d9bf0;color:#fff;text-decoration:none;">Reactivar mi acceso</a></p>
      <p>Soporte: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
    </div>
  </body></html>`;
}

async function sendWelcomeEmail(email, name, planId, subscriptionId, customerId, extra = {}, existingToken = null) {
  if (!SENDGRID_API_KEY) throw new Error('SENDGRID no configurado');
  const planNames = { 'plan_anual':'Plan Anual', 'plan_trimestral':'Plan Trimestral', 'plan_mensual':'Plan Mensual' };
  const planName = planNames[planId] || planId || 'Plan';
  let token = existingToken || crypto.randomBytes(24).toString('hex');
  const claimUrl = `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(DISCORD_CLIENT_ID)}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URL)}&response_type=code&scope=identify%20guilds.join&state=${encodeURIComponent(token)}`;
  const html = buildWelcomeEmailHtml({ name, planName, subscriptionId, claimUrl, email, supportEmail: SUPPORT_EMAIL, token });
  const text = `Hola ${name || 'usuario'}, obtén acceso: ${claimUrl}`;
  const msg = { to: email, from: FROM_EMAIL, subject: `¡Bienvenido a NAZA Trading Academy!`, text, html };
  console.log('DEBUG sendWelcomeEmail -> token:', token);
  await sgMail.send(msg);
  return token;
}

async function sendExpiryEmail(membership) {
  if (!SENDGRID_API_KEY) {
    console.warn('No SENDGRID -> no se envía expiry email.');
    return false;
  }
  try {
    const planNames = { 'plan_anual':'Plan Anual', 'plan_trimestral':'Plan Trimestral', 'plan_mensual':'Plan Mensual' };
    const planName = planNames[membership.plan] || membership.plan || 'Plan';
    const reactivateUrl = FRONTEND_URL ? `${FRONTEND_URL}/reactivar?membership=${encodeURIComponent(membership.id)}&email=${encodeURIComponent(membership.email)}` : `mailto:${SUPPORT_EMAIL}?subject=Reactivacion de membership ${membership.id}`;
    const html = buildExpiryEmailHtml({ name: membership.name, planName, membershipId: membership.id, email: membership.email, reactivateUrl });
    const text = `Hola ${membership.name || ''}, tu suscripción (${planName}) ha expirado. Reactiva: ${reactivateUrl}`;
    const msg = { to: membership.email, from: FROM_EMAIL, subject: `Tu acceso a NAZA ha expirado — reactivá tu cuenta`, text, html };
    await sgMail.send(msg);
    return true;
  } catch (err) {
    console.error('Error enviando expiry email:', err);
    return false;
  }
}

// ================= Role helpers (API + discord.js fallback)
async function addRoleToMemberViaApi(discordId, roleId) {
  if (!discordId || !roleId || !GUILD_ID || !DISCORD_BOT_TOKEN) return false;
  try {
    const url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}/roles/${roleId}`;
    const resp = await fetch(url, { method: 'PUT', headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type':'application/json' } });
    if (resp && resp.status === 204) return true;
    const text = await resp.text().catch(()=>'<no-body>');
    console.warn('addRoleToMemberViaApi status', resp?.status, text?.substring(0,400));
    return false;
  } catch (err) {
    console.error('addRoleToMemberViaApi error', err);
    return false;
  }
}

async function removeRoleFromMemberViaApi(discordId, roleId) {
  if (!discordId || !roleId || !GUILD_ID || !DISCORD_BOT_TOKEN) return false;
  try {
    const url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}/roles/${roleId}`;
    const resp = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } });
    if (resp && resp.status === 204) return true;
    const text = await resp.text().catch(()=>'<no-body>');
    console.warn('removeRoleFromMemberViaApi status', resp?.status, text?.substring(0,400));
    return false;
  } catch (err) {
    console.error('removeRoleFromMemberViaApi error', err);
    return false;
  }
}

async function assignDiscordRole(discordId, roleId) {
  if (!discordId || !roleId) return false;
  // 1) try API
  try {
    const okApi = await addRoleToMemberViaApi(discordId, roleId);
    if (okApi) return true;
  } catch(e) { console.warn('assignDiscordRole api err', e); }
  // 2) fallback discord.js
  try {
    const guild = await discordClient.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);
    await member.roles.add(roleId);
    return true;
  } catch (err) {
    console.error('assignDiscordRole fallback error', err);
    return false;
  }
}

async function removeDiscordRole(discordId, roleId) {
  if (!discordId || !roleId) return false;
  try {
    const okApi = await removeRoleFromMemberViaApi(discordId, roleId);
    if (okApi) return true;
  } catch (e) { console.warn('removeDiscordRole api attempt err', e); }
  try {
    const guild = await discordClient.guilds.fetch(GUILD_ID);
    if (!guild) return false;
    let member;
    try { member = await guild.members.fetch(discordId); } catch (fetchErr) { console.warn('No member to fetch (maybe left) ', fetchErr?.message || fetchErr); return false; }
    const botMember = await guild.members.fetch(discordClient.user?.id);
    const botMaxPos = Math.max(...botMember.roles.cache.map(r => r.position), 0);
    const targetRole = guild.roles.cache.get(roleId);
    const targetPos = targetRole ? targetRole.position : null;
    if (targetPos !== null && botMaxPos <= targetPos) {
      console.error('Bot hierarchy insufficient to remove role (botMaxPos <= targetPos)');
      return false;
    }
    try {
      await member.roles.remove(roleId);
      return true;
    } catch (err) {
      console.error('Error removing role via discord.js', err);
      return false;
    }
  } catch (err) {
    console.error('removeDiscordRole fallback overall error', err);
    return false;
  }
}

async function markRoleRemovedInDB(id) {
  try {
    const { error } = await supabase.from('memberships').update({ role_removed: true, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) console.warn('markRoleRemovedInDB error', error);
    return !error;
  } catch (err) {
    console.error('markRoleRemovedInDB exception', err);
    return false;
  }
}

function calculateExpiryDate(plan) {
  const now = new Date();
  let days = 30;
  if (plan === 'plan_trimestral' || plan === 'trimestral') days = 90;
  if (plan === 'plan_anual' || plan === 'anual') days = 365;
  return new Date(now.getTime() + days * 24*60*60*1000).toISOString();
}

function getRoleIdForPlan(planId) {
  const key = String(planId || '').toLowerCase().trim();
  const mapping = {
    'plan_mensual': ROLE_ID_SENALESDISCORD,
    'mensual': ROLE_ID_SENALESDISCORD,
    'plan_trimestral': ROLE_ID_MENTORIADISCORD,
    'trimestral': ROLE_ID_MENTORIADISCORD,
    'plan_anual': ROLE_ID_ANUALDISCORD,
    'anual': ROLE_ID_ANUALDISCORD
  };
  return mapping[key] && mapping[key].trim() !== '' ? mapping[key] : null;
}

// ================= ROUTES

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.post('/create-membership', async (req, res) => {
  try {
    if (!validatePasswordFromBody(req)) return res.status(401).json({ success:false, message:'password inválida' });
    const body = req.body || {};
    const name = (body.nombre || body.name || '').toString().trim();
    const email = (body.email || '').toString().trim().toLowerCase();
    const plan = (body.plan || '').toString().trim();
    const discordId = body.discordId || body.discord_id || null;
    if (!name || !email || !plan) return res.status(400).json({ success:false, message:'Campos requeridos: nombre, email, plan' });

    let claim = null;
    let inserted = null;
    const maxAttempts = 6;
    for (let i=0;i<maxAttempts;i++) {
      claim = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      const nowIso = new Date().toISOString();
      const expires_at = calculateExpiryDate(plan);
      const row = {
        claim, name, email, plan, discord_id: discordId || null, created_at: nowIso,
        expires_at, expires_at_ts: expires_at, active: true, used: false, revoked_at: null, redeemed_at: null, role_removed: false
      };
      const { data, error } = await supabase.from('memberships').insert([row]).select().limit(1);
      if (error) {
        const msg = (error.message || '').toLowerCase();
        if (msg.includes('duplicate') || msg.includes('unique')) continue;
        return res.status(500).json({ success:false, message:'Error insertando membership', error });
      } else {
        inserted = Array.isArray(data) && data.length > 0 ? data[0] : (data || row);
        break;
      }
    }
    if (!inserted) return res.status(500).json({ success:false, message:'No se pudo generar un claim único.' });

    sendWelcomeEmail(inserted.email, inserted.name, inserted.plan, null, null, {}, inserted.claim)
      .then(()=> console.log('Email enviado (async)'))
      .catch(err => console.error('Error enviando welcome email:', err));

    if (discordId) {
      const roleId = getRoleIdForPlan(inserted.plan);
      if (roleId) assignDiscordRole(discordId, roleId).catch(err => console.error('assignDiscordRole create-membership err:', err));
    }

    return res.status(201).json({ success:true, membership: { id: inserted.id || null, name: inserted.name, email: inserted.email, plan: inserted.plan, discord_id: inserted.discord_id, claim: inserted.claim, created_at: inserted.created_at, expires_at: inserted.expires_at, active: inserted.active, used: inserted.used } });
  } catch (err) {
    console.error('/create-membership error', err);
    return res.status(500).json({ success:false, message:'Error interno' });
  }
});

app.post('/redeem-claim', async (req, res) => {
  try {
    if (!validatePasswordFromBody(req)) return res.status(401).json({ success:false, message:'password inválida' });
    const { claim, discordId } = req.body || {};
    if (!claim) return res.status(400).json({ success:false, message:'claim es requerido' });

    const { data: rows, error: fetchErr } = await supabase.from('memberships').select('*').eq('claim', claim).limit(1);
    if (fetchErr) return res.status(500).json({ success:false, message:'Error interno' });
    if (!rows || rows.length === 0) return res.status(404).json({ success:false, message:'Claim no encontrado' });
    const membership = rows[0];

    if (membership.used === true) return res.status(400).json({ success:false, message:'Este claim ya fue usado.' });
    if (membership.revoked_at) return res.status(400).json({ success:false, message:'Este claim fue revocado.' });
    if (membership.discord_id) return res.status(400).json({ success:false, message:'Este claim ya está vinculado a un Discord ID.' });

    const updates = { used: true, active: false, redeemed_at: new Date().toISOString() };
    if (discordId) updates.discord_id = discordId;
    const { data: updateData, error: updateErr } = await supabase.from('memberships').update(updates).eq('claim', claim).eq('used', false).is('discord_id', null).is('revoked_at', null).select().limit(1);
    if (updateErr) return res.status(500).json({ success:false, message:'Error interno actualizando membership' });
    if (!updateData || updateData.length === 0) return res.status(400).json({ success:false, message:'No se pudo canjear el claim. Probablemente ya fue usado.' });

    const updatedMembership = Array.isArray(updateData) ? updateData[0] : updateData;

    const finalDiscordId = discordId || updatedMembership.discord_id;
    if (finalDiscordId) {
      const roleId = getRoleIdForPlan(updatedMembership.plan || updatedMembership.plan_id);
      if (roleId) {
        await assignDiscordRole(finalDiscordId, roleId).catch(err => console.error('assignDiscordRole redeem-claim err:', err));
      } else {
        console.warn('No role found for plan in redeem-claim');
      }
    }

    return res.json({ success:true, membership: updatedMembership });
  } catch (err) {
    console.error('/redeem-claim error', err);
    return res.status(500).json({ success:false, message:'Error interno' });
  }
});

app.get('/api/auth/claim', async (req, res) => {
  const token = req.query.token || req.query.state;
  if (!token) return res.status(400).send('Token missing');
  try {
    const { data: rows, error } = await supabase.from('memberships').select('id,claim,used,revoked_at,discord_id').eq('claim', token).limit(1);
    if (error) return res.status(500).send('Error interno');
    if (!rows || rows.length === 0) return res.status(400).send('Enlace inválido. Contacta soporte.');
    const claimRow = rows[0];
    if (claimRow.used) return res.status(400).send('Este enlace ya fue utilizado.');
    if (claimRow.revoked_at) return res.status(400).send('Este enlace ha sido revocado.');
    if (claimRow.discord_id) return res.status(400).send('Este enlace ya fue vinculado a una cuenta. Contacta soporte.');

    const clientId = encodeURIComponent(DISCORD_CLIENT_ID);
    const redirectUri = encodeURIComponent(DISCORD_REDIRECT_URL);
    const scope = encodeURIComponent('identify guilds.join');
    const prompt = 'consent';
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${encodeURIComponent(token)}&prompt=${prompt}`;
    return res.redirect(discordAuthUrl);
  } catch (err) {
    console.error('/api/auth/claim error', err);
    return res.status(500).send('Error interno');
  }
});

app.get('/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    console.log('DEBUG /discord/callback params', { code: !!code, state: !!state });
    if (!code || !state) return res.status(400).send('Faltan parámetros (code o state).');

    try {
      const { data: existingRows, error: exErr } = await supabase.from('memberships').select('id,used,revoked_at,discord_id,plan').eq('claim', state).limit(1);
      if (exErr) console.warn('Early claim check error:', exErr);
      const existing = existingRows && existingRows.length ? existingRows[0] : null;
      if (!existing) {
        console.warn('Claim not found in callback:', state);
        return res.status(400).send('Enlace inválido o expirado. Contacta soporte.');
      }
      if (existing.used === true || existing.revoked_at) {
        return res.status(400).send('Este enlace ya fue utilizado o ha sido revocado.');
      }
      if (existing.discord_id) {
        return res.status(400).send('Este enlace ya está vinculado a una cuenta. Contacta soporte.');
      }
    } catch (err) {
      console.warn('Error verificando claim antes de token exchange:', err);
    }

    let tokenData = null;
    try {
      const params = new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: DISCORD_REDIRECT_URL
      });
      const tokenResp = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const status = tokenResp.status;
      const raw = await tokenResp.text();
      console.log('DEBUG token exchange -> status:', status, 'body start:', (raw||'').substring(0,200));
      if (status !== 200) {
        try {
          const parsed = JSON.parse(raw || '{}');
          if (parsed.error === 'invalid_grant') {
            console.error('Token exchange invalid_grant:', parsed);
            return res.status(400).send('Error de autorización: código inválido o expirado. Usa el enlace recibido para intentarlo nuevamente.');
          }
        } catch (parseErr) { /* non-json body */ }
        return res.status(400).send('Error de autorización (token exchange). Revisa REDIRECT_URI / CLIENT_SECRET.');
      }
      try { tokenData = JSON.parse(raw); } catch (parseErr) {
        console.error('Token exchange returned non-json body', parseErr);
        return res.status(400).send('Error de autorización: respuesta inesperada de Discord.');
      }
      if (!tokenData || !tokenData.access_token) {
        console.error('No access_token in tokenData', tokenData);
        return res.status(400).send('Error de autorización: no se recibió access_token.');
      }
    } catch (err) {
      console.error('Exception during token exchange', err);
      return res.status(500).send('Error interno durante intercambio de token. Revisa logs.');
    }

    let userData = null;
    try {
      const userResp = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const userText = await userResp.text();
      try { userData = JSON.parse(userText); } catch (parseErr) {
        console.error('Fetch user returned non-json', parseErr, userResp.status, userText.substring(0,200));
        return res.status(400).send('Error obteniendo datos del usuario desde Discord.');
      }
      if (!userData || !userData.id) {
        console.error('No user.id obtained', userData);
        return res.status(400).send('No se pudo obtener datos del usuario desde Discord.');
      }
    } catch (err) {
      console.error('Exception fetching Discord user', err);
      return res.status(500).send('Error interno obteniendo datos del usuario desde Discord.');
    }

    const discordId = String(userData.id);
    const discordUsername = userData.username || discordId;
    console.log('OAuth user:', discordUsername, discordId);

    try {
      const putUrl = `https://discord.com/api/guilds/${GUILD_ID}/members/${discordId}`;
      const putBody = { access_token: tokenData.access_token };
      const addResp = await fetch(putUrl, {
        method: 'PUT',
        headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(putBody)
      });
      const addStatus = addResp.status;
      const addText = await addResp.text().catch(()=>'<no-body>');
      console.log('DEBUG add-member via OAuth -> status:', addStatus, 'body:', (addText||'').substring(0,400));
    } catch (err) {
      console.warn('Warning add-member via OAuth PUT failed', err);
    }

    let membership = null;
    try {
      const updates = { discord_id: discordId, discord_username: discordUsername, used: true, redeemed_at: new Date().toISOString(), active: true, updated_at: new Date().toISOString() };
      const { data: updatedRows, error: updErr } = await supabase.from('memberships').update(updates).eq('claim', state).eq('used', false).is('revoked_at', null).select().limit(1);
      if (updErr) {
        console.error('Error updating membership in callback', updErr);
      } else if (!updatedRows || updatedRows.length === 0) {
        console.warn('No updatedRows after trying to mark claim used (possible race)');
      } else {
        membership = updatedRows[0];
      }
    } catch (err) {
      console.error('Exception updating membership in callback', err);
    }

    if (!membership) {
      try {
        const { data: rows2 } = await supabase.from('memberships').select('*').eq('claim', state).limit(1);
        if (rows2 && rows2.length) membership = rows2[0];
      } catch (err) { console.warn('fetch membership fallback failed', err); }
    }

    try {
      const planOfUser = membership ? (membership.plan || membership.plan_id) : 'plan_mensual';
      const roleId = getRoleIdForPlan(planOfUser);
      if (roleId) {
        const ok = await assignDiscordRole(discordId, roleId).catch(err => { console.error('assignDiscordRole error in callback', err); return false; });
        if (!ok) console.warn('assignDiscordRole returned false; check bot perms/role hierarchy');
      } else {
        console.warn('No roleId for planOfUser', planOfUser);
      }
    } catch (err) {
      console.error('Exception assigning role in callback', err);
    }

    const successRedirect = FRONTEND_URL ? `${FRONTEND_URL}/gracias` : 'https://discord.gg';
    return res.send(`
      <!doctype html><html><head><meta charset="utf-8"><title>¡Bienvenido!</title></head>
      <body style="font-family:Arial,Helvetica,sans-serif;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="background:rgba(255,255,255,0.04);padding:32px;border-radius:12px;text-align:center;">
          <h1>🎉 ¡Bienvenido!</h1>
          <p>Tu rol ha sido asignado (si el bot tiene permisos). Serás redirigido...</p>
          <a href="${successRedirect}" style="display:inline-block;margin-top:12px;padding:12px 20px;border-radius:8px;background:#fff;color:#111;text-decoration:none;font-weight:bold;">Ir a Discord</a>
        </div>
        <script>setTimeout(()=>{ window.location.href='${successRedirect}' }, 3000);</script>
      </body></html>`);
  } catch (err) {
    console.error('Unexpected error in /discord/callback', err);
    return res.status(500).send('Error procesando la autorización');
  }
});

async function expireMemberships() {
  try {
    console.log('⏱️ Chequeando memberships expiradas...');
    const nowIso = new Date().toISOString();
    const { data: rows, error } = await supabase.from('memberships').select('*').lte('expires_at', nowIso).eq('active', true).limit(1000);
    if (error) {
      console.error('Error buscando expiradas:', error);
      return;
    }
    if (!rows || rows.length === 0) { console.log('No expiradas en este ciclo.'); return; }

    for (const m of rows) {
      try {
        console.log('Processing expired membership:', m.id || m.claim, 'email:', m.email);
        const roleId = getRoleIdForPlan(m.plan || m.plan_id);

        if (m.discord_id && roleId) {
          const removed = await removeDiscordRole(m.discord_id, roleId);
          if (removed) {
            console.log(`Role ${roleId} removed for membership ${m.id}`);
            await markRoleRemovedInDB(m.id);
          } else {
            console.warn(`Could not remove role ${roleId} for membership ${m.id}`);
          }
        } else {
          console.log('No discord_id or no roleId -> skip remove role');
        }

        const updates = { active: false, revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        const { error: updErr } = await supabase.from('memberships').update(updates).eq('id', m.id);
        if (updErr) console.error('Error marking revoked', updErr);
        else console.log(`Membership ${m.id} marked revoked.`);

        if (m.email) {
          await sendExpiryEmail(m).catch(e => console.error('sendExpiryEmail error', e));
        }
      } catch (innerErr) {
        console.error('Error processing expired membership loop', innerErr);
      }
    }
  } catch (err) {
    console.error('❌ Error in expireMemberships', err);
  }
}

setTimeout(() => {
  expireMemberships().catch(err => console.error('expireMemberships startup error', err));
  setInterval(() => expireMemberships().catch(err => console.error('expireMemberships interval error', err)), 60*1000);
}, 3000);

async function verifyBotTokenAtStartup() {
  try {
    if (!DISCORD_BOT_TOKEN) { console.warn('No DISCORD_BOT_TOKEN'); return; }
    const resp = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } });
    const status = resp.status;
    const body = await resp.text().catch(()=>'<no-body>');
    console.log(`VERIFY_BOT_TOKEN -> status=${status} body=${String(body).substring(0,400)}`);
    if (status === 200) console.log('Bot token valid');
    else if (status === 401) console.error('Bot token invalid (401).');
    else console.warn('Unexpected verifyBotToken status', status);
  } catch (err) {
    console.error('verifyBotTokenAtStartup error', err);
  }
}
verifyBotTokenAtStartup();

app.listen(PORT, () => {
  console.log('🚀 NAZA Bot iniciado en puerto', PORT);
  console.log('🔔 Discord token presente?', !!DISCORD_BOT_TOKEN);
  console.log('🔗 Supabase presente?', !!SUPABASE_URL);
});
