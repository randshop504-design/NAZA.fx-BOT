// index.js - NAZA (versión corregida: asignación de roles por API + fallback discord.js)
// Requisitos: Node >=18, @sendgrid/mail, @supabase/supabase-js, braintree (si lo usás), discord.js
// NOTA IMPORTANTE: **NO** modifiqué ni una letra de las funciones/plantillas de correo (buildWelcomeEmailHtml/buildWelcomeText/sendWelcomeEmail).

const express = require('express');
const braintree = require('braintree');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
const fetch = global.fetch || require('node-fetch'); // Node 18+ trae fetch global
const app = express();
app.use(express.json()); // admin endpoint expects JSON
app.use(express.urlencoded({ extended: true }));

// ============================================
// CONFIGURACIÓN (variables de entorno)
const BRAINTREE_ENV = process.env.BRAINTREE_ENV || 'Sandbox';
const BRAINTREE_MERCHANT_ID = process.env.BRAINTREE_MERCHANT_ID;
const BRAINTREE_PUBLIC_KEY = process.env.BRAINTREE_PUBLIC_KEY;
const BRAINTREE_PRIVATE_KEY = process.env.BRAINTREE_PRIVATE_KEY;
const FRONTEND_TOKEN = process.env.FRONTEND_TOKEN;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim());
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || '';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL || '';
const GUILD_ID = process.env.GUILD_ID || '';
// Role envs: admitir varios nombres para compatibilidad con instalaciones anteriores
const ROLE_ID_ANUALDISCORD = process.env.ROLE_ID_ANUALDISCORD || process.env.ROLE_ID_ANUAL || process.env.MEMBER_ROLE_ID || '';
const ROLE_ID_MENTORIADISCORD = process.env.ROLE_ID_MENTORIADISCORD || process.env.ROLE_ID_TRIM || process.env.MEMBER_ROLE_ID || '';
const ROLE_ID_SENALESDISCORD = process.env.ROLE_ID_SENALESDISCORD || process.env.MEMBER_ROLE_ID || '';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL;
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const BOT_URL = process.env.BOT_URL || BASE_URL; // URL pública de tu bot para links
const FRONTEND_URL = process.env.FRONTEND_URL || ''; // opcional

// ============================================
// CONFIGURAR SENDGRID
if (!SENDGRID_API_KEY) {
  console.warn('⚠️ SENDGRID_API_KEY no definido. Los correos no podrán enviarse.');
} else {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

// ============================================
// BRAINTREE GATEWAY (si lo usás)
const gateway = new braintree.BraintreeGateway({
  environment: BRAINTREE_ENV === 'Production' ? braintree.Environment.Production : braintree.Environment.Sandbox,
  merchantId: BRAINTREE_MERCHANT_ID,
  publicKey: BRAINTREE_PUBLIC_KEY,
  privateKey: BRAINTREE_PRIVATE_KEY
});

// ============================================
// DISCORD CLIENT (discord.js)
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
if (DISCORD_BOT_TOKEN) {
  discordClient.login(DISCORD_BOT_TOKEN).catch(err => console.error('Error login Discord:', err));
} else {
  console.warn('⚠️ DISCORD_BOT_TOKEN no definido. Operaciones Discord fallarán.');
}
discordClient.once('ready', () => {
  console.log('✅ Discord bot conectado:', discordClient.user?.tag || '(sin tag aún)');
});

// ============================================
// SUPABASE CLIENT
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  global: {
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      apikey: SUPABASE_SERVICE_ROLE
    }
  }
});

// ============================================
// ALMACENAMIENTO TEMPORAL PARA OAUTH2 (FRONTEND FLOW)
const pendingAuths = new Map();

// ============================================
// MAPEo DE ROLES por plan (intenta usar variables de entorno específicas; si no están, cae al role global)
function getRoleIdForPlan(planId) {
  const mapping = {
    'plan_mensual': ROLE_ID_SENALESDISCORD,
    'mensual': ROLE_ID_SENALESDISCORD,
    'plan_trimestral': ROLE_ID_MENTORIADISCORD,
    'trimestral': ROLE_ID_MENTORIADISCORD,
    'plan_anual': ROLE_ID_ANUALDISCORD,
    'anual': ROLE_ID_ANUALDISCORD
  };
  const roleId = mapping[planId];
  // Si no hay mapping, usar el primero no vacío entre los ROLE envs
  if (roleId && roleId.trim() !== '') return roleId;
  if (ROLE_ID_SENALESDISCORD) return ROLE_ID_SENALESDISCORD;
  if (ROLE_ID_MENTORIADISCORD) return ROLE_ID_MENTORIADISCORD;
  if (ROLE_ID_ANUALDISCORD) return ROLE_ID_ANUALDISCORD;
  return null;
}

