// NAZA Bot - versión final con OAuth add-member + asignación de roles
// Requisitos: Node >=18, @sendgrid/mail, @supabase/supabase-js, discord.js
// NOTA: NO se modificaron plantillas/funciones de correo (sendWelcomeEmail) — se usan exactamente.

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

// =================== CONFIGURACIÓN (variables de entorno)
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'no-reply@example.com';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@nazatradingacademy.com';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || '';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL || '';
const GUILD_ID = process.env.GUILD_ID || '';
const ROLE_ID_ANUALDISCORD = process.env.ROLE_ID_ANUALDISCORD || process.env.ROLE_ID_ANUAL || '';
const ROLE_ID_MENTORIADISCORD = process.env.ROLE_ID_MENTORIADISCORD || process.env.ROLE_ID_TRIMESTRAL || '';
const ROLE_ID_SENALESDISCORD = process.env.ROLE_ID_SENALESDISCORD || process.env.ROLE_ID_MENSUAL || '';
const FRONTEND_URL = process.env.FRONTEND_URL || '';
const API_PASSWORD = process.env.API_PASSWORD || 'Alex13102001$$$'; // contraseña por defecto si no defines env

// ============================================
// Configurar SendGrid (NO modificar la implementación de sendWelcomeEmail si ya existe)
if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
} else {
  console.warn('⚠️ SENDGRID_API_KEY no definido. Los correos no podrán enviarse.');
}

// ============================================
// Braintree opcional (no romper si no está instalado)
let braintree = null;
try {
  braintree = require('braintree');
  console.log('Braintree cargado (opcional).');
} catch (err) {
  // no pasa nada, se ignora
}

// ============================================
// DISCORD CLIENT (discord.js)
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
if (DISCORD_BOT_TOKEN) {
  discordClient.login(DISCORD_BOT_TOKEN).catch(err => console.error('Error login Discord:', err));
} else {
  console.warn('⚠️ DISCORD_BOT_TOKEN no definido. Las operaciones de rol fallarán si se intenta ejecutar.');
}
discordClient.once('ready', () => {
  console.log('✅ Discord listo:', discordClient.user?.tag || '(sin tag aún)');
});

// ============================================
// SUPABASE CLIENT
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.warn('⚠️ SUPABASE_URL o SUPABASE_SERVICE_ROLE no están configurados. Algunas operaciones DB fallarán.');
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  global: {
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      apikey: SUPABASE_SERVICE_ROLE
    }
  }
});

// ============================================
// UTILIDADES
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function emailSafe(e){ return e || ''; }