// ============================================
// CORS MIDDLEWARE
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-frontend-token');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============================================
// MIDDLEWARE DE AUTENTICACIÓN (solo para endpoints internos opcionales)
function authenticateFrontend(req, res, next) {
  const token = req.headers['x-frontend-token'];
  if (!FRONTEND_TOKEN) return res.status(500).json({ success:false, message:'FRONTEND_TOKEN no configurado' });
  if (!token || token !== FRONTEND_TOKEN) {
    console.error('❌ Token inválido:', token);
    return res.status(401).json({ success: false, message: 'unauthorized', error: 'Token inválido' });
  }
  next();
}

// ============================================
// UTIL: ESCAPE Y SAFE
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function emailSafe(e){ return e || ''; }

// ============================================
// === FUNCIONES/PLANTILLAS DE EMAIL (NO MODIFICAR) ===
// He mantenido buildWelcomeEmailHtml, buildWelcomeText y sendWelcomeEmail exactamente como antes
// (no cambié su cuerpo ni lógica de plantillas). Copiadas tal cual.

function buildWelcomeEmailHtml({ name, planName, subscriptionId, claimUrl, email, supportEmail, token }) {
  const logoPath = 'https://vwndjpylfcekjmluookj.supabase.co/storage/v1/object/public/assets/0944255a-e933-4527-9aa5-f9e18e862a00.jpg';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<style>
/* keep minimal CSS; inline styles are primary for email clients */
@media (prefers-color-scheme: dark) {
  .wrap { background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01)) !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background-color:#000000;">
  <!-- Outer full-width table to ensure email clients (including Gmail) render dark background -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#000000" style="background-color:#000000;width:100%;min-width:100%;margin:0;padding:24px 0;">
    <tr>
      <td align="center" valign="top">
        <!-- Centered container -->
        <table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:680px;margin:0 auto;">
          <tr>
            <td style="padding:0 16px;">
              <!-- Card -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:12px;overflow:hidden;background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));box-shadow:0 10px 30px rgba(2,6,23,0.6);border:1px solid rgba(255,255,255,0.03);">
                <tr>
                  <td style="padding:28px 24px 8px 24px;text-align:center;">
                    <div style="width:96px;height:96px;border-radius:50%;overflow:hidden;margin:0 auto;display:block;border:4px solid rgba(255,255,255,0.04);box-shadow:0 8px 30px rgba(2,6,23,0.6);background:linear-gradient(135deg,#0f1720,#08101a);">
                      <img src="${logoPath}" alt="NAZA logo" width="96" height="96" style="display:block;width:96px;height:96px;object-fit:cover;transform:scale(1.12);border-radius:50%;" />
                    </div>
                    <h1 style="color:#ff9b3b;margin:18px 0 8px 0;font-size:26px;font-family:Arial,sans-serif;">NAZA Trading Academy</h1>
                    <div style="color:#cbd5e1;margin:6px 0 20px 0;font-size:16px;font-family:Arial,sans-serif;">¡Bienvenido! Tu suscripción ha sido activada correctamente.</div>
                  </td>
                </tr>

                <tr>
                  <td style="padding:20px 28px 28px 28px;color:#d6e6f8;font-family:Arial,sans-serif;line-height:1.5;">
                    <div style="font-size:15px;margin-bottom:16px;"><strong>Hola ${escapeHtml(name || 'usuario')},</strong></div>

                    <div style="background:linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.005));padding:18px;border-radius:10px;border:1px solid rgba(255,255,255,0.02);margin-top:0;">
                      <p style="margin:0 0 10px 0;"><strong>Entrega del servicio</strong></p>
                      <p style="margin:0;color:#d6e6f8">Todos los privilegios de tu plan —cursos, clases en vivo, análisis exclusivos y canales privados— se gestionan dentro de <strong>Discord</strong>. Al pulsar <em>Obtener acceso</em> recibirás el rol correspondiente y se te desbloquearán automáticamente los canales de tu plan.</p>
                    </div>

                    <div style="text-align:center;margin:22px 0;">
                      <a href="${claimUrl}" data-token="${encodeURIComponent(token)}" style="display:inline-block;background:#2d9bf0;color:#ffffff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;box-shadow:0 8px 30px rgba(45,155,240,0.15);font-family:Arial,sans-serif;">Obtener acceso</a>
                      <div style="color:#9fb0c9;font-size:13px;margin-top:8px;font-family:Arial,sans-serif;">(En caso de no haber reclamado)</div>
                    </div>

                    <div style="background:linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.005));padding:18px;border-radius:10px;border:1px solid rgba(255,255,255,0.02);margin-top:18px;">
                      <p style="margin:0 0 8px 0;"><strong>Únete a la comunidad y mantente al día</strong></p>
                      <p style="margin:0 0 12px 0;color:#d6e6f8">Para ver anuncios oficiales, horarios de clases, avisos de sesiones en vivo y formar parte de los chats (WhatsApp y Telegram), visita nuestro sitio y sigue las instrucciones para unirte a los grupos desde allí.</p>
                      <a href="https://nazatradingacademy.com" target="_blank" style="display:block;background:rgba(255,255,255,0.02);padding:14px;border-radius:8px;color:#bfe0ff;text-decoration:none;font-weight:600;border:1px solid rgba(255,255,255,0.02);font-family:Arial,sans-serif;">https://nazatradingacademy.com</a>
                    </div>

                    <div style="background:linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.005));padding:18px;border-radius:10px;border:1px solid rgba(255,255,255,0.02);margin-top:18px;">
                      <p style="margin:0 0 8px 0;"><strong>¿Nuevo en Discord o no tienes cuenta?</strong></p>
                      <p style="margin:0 0 12px 0;color:#d6e6f8">Si necesitas ayuda, usa los enlaces de abajo:</p>
                      <a href="https://discord.com/download" target="_blank" style="display:inline-block;padding:10px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.04);margin-right:12px;text-decoration:none;color:#d6e6f8;font-weight:600;background:transparent;font-family:Arial,sans-serif;">Descargar Discord</a>
                      <a href="https://youtu.be/-qgmEy1XjMg?si=vqXGRkIid-kgTCTr" target="_blank" style="display:inline-block;padding:10px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.04);text-decoration:none;color:#d6e6f8;font-weight:600;background:transparent;font-family:Arial,sans-serif;">Cómo crear una cuenta (ES)</a>
                    </div>

                    <div style="font-size:13px;color:#9fb0c9;margin-top:12px;font-family:Arial,sans-serif;">
                      <div><strong>Detalles de la suscripción:</strong></div>
                      <div style="margin-top:6px;">Plan: ${escapeHtml(planName)}</div>
                      <div>ID de suscripción: ${escapeHtml(subscriptionId || '')}</div>
                      <div>Email: ${escapeHtml(emailSafe(email) || '')}</div>
                      <div style="margin-top:6px;font-size:12px;color:#8fa6bf">El enlace es de un solo uso y funciona hasta que completes el registro en Discord. Si ya iniciaste sesión con OAuth2, no es necesario volver a usarlo.</div>
                    </div>

                  </td>
                </tr>

                <tr>
                  <td style="padding:18px;text-align:center;color:#98b0c8;font-size:13px;background:transparent;border-top:1px solid rgba(255,255,255,0.02);font-family:Arial,sans-serif;">
                    <div>©️ ${new Date().getFullYear()} NAZA Trading Academy</div>
                    <div style="margin-top:6px">Soporte: <a href="mailto:${SUPPORT_EMAIL || 'support@nazatradingacademy.com'}" style="color:#bfe0ff;text-decoration:none">${SUPPORT_EMAIL || 'support@nazatradingacademy.com'}</a></div>
                  </td>
                </tr>

              </table>
              <!-- end card -->
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body></html>`;
}

function buildWelcomeText({ name, planName, subscriptionId, claimUrl, supportEmail, email, token }) {
  return `Hola ${name || 'usuario'}, ¡Bienvenido a NAZA Trading Academy!