// ============================================
// (NO MODIFICAR) PLANTILLAS Y FUNCIÓN DE ENVÍO DE CORREO
// Si ya tenías estas funciones, mantenlas exactamente como estaban.
// Para seguridad del ajuste, aquí las incluimos sin cambios funcionales (plantillas completas).
function buildWelcomeEmailHtml({ name, planName, subscriptionId, claimUrl, email, supportEmail, token }) {
  const logoPath = 'https://vwndjpylfcekjmluookj.supabase.co/storage/v1/object/public/assets/0944255a-e933-4527-9aa5-f9e18e862a00.jpg';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="color-scheme" content="dark light"><meta name="supported-color-schemes" content="dark light"><style>@media (prefers-color-scheme: dark) { .wrap { background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01)) !important; } }</style></head><body style="margin:0;padding:0;background-color:#000000;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#000000" style="background-color:#000000;width:100%;min-width:100%;margin:0;padding:24px 0;"><tr><td align="center" valign="top"><table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:680px;margin:0 auto;"><tr><td style="padding:0 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:12px;overflow:hidden;background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));box-shadow:0 10px 30px rgba(2,6,23,0.6);border:1px solid rgba(255,255,255,0.03);"><tr><td style="padding:28px 24px 8px 24px;text-align:center;"><div style="width:96px;height:96px;border-radius:50%;overflow:hidden;margin:0 auto;display:block;border:4px solid rgba(255,255,255,0.04);box-shadow:0 8px 30px rgba(2,6,23,0.6);background:linear-gradient(135deg,#0f1720,#08101a);"><img src="${logoPath}" alt="NAZA logo" width="96" height="96" style="display:block;width:96px;height:96px;object-fit:cover;transform:scale(1.12);border-radius:50%;" /></div><h1 style="color:#ff9b3b;margin:18px 0 8px 0;font-size:26px;font-family:Arial,sans-serif;">NAZA Trading Academy</h1><div style="color:#cbd5e1;margin:6px 0 20px 0;font-size:16px;font-family:Arial,sans-serif;">¡Bienvenido! Tu suscripción ha sido activada correctamente.</div></td></tr><tr><td style="padding:20px 28px 28px 28px;color:#d6e6f8;font-family:Arial,sans-serif;line-height:1.5;"><div style="font-size:15px;margin-bottom:16px;"><strong>Hola ${escapeHtml(name || 'usuario')},</strong></div><div style="background:linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.005));padding:18px;border-radius:10px;border:1px solid rgba(255,255,255,0.02);margin-top:0;"><p style="margin:0 0 10px 0;"><strong>Entrega del servicio</strong></p><p style="margin:0;color:#d6e6f8">Todos los privilegios de tu plan —cursos, clases en vivo, análisis exclusivos y canales privados— se gestionan dentro de <strong>Discord</strong>. Al pulsar <em>Obtener acceso</em> recibirás el rol correspondiente y se te desbloquearán automáticamente los canales de tu plan.</p></div><div style="text-align:center;margin:22px 0;"><a href="${claimUrl}" data-token="${encodeURIComponent(token)}" style="display:inline-block;background:#2d9bf0;color:#ffffff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;box-shadow:0 8px 30px rgba(45,155,240,0.15);font-family:Arial,sans-serif;">Obtener acceso</a><div style="color:#9fb0c9;font-size:13px;margin-top:8px;font-family:Arial,sans-serif;">(En caso de no haber reclamado)</div></div><div style="background:linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.005));padding:18px;border-radius:10px;border:1px solid rgba(255,255,255,0.02);margin-top:18px;"><p style="margin:0 0 8px 0;"><strong>Únete a la comunidad y mantente al día</strong></p><p style="margin:0 0 12px 0;color:#d6e6f8">Para ver anuncios oficiales, horarios de clases, avisos de sesiones en vivo y formar parte de los chats (WhatsApp y Telegram), visita nuestro sitio y sigue las instrucciones para unirte a los grupos desde allí.</p><a href="https://nazatradingacademy.com" target="_blank" style="display:block;background:rgba(255,255,255,0.02);padding:14px;border-radius:8px;color:#bfe0ff;text-decoration:none;font-weight:600;border:1px solid rgba(255,255,255,0.02);font-family:Arial,sans-serif;">https://nazatradingacademy.com</a></div><div style="background:linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.005));padding:18px;border-radius:10px;border:1px solid rgba(255,255,255,0.02);margin-top:18px;"><p style="margin:0 0 8px 0;"><strong>¿Nuevo en Discord o no tienes cuenta?</strong></p><p style="margin:0 0 12px 0;color:#d6e6f8">Si necesitas ayuda, usa los enlaces de abajo:</p><a href="https://discord.com/download" target="_blank" style="display:inline-block;padding:10px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.04);margin-right:12px;text-decoration:none;color:#d6e6f8;font-weight:600;background:transparent;font-family:Arial,sans-serif;">Descargar Discord</a><a href="https://youtu.be/-qgmEy1XjMg?si=vqXGRkIid-kgTCTr" target="_blank" style="display:inline-block;padding:10px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.04);text-decoration:none;color:#d6e6f8;font-weight:600;background:transparent;font-family:Arial,sans-serif;">Cómo crear una cuenta (ES)</a></div><div style="font-size:13px;color:#9fb0c9;margin-top:12px;font-family:Arial,sans-serif;"><div><strong>Detalles de la suscripción:</strong></div><div style="margin-top:6px;">Plan: ${escapeHtml(planName)}</div><div>ID de suscripción: ${escapeHtml(subscriptionId || '')}</div><div>Email: ${escapeHtml(emailSafe(email) || '')}</div><div style="margin-top:6px;font-size:12px;color:#8fa6bf">El enlace es de un solo uso y funciona hasta que completes el registro en Discord. Si ya inicias sesión con OAuth2, no es necesario volver a usarlo.</div></div></td></tr><tr><td style="padding:18px;text-align:center;color:#98b0c8;font-size:13px;background:transparent;border-top:1px solid rgba(255,255,255,0.02);font-family:Arial,sans-serif;"><div>©️ ${new Date().getFullYear()} NAZA Trading Academy</div><div style="margin-top:6px">Soporte: <a href="mailto:${SUPPORT_EMAIL || 'support@nazatradingacademy.com'}" style="color:#bfe0ff;text-decoration:none">${SUPPORT_EMAIL || 'support@nazatradingacademy.com'}</a></div></td></tr></table></td></tr></table></td></tr></table></body></html>`;
}

function buildWelcomeText({ name, planName, subscriptionId, claimUrl, supportEmail, email, token }) {
  return `Hola ${name || 'usuario'}, ¡Bienvenido a NAZA Trading Academy!\n\nTu suscripción ha sido activada correctamente.\n\nEntrega del servicio:\nTodos los privilegios de tu plan —cursos, clases en vivo, análisis y canales exclusivos— se entregan a través de Discord. Al pulsar "Obtener acceso" se te asignará automáticamente el rol correspondiente y se desbloquearán los canales de tu plan.\n\nÚnete a la comunidad:\nPara anuncios oficiales, horarios de clases y unirte a los chats (WhatsApp y Telegram), visita: https://nazatradingacademy.com\n\nSi no tienes Discord:\n- Descargar Discord: https://discord.com/download\n- Cómo crear una cuenta (ES): https://youtu.be/-qgmEy1XjMg?si=vqXGRkIid-kgTCTr\n\nEnlace para obtener acceso (un solo uso — válido hasta completar registro):\n${claimUrl}\n\nDetalles:\nPlan: ${planName}\nID de suscripción: ${subscriptionId || ''}\nEmail: ${email || ''}\n\nSoporte: ${SUPPORT_EMAIL || 'support@nazatradingacademy.com'}\n\nNota: El enlace es de un solo uso y funcionará hasta que completes el proceso en Discord.`;
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

  // Si nos pasan existingToken, NO creamos uno nuevo
  let token = existingToken;
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
  }

  const claimUrl = `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(DISCORD_CLIENT_ID)}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URL)}&response_type=code&scope=identify%20guilds.join&state=${encodeURIComponent(token)}`;

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
    console.log('DEBUG sendWelcomeEmail -> token:', token);
    console.log('DEBUG sendWelcomeEmail -> claimUrl:', claimUrl);
    const result = await sgMail.send(msg);
    console.log('✅ Email enviado a:', email, 'SendGrid result:', result?.[0]?.statusCode || 'unknown');
  } catch (error) {
    console.error('❌ Error enviando email con SendGrid:', error?.message || error);
    if (error?.response?.body) console.error('SendGrid response body:', error.response.body);
    throw error;
  }
}