Tu suscripción ha sido activada correctamente.

Entrega del servicio:
Todos los privilegios de tu plan —cursos, clases en vivo, análisis y canales exclusivos— se entregan a través de Discord. Al pulsar "Obtener acceso" se te asignará automáticamente el rol correspondiente y se desbloquearán los canales de tu plan.

Únete a la comunidad:
Para anuncios oficiales, horarios de clases y unirte a los chats (WhatsApp y Telegram), visita: https://nazatradingacademy.com

Si no tienes Discord:
- Descargar Discord: https://discord.com/download
- Cómo crear una cuenta (ES): https://youtu.be/-qgmEy1XjMg?si=vqXGRkIid-kgTCTr

Enlace para obtener acceso (un solo uso — válido hasta completar registro):
${claimUrl}

Detalles:
Plan: ${planName}
ID de suscripción: ${subscriptionId || ''}
Email: ${email || ''}

Soporte: ${SUPPORT_EMAIL || 'support@nazatradingacademy.com'}

Nota: El enlace es de un solo uso y funcionará hasta que completes el proceso en Discord.`;
}

async function sendWelcomeEmail(email, name, planId, subscriptionId, customerId, extra = {}, existingToken = null) {
  console.log('📧 Enviando email de bienvenida (SendGrid)...');
  const planNames = {
    'plan_anual': 'Plan Anual 🔥',
    'plan_trimestral': 'Plan Trimestral 📈',
    'plan_mensual': 'Plan Mensual 💼'
  };
  const planName = planNames[planId] || 'Plan';

  if (!SENDGRID_API_KEY) {
    console.error('❌ No hay SENDGRID_API_KEY configurada. Abortando envío de correo.');
    throw new Error('SENDGRID_API_KEY no configurada');
  }

  const last4 = extra.last4 || '';
  const cardExpiry = extra.cardExpiry || '';

  // Si nos pasan existingToken, NO creamos uno nuevo (asumimos ya creado previamente)
  let token = existingToken;
  if (!token) {
    token = await createClaimToken({ email, name, plan_id: planId, subscriptionId, customerId, last4, cardExpiry, extra });
  }

  // <-- CAMBIO: OAuth2 DIRECTO (el botón del correo irá directamente al OAuth2 de Discord)
  const claimUrl = `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(DISCORD_CLIENT_ID)}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URL)}&response_type=code&scope=identify%20guilds.join&state=${encodeURIComponent(token)}`;

  // Pasar token al template HTML y al texto
  const html = buildWelcomeEmailHtml({ name, planName, subscriptionId, claimUrl, email, supportEmail: SUPPORT_EMAIL, token });
  const text = buildWelcomeText({ name, planName, subscriptionId, claimUrl, supportEmail: SUPPORT_EMAIL, email, token });

  const msg = {
    to: email,
    from: FROM_EMAIL,
    subject: `¡Bienvenido a NAZA Trading Academy! — Obtener acceso`,
    text,
    html
  };

  try {
    // <-- DEBUG LINES (ya añadidas por ti)
    console.log('DEBUG sendWelcomeEmail -> token:', token);
    console.log('DEBUG sendWelcomeEmail -> claimUrl:', claimUrl);
    // <-- end debug lines
    const result = await sgMail.send(msg);
    console.log('✅ Email enviado a:', email, 'SendGrid result:', result?.[0]?.statusCode || 'unknown');
  } catch (error) {
    console.error('❌ Error enviando email con SendGrid:', error?.message || error);
    if (error?.response?.body) console.error('SendGrid response body:', error.response.body);
    // Dejar que el flujo de pago siga, pero informa del fallo
    throw error;
  }
}

// ============================================
// FUNCIONES AUX: ASIGNACIÓN/RETIRO DE ROLES EN DISCORD
// Intentamos primero la API REST (PUT/DELETE sobre /members/:id/roles/:roleId).
// Si falla, hacemos fallback con discord.js (member.roles.add/remove).

async function addRoleToMemberViaApi(discordId, roleId) {
  if (!discordId || !roleId) return false;
  if (!GUILD_ID) {
    console.warn('GUILD_ID no configurado; no se puede añadir rol vía API');
    return false;
  }
  const botToken = DISCORD_BOT_TOKEN;
  if (!botToken) {
    console.warn('DISCORD_BOT_TOKEN no configurado; no se puede añadir rol vía API');
    return false;
  }
  try {
    const url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}/roles/${roleId}`;
    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${botToken}`
      }
    });
    if (resp.status === 204) {
      console.log(`✅ Rol ${roleId} añadido via API a ${discordId}`);
      return true;
    } else {
      const text = await resp.text().catch(()=>'<no body>');
      console.warn(`⚠️ API addRole responded ${resp.status}: ${text}`);
      return false;
    }
  } catch (err) {
    console.error('❌ addRoleToMemberViaApi error:', err);
    return false;
  }
}

async function removeRoleFromMemberViaApi(discordId, roleId) {
  if (!discordId || !roleId) return false;
  if (!GUILD_ID) {
    console.warn('GUILD_ID no configurado; no se puede remover rol vía API');
    return false;
  }
  const botToken = DISCORD_BOT_TOKEN;
  if (!botToken) {
    console.warn('DISCORD_BOT_TOKEN no configurado; no se puede remover rol vía API');
    return false;
  }
  try {
    const url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}/roles/${roleId}`;
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bot ${botToken}`
      }
    });
    if (resp.status === 204) {
      console.log(`✅ Rol ${roleId} removido via API de ${discordId}`);
      return true;
    } else {
      const text = await resp.text().catch(()=>'<no body>');
      console.warn(`⚠️ API removeRole responded ${resp.status}: ${text}`);
      return false;
    }
  } catch (err) {
    console.error('❌ removeRoleFromMemberViaApi error:', err);
    return false;
  }
}

async function assignDiscordRole(discordId, roleId) {
  if (!discordId || !roleId) {
    console.warn('assignDiscordRole: falta discordId o roleId');
    return;
  }
  // 1) Intentar vía API REST (más directa / confiable)
  const okApi = await addRoleToMemberViaApi(discordId, roleId);
  if (okApi) return;

  // 2) Fallback con discord.js
  try {
    const guild = await discordClient.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);
    await member.roles.add(roleId);
    console.log('✅ Rol asignado con discord.js (fallback)');
  } catch (err) {
    console.error('❌ Error asignando rol (discord.js fallback):', err);
  }
}

async function removeDiscordRole(discordId, roleId) {
  if (!discordId || !roleId) {
    console.warn('removeDiscordRole: falta discordId o roleId');
    return;
  }
  // 1) Intentar vía API REST
  const okApi = await removeRoleFromMemberViaApi(discordId, roleId);
  if (okApi) return;

  // 2) Fallback con discord.js
  try {
    const guild = await discordClient.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);
    await member.roles.remove(roleId);
    console.log('✅ Rol removido con discord.js (fallback)');
  } catch (err) {
    console.error('❌ Error removiendo rol (discord.js fallback):', err);
  }
}

// ============================================
// ENDPOINT: Verificar si se puede crear un claim / validar email y tarjeta
// Protegido por authenticateFrontend (usa x-frontend-token)
// (Mantengo la lógica completa tal como estaba; la dejé igual)
app.post('/api/validate-claim', authenticateFrontend, async (req, res) => {
  try {
    const { email: rawEmail, last4 = '', card_expiry = '' } = req.body || {};
    if (!rawEmail) return res.status(400).json({ success: false, message: 'email requerido' });
    const email = String(rawEmail).trim().toLowerCase();

    // 1) ¿Existe membership con ese email?
    const { data: membershipsRows, error: memErr } = await supabase
      .from('memberships')
      .select('id')
      .eq('email', email)
      .limit(1);
    if (memErr) {
      console.error('Error consultando memberships (validate-claim):', memErr);
      return res.status(500).json({ success: false, message: 'Error interno' });
    }
    const existsMembership = Array.isArray(membershipsRows) && membershipsRows.length > 0;

    // 2) ¿Existe claim (no necesariamente usado) para ese email?
    const { data: claimRows, error: claimErr } = await supabase
      .from('claims')
      .select('id, used')
      .eq('email', email)
      .limit(1);
    if (claimErr) {
      console.error('Error consultando claims (validate-claim):', claimErr);
      return res.status(500).json({ success: false, message: 'Error interno' });
    }
    const existsClaim = Array.isArray(claimRows) && claimRows.length > 0;
    const existingClaimUsed = existsClaim ? !!claimRows[0].used : false;

    // 3) Contar emails distintos asociados a esta tarjeta (memberships + claims)
    let cardUsageCount = 0;
    if (last4 && last4.toString().trim() !== '') {
      try {
        // Preferir RPC si existe
        const { data: cardEmails, error: rpcErr } = await supabase.rpc('naza_get_card_emails', { in_last4: last4, in_card_expiry: card_expiry });
        if (!rpcErr && Array.isArray(cardEmails)) {
          const setEmails = new Set((cardEmails || []).map(r => (r.email || '').toLowerCase()));
          setEmails.delete('');
          cardUsageCount = setEmails.size;
        } else {
          // fallback: get distinct emails from memberships and claims
          const [{ data: mEmails, error: mErr }, { data: cEmails, error: cErr }] = await Promise.all([
            supabase.from('memberships').select('email').eq('last4', last4).eq('card_expiry', card_expiry),
            supabase.from('claims').select('email').eq('last4', last4).eq('card_expiry', card_expiry)
          ]);
          if (mErr) console.warn('mErr fallback:', mErr);
          if (cErr) console.warn('cErr fallback:', cErr);
          const setEmails = new Set();
          (mEmails || []).forEach(r => setEmails.add((r.email || '').toLowerCase()));
          (cEmails || []).forEach(r => setEmails.add((r.email || '').toLowerCase()));
          setEmails.delete('');
          cardUsageCount = setEmails.size;
        }
      } catch (err) {
        console.error('Error contando card usage (validate-claim) fallback:', err);
        cardUsageCount = 0;
      }
    }

    // 4) Regla: si cardUsageCount >= 2 y el email no está ya en ese set -> bloquear
    let cardBlocked = false;
    if (cardUsageCount >= 2 && last4 && last4.toString().trim() !== '') {
      const [{ data: mHas }, { data: cHas }] = await Promise.all([
        supabase.from('memberships').select('id').eq('email', email).eq('last4', last4).eq('card_expiry', card_expiry).limit(1),
        supabase.from('claims').select('id').eq('email', email).eq('last4', last4).eq('card_expiry', card_expiry).limit(1)
      ]);
      const alreadyUsingThisCard = (Array.isArray(mHas) && mHas.length > 0) || (Array.isArray(cHas) && cHas.length > 0);
      if (!alreadyUsingThisCard) cardBlocked = true;
    }

    // 5) Construir respuesta con razones
    const allowed = !existsMembership && !existsClaim && !cardBlocked;
    const reasons = [];
    if (existsMembership) reasons.push('email_already_registered');
    if (existsClaim) reasons.push(existingClaimUsed ? 'claim_already_used_or_exists' : 'claim_already_exists');
    if (cardBlocked) reasons.push('card_usage_limit_exceeded');

    return res.json({ success: true, allowed, reasons, details: { existsMembership, existsClaim, existingClaimUsed, cardUsageCount } });
  } catch (err) {
    console.error('❌ Error en /api/validate-claim:', err);
    return res.status(500).json({ success: false, message: 'Error interno' });
  }
});

// ============================================
// FUNCIONES AUX: createClaimToken
// Nota: mantuve la lógica principal; es la usada por flows de frontend y e-mails.
async function createClaimToken({ email, name, plan_id, subscriptionId, customerId, last4, cardExpiry, extra = {} }) {
  email = (email || '').trim().toLowerCase();

  // 1) Verificar si ya existe una membresía (memberships) con ese email
  try {
    const { data: existingMembership, error: memErr } = await supabase
      .from('memberships')
      .select('id')
      .eq('email', email)
      .limit(1);
    if (memErr) {
      console.error('Error consultando memberships:', memErr);
      if (memErr.code === 'PGRST205' || (memErr.message && memErr.message.includes('Could not find the table'))) {
        console.error('ERROR DETECTADO: Parece que PostgREST no encuentra la tabla "memberships". Verifica SUPABASE_URL y la service_role key en el entorno.');
      }
      throw new Error('Error interno');
    }
    if (existingMembership && existingMembership.length > 0) {
      throw new Error('Este correo ya está registrado');
    }
  } catch (err) {
    throw err;
  }

  // 2) Verificar si ya hay un claim pendiente para ese email (sin consumir)
  try {
    const { data: existingClaimsForEmail, error: claimErr } = await supabase
      .from('claims')
      .select('id, used')
      .eq('email', email)
      .limit(1);
    if (claimErr) {
      console.error('Error consultando claims por email:', claimErr);
      throw new Error('Error interno');
    }
    if (existingClaimsForEmail && existingClaimsForEmail.length > 0) {
      throw new Error('Existe ya una solicitud para este correo. Revisa tu email.');
    }
  } catch (err) {
    throw err;
  }

  // 3) Verificar uso de la tarjeta (no permitir >2 correos distintos)
  try {
    const [{ data: mRows, error: mErr }, { data: cRows, error: cErr }] = await Promise.all([
      supabase.from('memberships').select('email').eq('last4', last4 || '').eq('card_expiry', cardExpiry || ''),
      supabase.from('claims').select('email').eq('last4', last4 || '').eq('card_expiry', cardExpiry || '')
    ]);
    if (mErr) {
      console.error('Error consultando memberships por tarjeta:', mErr);
    }
    if (cErr) {
      console.error('Error consultando claims por tarjeta:', cErr);
    }
    const distinctEmails = new Set();
    (mRows || []).forEach(r => { if (r.email) distinctEmails.add(String(r.email).toLowerCase()); });
    (cRows || []).forEach(r => { if (r.email) distinctEmails.add(String(r.email).toLowerCase()); });
    distinctEmails.delete('');
    if (distinctEmails.size >= 2 && !distinctEmails.has(email)) {
      throw new Error('Esta tarjeta ya está asociada a dos cuentas distintas. Contacta soporte.');
    }
  } catch (err) {
    throw err;
  }

  // 3b) Recheck race condition
  try {
    const [{ data: recheckMembership, error: rMemErr }, { data: recheckClaim, error: rClaimErr }] = await Promise.all([
      supabase.from('memberships').select('id').eq('email', email).limit(1),
      supabase.from('claims').select('id,used').eq('email', email).limit(1)
    ]);
    if (rMemErr) {
      console.error('rMemErr:', rMemErr);
      throw new Error('Error interno');
    }
    if (recheckMembership && recheckMembership.length > 0) {
      throw new Error('Este correo ya está registrado');
    }
    if (rClaimErr) {
      console.error('rClaimErr:', rClaimErr);
      throw new Error('Error interno');
    }
    if (recheckClaim && recheckClaim.length > 0) {
      throw new Error('Existe ya una solicitud para este correo. Revisa tu email.');
    }
  } catch (err) {
    throw err;
  }

  // 4) Generar token e insertar claim
  const token = crypto.randomBytes(24).toString('hex'); // 48 chars
  const row = {
    token,
    email,
    last4: last4 || '',
    card_expiry: cardExpiry || '',
    name: name || '',
    plan_id: plan_id || '',
    subscription_id: subscriptionId || '',
    customer_id: customerId || '',
    extra: JSON.stringify(extra || {}),
    used: false,
    created_at: new Date().toISOString()
  };
  try {
    const { data: insertData, error: insertErr } = await supabase
      .from('claims')
      .insert([row]);
    if (insertErr) {
      console.error('Error insertando claim:', insertErr);
      throw new Error('No se pudo crear el claim');
    }
    return token;
  } catch (err) {
    throw err;
  }
}

// ============================================
// ENDPOINT: CONFIRMAR PAGO DESDE FRONTEND (mantenido)
app.post('/api/frontend/confirm', authenticateFrontend, async (req, res) => {
  console.log('📬 POST /api/frontend/confirm');
  try {
    const { nonce, email, name, plan_id } = req.body;
    console.log('📦 Datos recibidos:', { nonce: nonce ? 'SÍ' : 'NO', email, name, plan_id });
    if (!nonce || !email || !name || !plan_id) {
      return res.status(400).json({ success: false, message: 'Faltan datos requeridos' });
    }

    const customerResult = await gateway.customer.create({ email: email, paymentMethodNonce: nonce });
    if (!customerResult.success) {
      console.error('❌ Error creando cliente:', customerResult.message);
      return res.status(400).json({ success: false, message: 'Error creando cliente: ' + customerResult.message });
    }
    const paymentMethod = customerResult.customer.paymentMethods[0];
    const paymentMethodToken = paymentMethod.token;
    const last4 = paymentMethod.last4 || '';
    const cardExpiry = paymentMethod.expirationDate || '';

    const subscriptionResult = await gateway.subscription.create({
      paymentMethodToken: paymentMethodToken,
      planId: plan_id
    });
    if (!subscriptionResult.success) {
      console.error('❌ Error creando suscripción:', subscriptionResult.message);
      return res.status(400).json({ success: false, message: 'Error creando suscripción: ' + subscriptionResult.message });
    }
    const subscriptionId = subscriptionResult.subscription.id;
    const customerId = customerResult.customer.id || null;
    console.log('✅ Suscripción creada:', subscriptionId, 'Customer ID:', customerId);

    // En lugar de crear un state aleatorio, creamos el claim token y lo usamos como state
    const token = await createClaimToken({ email, name, plan_id, subscriptionId, customerId, last4, cardExpiry, extra: { source: 'frontend_confirm' } });

    // Guardamos en pendingAuths usando el token como key para que /discord/callback lo reconozca
    pendingAuths.set(token, { email, name, plan_id, subscription_id: subscriptionId, customer_id: customerId, last4, card_expiry: cardExpiry, timestamp: Date.now() });
    // Mantener cleanup parecido
    setTimeout(()=> pendingAuths.delete(token), 10 * 60 * 1000);

    // Construimos la URL de OAuth usando el token como state (igual que /api/auth/claim)
    const oauthUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URL)}&response_type=code&scope=identify%20guilds.join&state=${token}`;

    // Enviar email con claim (usando el mismo token para evitar duplicados)
    sendWelcomeEmail(email, name, plan_id, subscriptionId, customerId, { last4, cardExpiry, source: 'frontend_confirm' }, token)
      .catch(err => console.error('❌ Error al enviar email (background):', err));

    return res.json({ success: true, subscription_id: subscriptionId, customer_id: customerId, oauth_url: oauthUrl, message: 'Suscripción creada. Recibirás un email con "Obtener acceso".' });
  } catch (error) {
    console.error('❌ Error en /api/frontend/confirm:', error);
    res.status(500).json({ success: false, message: error.message || 'Error interno' });
  }
});