// ============================================
// FUNCIONES PARA ASIGNAR / QUITAR ROLES (API REST + fallback discord.js)
// Añadimos logging más claro para depuración.
async function addRoleToMemberViaApi(discordId, roleId) {
  if (!discordId || !roleId) return false;
  if (!GUILD_ID) {
    console.warn('GUILD_ID no configurado; no se puede añadir rol vía API');
    return false;
  }
  if (!DISCORD_BOT_TOKEN) {
    console.warn('DISCORD_BOT_TOKEN no configurado; no se puede añadir rol vía API');
    return false;
  }
  try {
    const url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}/roles/${roleId}`;
    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    const status = resp ? resp.status : 'no-response';
    let body = '<no-body>';
    try { body = await resp.text(); } catch(e) {}
    console.log(`DEBUG addRoleViaApi -> status: ${status}, body: ${String(body).substring(0,400)}`);
    if (resp && resp.status === 204) {
      console.log(`✅ Rol ${roleId} añadido via API a ${discordId}`);
      return true;
    } else {
      console.warn(`⚠️ API addRole responded ${status}: ${body}`);
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
  if (!DISCORD_BOT_TOKEN) {
    console.warn('DISCORD_BOT_TOKEN no configurado; no se puede remover rol vía API');
    return false;
  }
  try {
    const url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}/roles/${roleId}`;
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`
      }
    });
    const status = resp ? resp.status : 'no-response';
    let body = '<no-body>';
    try { body = await resp.text(); } catch(e) {}
    console.log(`DEBUG removeRoleViaApi -> status: ${status}, body: ${String(body).substring(0,400)}`);
    if (resp && resp.status === 204) {
      console.log(`✅ Rol ${roleId} removido via API de ${discordId}`);
      return true;
    } else {
      console.warn(`⚠️ API removeRole responded ${status}: ${body}`);
      return false;
    }
  } catch (err) {
    console.error('❌ removeRoleFromMemberViaApi error:', err);
    return false;
  }
}

// assignDiscordRole: intenta API con bot token; si falla, intenta con discord.js (fetch member y add)
async function assignDiscordRole(discordId, roleId) {
  if (!discordId || !roleId) {
    console.warn('assignDiscordRole: falta discordId o roleId');
    return false;
  }
  // Primero intentamos vía API (requiere Bot token)
  try {
    const okApi = await addRoleToMemberViaApi(discordId, roleId);
    if (okApi) return true;
  } catch(e) {
    console.warn('assignDiscordRole: addRoleToMemberViaApi fallo:', e);
  }

  // Fallback con discord.js
  try {
    const guild = await discordClient.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);
    await member.roles.add(roleId);
    console.log('✅ Rol asignado con discord.js (fallback)');
    return true;
  } catch (err) {
    console.error('❌ Error asignando rol (discord.js fallback):', err);
    return false;
  }
}

async function removeDiscordRole(discordId, roleId) {
  if (!discordId || !roleId) {
    console.warn('removeDiscordRole: falta discordId o roleId');
    return false;
  }
  try {
    const okApi = await removeRoleFromMemberViaApi(discordId, roleId);
    if (okApi) return true;
  } catch(e) {
    console.warn('removeDiscordRole: removeRoleFromMemberViaApi fallo:', e);
  }

  try {
    const guild = await discordClient.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);
    await member.roles.remove(roleId);
    console.log('✅ Rol removido con discord.js (fallback)');
    return true;
  } catch (err) {
    console.error('❌ Error removiendo rol (discord.js fallback):', err);
    return false;
  }
}

// ============================================
// HELPERS: calcular expiry y elegir role por plan
function calculateExpiryDate(plan) {
  const now = new Date();
  let days = 30;
  if (plan === 'plan_trimestral' || plan === 'trimestral') days = 90;
  if (plan === 'plan_anual' || plan === 'anual') days = 365;
  return new Date(now.getTime() + days * 24*60*60*1000).toISOString();
}

function getRoleIdForPlan(planId) {
  // == FIXED: devolver SOLO el role correspondiente al plan recibido.
  // No hacer 'fallback' automático a otros role IDs.
  const key = String(planId || '').toLowerCase().trim();
  const mapping = {
    'plan_mensual': ROLE_ID_SENALESDISCORD,
    'mensual': ROLE_ID_SENALESDISCORD,
    'plan_trimestral': ROLE_ID_MENTORIADISCORD,
    'trimestral': ROLE_ID_MENTORIADISCORD,
    'plan_anual': ROLE_ID_ANUALDISCORD,
    'anual': ROLE_ID_ANUALDISCORD
  };
  if (mapping[key] && mapping[key].trim() !== '') return mapping[key];
  return null; // si no coincide, devolver null (no asignar rol)
}

// ============================================
// VALIDACIÓN SIMPLE DE CONTRASEÑA (endpoints)
function validatePasswordFromBody(req) {
  const sent = (req.body && req.body.password) ? String(req.body.password) : '';
  if (!sent) return false;
  return sent === API_PASSWORD;
}

// ============================================
// FUNCIONES DE CLAIMS / MEMBERSHIPS (DB)
// NOTA: la tabla 'memberships' debe existir con los campos indicados en tus requisitos.
// create-membership y redeem-claim siguen la lógica solicitada.

// ENDPOINT: POST /create-membership
app.post('/create-membership', async (req, res) => {
  try {
    if (!validatePasswordFromBody(req)) {
      return res.status(401).json({ success:false, message: 'password inválida' });
    }
    const body = req.body || {};
    const name = (body.nombre || body.name || '').toString().trim();
    const email = (body.email || '').toString().trim().toLowerCase();
    const plan = (body.plan || '').toString().trim();
    const discordId = body.discordId || body.discord_id || null;

    if (!name || !email || !plan) {
      return res.status(400).json({ success:false, message: 'Campos requeridos: nombre, email, plan' });
    }

    // Generar claim único y crear membership row
    let claim = null;
    let inserted = null;
    const maxAttempts = 6;
    for (let i=0;i<maxAttempts;i++) {
      claim = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      const nowIso = new Date().toISOString();
      const expires_at = calculateExpiryDate(plan);
      const row = {
        claim,
        name,
        email,
        plan,
        discord_id: discordId || null,
        created_at: nowIso,
        expires_at,
        active: true,
        used: false,
        revoked_at: null,
        redeemed_at: null
      };

      const { data, error } = await supabase.from('memberships').insert([row]).select().limit(1);
      if (error) {
        const msg = (error.message || '').toLowerCase();
        console.warn('Error insert membership attempt', i+1, error);
        if (msg.includes('duplicate') || msg.includes('unique') || msg.includes('already exists')) {
          continue;
        } else {
          return res.status(500).json({ success:false, message:'Error insertando membership', error });
        }
      } else {
        inserted = Array.isArray(data) && data.length > 0 ? data[0] : (data || row);
        break;
      }
    }

    if (!inserted) {
      return res.status(500).json({ success:false, message:'No se pudo generar un claim único. Intentá de nuevo.' });
    }

    // Enviar email con el claim (sin modificar su cuerpo)
    sendWelcomeEmail(email, name, plan, null, null, {}, claim)
      .then(()=> console.log('Email enviado (async).'))
      .catch(err => console.error('Error enviando email:', err?.message || err));

    // Si discordId se pasó, intentamos asignar rol (pero preferimos hacerlo en /redeem-claim o en el OAuth callback)
    if (discordId) {
      const roleId = getRoleIdForPlan(plan);
      if (roleId) assignDiscordRole(discordId, roleId).catch(err => console.error('assignDiscordRole error:', err));
    }

    return res.status(201).json({
      success:true,
      membership: {
        id: inserted.id || null,
        name: inserted.name,
        email: inserted.email,
        plan: inserted.plan,
        discord_id: inserted.discord_id,
        claim: inserted.claim,
        created_at: inserted.created_at,
        expires_at: inserted.expires_at,
        active: inserted.active,
        used: inserted.used
      }
    });
  } catch (err) {
    console.error('❌ Error en /create-membership:', err);
    return res.status(500).json({ success:false, message:'Error interno' });
  }
});

// ENDPOINT: POST /redeem-claim
// Este endpoint consume el claim (marca used=true y redeemed_at) y si recibe discordId lo asigna.
// Nota: si querés "forzar" la adición al servidor sin OAuth, no es posible sin el access_token del usuario.
// El flujo correcto es: el usuario hace OAuth (vía /api/auth/claim) y en el callback usamos el access_token.
app.post('/redeem-claim', async (req, res) => {
  try {
    if (!validatePasswordFromBody(req)) {
      return res.status(401).json({ success:false, message: 'password inválida' });
    }
    const { claim, discordId } = req.body || {};
    if (!claim) return res.status(400).json({ success:false, message:'claim es requerido' });

    const { data: rows, error: fetchErr } = await supabase.from('memberships').select('*').eq('claim', claim).limit(1);
    if (fetchErr) {
      console.error('Error consultando membership por claim:', fetchErr);
      return res.status(500).json({ success:false, message:'Error interno' });
    }
    if (!rows || rows.length === 0) return res.status(404).json({ success:false, message:'Claim no encontrado' });
    const membership = rows[0];

    if (membership.used === true || membership.active === false) {
      return res.status(400).json({ success:false, message:'Este claim ya fue usado o la membership no está activa' });
    }

    const updates = {
      used: true,
      active: false,
      redeemed_at: new Date().toISOString()
    };
    if (discordId) updates.discord_id = discordId;

    const { data: updateData, error: updateErr } = await supabase.from('memberships').update(updates).eq('claim', claim).select().limit(1);
    if (updateErr) {
      console.error('Error actualizando membership:', updateErr);
      return res.status(500).json({ success:false, message:'Error interno' });
    }

    // Asignar rol si discordId fue pasado
    const finalDiscordId = discordId || membership.discord_id;
    if (finalDiscordId) {
      const roleId = getRoleIdForPlan(membership.plan || membership.plan_id);
      if (roleId) {
        await assignDiscordRole(finalDiscordId, roleId).catch(err => console.error('assignDiscordRole error:', err));
      } else {
        console.warn('No se encontró roleId para plan:', membership.plan || membership.plan_id);
      }
    }

    return res.json({ success:true, membership: (Array.isArray(updateData) ? updateData[0] : updateData) || membership });
  } catch (err) {
    console.error('❌ Error en /redeem-claim:', err);
    return res.status(500).json({ success:false, message:'Error interno' });
  }
});

// ============================================
// RUTA: /api/auth/claim  -> redirige al OAuth de Discord (el link que mandamos por email)
app.get('/api/auth/claim', async (req, res) => {
  const token = req.query.token || req.query.state;
  if (!token) return res.status(400).send('Token missing');
  try {
    // Verificamos que exista y no esté usado
    const { data: rows, error } = await supabase
      .from('memberships')
      .select('id,claim,used')
      .eq('claim', token)
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
    const clientId = encodeURIComponent(DISCORD_CLIENT_ID);
    const redirectUri = encodeURIComponent(DISCORD_REDIRECT_URL);
    const scope = encodeURIComponent('identify guilds.join');
    const prompt = 'consent';
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${encodeURIComponent(token)}&prompt=${prompt}`;
    return res.redirect(discordAuthUrl);
  } catch (err) {
    console.error('❌ Error en /api/auth/claim:', err);
    return res.status(500).send('Error interno');
  }
});

// ============================================
// CALLBACK DE DISCORD OAUTH2 -> /discord/callback
// Intercambia code por token, obtiene user, agrega al guild usando el access_token y asigna rol.
// Marca claim como used en DB luego de guardar membership.
app.get('/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Faltan parámetros');

    // 1) Intercambiar code por access_token
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
    if (!tokenData || !tokenData.access_token) {
      console.error('❌ Error obteniendo token:', tokenData);
      return res.status(400).send('Error de autorización');
    }

    // 2) Obtener info del usuario
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userData = await userResponse.json();
    const discordId = userData.id;
    const discordUsername = userData.username;
    console.log('👤 Usuario Discord (OAuth):', discordUsername, discordId);

    // 3) Intentar agregar al guild usando el access_token (esto añade al usuario si no estaba)
    try {
      const putUrl = `https://discord.com/api/guilds/${GUILD_ID}/members/${discordId}`;
      const putBody = {
        access_token: tokenData.access_token
      };
      const addResp = await fetch(putUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(putBody)
      });
      const addStatus = addResp.status;
      let addText = '<no body>';
      try { addText = await addResp.text(); } catch(e) {}
      console.log(`DEBUG add-member via OAuth -> status: ${addStatus}, body: ${String(addText).substring(0,400)}`);
      // Note: Discord retorna 201 or 204 on success or 204; si ya está en el servidor puede retornar 201/204
    } catch (err) {
      console.warn('⚠️ No se pudo añadir al usuario al guild via OAuth PUT:', err);
    }

    // 4) Asignar rol según plan asociado al state/claim en DB
    // buscar membership por claim = state
    let membership = null;
    try {
      const { data: rows } = await supabase.from('memberships').select('*').eq('claim', state).limit(1);
      if (rows && rows.length > 0) membership = rows[0];
    } catch (err) {
      console.error('Error buscando membership por claim en callback:', err);
    }

    // Guardar / actualizar membership: guardar discord_id y username, status, created_at si no existe
    try {
      const updates = {
        discord_id: discordId,
        discord_username: discordUsername,
        used: true,
        redeemed_at: new Date().toISOString(),
        active: true
      };
      if (membership) {
        await supabase.from('memberships').update(updates).eq('id', membership.id);
      } else {
        // Si por alguna razón no existe en DB, crear una fila mínima
        const row = {
          claim: state,
          name: userData.username || '',
          email: '', // no tenemos email via Discord
          plan: membership ? membership.plan : 'plan_mensual',
          discord_id: discordId,
          discord_username: discordUsername,
          created_at: new Date().toISOString(),
          expires_at: calculateExpiryDate(membership ? membership.plan : 'plan_mensual'),
          active: true,
          used: true,
          redeemed_at: new Date().toISOString()
        };
        await supabase.from('memberships').insert([row]);
      }
    } catch (err) {
      console.error('Error guardando/actualizando membership en callback:', err);
    }

    // 5) Asignar rol al usuario
    const planOfUser = membership ? (membership.plan || membership.plan_id) : 'plan_mensual';
    const roleId = getRoleIdForPlan(planOfUser);
    if (roleId) {
      const ok = await assignDiscordRole(discordId, roleId).catch(err => { console.error('assignDiscordRole error in callback:', err); return false; });
      if (!ok) console.warn('⚠️ assignDiscordRole devolvió false — revisá permisos o jerarquía del bot.');
    } else {
      console.warn('No se encontró roleId para plan:', planOfUser);
    }

    // 6) Redirigir a success
    const successRedirect = FRONTEND_URL ? `${FRONTEND_URL}/gracias` : 'https://discord.gg';
    return res.send(`
<!DOCTYPE html><html><head><meta charset="UTF-8"><title>¡Bienvenido!</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <div style="background:rgba(255,255,255,0.04);padding:32px;border-radius:12px;text-align:center;">
    <h1>🎉 ¡Bienvenido!</h1>
    <p>Tu rol ha sido asignado correctamente (si el bot tiene permisos). Serás redirigido en unos segundos...</p>
    <a href="${successRedirect}" style="display:inline-block;margin-top:12px;padding:12px 20px;border-radius:8px;background:#fff;color:#111;text-decoration:none;font-weight:bold;">Ir a Discord</a>
  </div>
  <script>setTimeout(()=>{ window.location.href='${successRedirect}' }, 3000);</script>
</body></html>`);
  } catch (err) {
    console.error('❌ Error en discord callback:', err);
    return res.status(500).send('Error procesando la autorización');
  }
});