// ============================================
// ENDPOINT: CLAIM (vía email)
// NO marcamos used aquí — solo redirigimos a Discord. El token se marcará usado al completar /discord/callback
app.get('/api/auth/claim', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send('Token missing');
  try {
    // Verificamos que exista y no esté usado
    const { data: rows, error } = await supabase
      .from('claims')
      .select('id,token,used')
      .eq('token', token)
      .limit(1);
    if (error) {
      console.error('Error leyendo claim:', error);
      return res.status(500).send('Error interno');
    }
    if (!rows || rows.length === 0) {
      return res.status(400).send('Enlace inválido. Contacta soporte.');
    }
    const claimRow = rows[0];
    if (claimRow.used) {
      return res.status(400).send('Este enlace ya fue utilizado.');
    }

    // Redirigir a OAuth2 de Discord usando token como state
    const state = token;
    const clientId = encodeURIComponent(DISCORD_CLIENT_ID);
    const redirectUri = encodeURIComponent(DISCORD_REDIRECT_URL);
    const scope = encodeURIComponent('identify guilds.join');
    const prompt = 'consent';
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${state}&prompt=${prompt}`;
    return res.redirect(discordAuthUrl);
  } catch (err) {
    console.error('❌ Error en /api/auth/claim:', err);
    return res.status(500).send('Error interno');
  }
});

// ============================================
// ENDPOINT: CALLBACK DE DISCORD OAUTH2
// - Soporta state que sea token de claim (DB) o state de pendingAuths (memoria)
// - Si es claim (DB), marcamos used=true SOLO después de registrar en memberships con éxito
app.get('/discord/callback', async (req, res) => {
  console.log('📬 GET /discord/callback');
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('❌ Faltan parámetros');

    // Intentar recuperar datos desde pendingAuths (frontend flow)
    let authData = pendingAuths.get(state);
    let claimData = null;
    if (!authData) {
      // Buscar en claims por token = state
      const { data: claimsRows, error: claimErr } = await supabase
        .from('claims')
        .select('*')
        .eq('token', state)
        .limit(1);
      if (claimErr) {
        console.error('Error leyendo claim de Supabase:', claimErr);
      } else if (claimsRows && claimsRows.length > 0) {
        claimData = claimsRows[0];
        if (claimData.used) {
          return res.status(400).send('Este enlace ya fue usado.');
        }
        authData = {
          email: claimData.email,
          name: claimData.name,
          plan_id: claimData.plan_id,
          subscription_id: claimData.subscription_id,
          customer_id: claimData.customer_id,
          last4: claimData.last4,
          card_expiry: claimData.card_expiry
        };
      }
    }

    if (!authData) return res.status(400).send('❌ Sesión expirada o inválida');

    console.log('📦 Datos para completar auth:', { email: authData.email, plan_id: authData.plan_id, subscription_id: authData.subscription_id });

    // Intercambiar code por access_token en Discord
    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: DISCORD_REDIRECT_URL
    });
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) {
      console.error('❌ Error obteniendo token:', tokenData);
      return res.status(400).send('❌ Error de autorización');
    }
    console.log('✅ Token obtenido');

    // Obtener info del usuario
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userData = await userResponse.json();
    const discordId = userData.id;
    const discordUsername = userData.username;
    console.log('👤 Usuario Discord:', discordUsername, '(' + discordId + ')');

    // Agregar al servidor (invite via OAuth2) - esto crea el miembro si no existe
    try {
      await fetch(`https://discord.com/api/guilds/${GUILD_ID}/members/${discordId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ access_token: tokenData.access_token })
      });
      console.log('✅ Usuario agregado al servidor (o ya existía)');
    } catch (err) {
      console.log('ℹ️ Usuario ya está en el servidor o no pudo agregarse directamente:', err?.message || err);
    }

    // Asignar rol según plan: primero intentamos con la API (más directa), si falla usamos discord.js
    const roleId = getRoleIdForPlan(authData.plan_id);
    if (roleId) {
      try {
        await assignDiscordRole(discordId, roleId);
      } catch (err) {
        console.error('❌ Error asignando rol en callback:', err);
      }
    } else {
      console.warn('⚠️ No se encontró roleId para plan:', authData.plan_id);
    }

    // Guardar en Supabase memberships (incluyendo last4 y card_expiry si estaban)
    try {
      const membershipRow = {
        email: authData.email,
        name: authData.name,
        plan_id: authData.plan_id,
        subscription_id: authData.subscription_id,
        customer_id: authData.customer_id,
        discord_id: discordId,
        discord_username: discordUsername,
        status: 'active',
        created_at: new Date().toISOString()
      };
      if (authData.last4) membershipRow.last4 = authData.last4;
      if (authData.card_expiry) membershipRow.card_expiry = authData.card_expiry;
      const { error: insErr } = await supabase.from('memberships').insert(membershipRow);
      if (insErr) {
        console.error('❌ Error guardando en Supabase memberships:', insErr);
      } else {
        console.log('✅ Guardado en Supabase memberships');
      }
    } catch (err) {
      console.error('❌ Error con Supabase (memberships):', err);
    }

    // Si venía de claim (DB), marcar used = true ahora que el registro fue completado
    if (claimData) {
      try {
        const { error: markErr } = await supabase
          .from('claims')
          .update({ used: true, used_at: new Date().toISOString() })
          .eq('token', state);
        if (markErr) {
          console.error('❌ Error marcando claim como usado:', markErr);
        } else {
          console.log('✅ Claim marcado como usado');
        }
      } catch (err) {
        console.error('❌ Error en update claim:', err);
      }
    }

    // Redirigir a frontend o mostrar página de éxito
    const successRedirect = FRONTEND_URL ? `${FRONTEND_URL}/gracias` : 'https://discord.gg/sXjU5ZVzXU';
    return res.send(`
<!DOCTYPE html><html><head><meta charset="UTF-8"><title>¡Bienvenido!</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <div style="background:rgba(255,255,255,0.08);padding:32px;border-radius:12px;text-align:center;">
    <h1>🎉 ¡Bienvenido!</h1>
    <p>Tu rol ha sido asignado correctamente. Serás redirigido en unos segundos...</p>
    <a href="${successRedirect}" style="display:inline-block;margin-top:12px;padding:12px 20px;border-radius:8px;background:#fff;color:#667eea;text-decoration:none;font-weight:bold;">Ir a Discord</a>
  </div>
  <script>setTimeout(()=>{ window.location.href='${successRedirect}' }, 3000);</script>
</body></html>`);
  } catch (error) {
    console.error('❌ Error en callback:', error);
    res.status(500).send('❌ Error procesando la autorización');
  }
});

// ============================================
// WEBHOOK DE BRAINTREE (mantener según tu implementación)
app.post('/api/braintree/webhook', express.raw({ type: 'application/x-www-form-urlencoded' }), async (req, res) => {
  console.log('📬 Webhook recibido de Braintree');
  try {
    const webhookNotification = await gateway.webhookNotification.parse(req.body.bt_signature, req.body.bt_payload);
    console.log('📦 Tipo:', webhookNotification.kind);
    console.log('📦 Suscripción ID:', webhookNotification.subscription?.id);
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error procesando webhook:', error);
    res.sendStatus(500);
  }
});

// ============================================
// HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// INICIAR SERVIDOR
app.listen(PORT, () => {
  console.log('🚀 NAZA Bot - servidor iniciado');
  console.log('🌐 Puerto:', PORT);
  console.log('🔗 URL:', BASE_URL);
  console.log('🔔 Discord token presente?', !!DISCORD_BOT_TOKEN);
});