// ============================================
// EXPIRACIONES AUTOMÁTICAS
async function expireMemberships() {
  try {
    console.log('⏱️ Chequeando memberships expiradas...');
    const nowIso = new Date().toISOString();
    const { data: rows, error } = await supabase
      .from('memberships')
      .select('*')
      .lte('expires_at', nowIso)
      .eq('active', true)
      .limit(1000);

    if (error) {
      console.error('Error buscando expiradas:', error);
      return;
    }
    if (!rows || rows.length === 0) {
      console.log('ℹ️ No expiradas en este ciclo.');
      return;
    }

    for (const m of rows) {
      try {
        const roleId = getRoleIdForPlan(m.plan || m.plan_id);

        // 1) Si tenemos discord_id y roleId, intentar remover el rol
        if (m.discord_id && roleId) {
          try {
            await removeDiscordRole(m.discord_id, roleId);
          } catch (err) {
            console.error('removeDiscordRole error:', err);
          }
        }

        // Nota: Ya no expulsamos (kick) al usuario. Solo quitamos el rol como pidió el cliente.

        // 2) Marcar membership como revocada en la DB
        const updates = { active: false, revoked_at: new Date().toISOString() };
        const { error: updErr } = await supabase.from('memberships').update(updates).eq('id', m.id);
        if (updErr) console.error('Error marcando revocada:', updErr);
        else console.log(`✅ Membership ${m.id || m.claim} marcada como revocada.`);
      } catch (innerErr) {
        console.error('Error procesando membership expirada:', innerErr);
      }
    }

  } catch (err) {
    console.error('❌ Error en expireMemberships:', err);
  }
}
setTimeout(() => {
  expireMemberships().catch(err => console.error('expireMemberships startup error:', err));
  // === CAMBIO REALIZADO: ejecutar expireMemberships cada 60 segundos (1 minuto)
  setInterval(() => expireMemberships().catch(err => console.error('expireMemberships interval error:', err)), 60*1000);
}, 3000);

// ============================================
// VERIFICAR BOT TOKEN AL INICIO -> LOG claro para 401 debugging
async function verifyBotTokenAtStartup() {
  try {
    if (!DISCORD_BOT_TOKEN) {
      console.warn('⚠️ verifyBotToken: DISCORD_BOT_TOKEN vacío.');
      return;
    }
    const resp = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
    });
    const status = resp.status;
    let body = '<no-body>';
    try { body = await resp.text(); } catch(e) {}
    console.log(`VERIFY_BOT_TOKEN -> status=${status} body=${String(body).substring(0,400)}`);
    if (status === 200) {
      console.log('✅ verifyBotToken: token válido (API responde 200).');
    } else if (status === 401) {
      console.error('❌ verifyBotToken: 401 Unauthorized -> token inválido o revocado.');
    } else {
      console.warn('⚠️ verifyBotToken: respuesta inesperada:', status);
    }
  } catch (err) {
    console.error('❌ verifyBotToken error:', err);
  }
}
verifyBotTokenAtStartup();

// ============================================
// HEALTH
app.get('/health', (req, res) => res.json({ status:'ok', timestamp: new Date().toISOString() }));

// ============================================
// INICIAR SERVIDOR
app.listen(PORT, () => {
  console.log('🚀 NAZA Bot iniciado en puerto', PORT);
  console.log('🔔 Discord token presente?', !!DISCORD_BOT_TOKEN);
  console.log('🔗 Supabase presente?', !!SUPABASE_URL);
});

