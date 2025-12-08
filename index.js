// index.js - NAZA (versión simplificada según requisitos)
// Requisitos: Node >=18, @sendgrid/mail, @supabase/supabase-js, discord.js
// NOTA: la función de envío de correo se mantiene exactamente como en el fichero original.

const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ==================================================
// CONFIG (variables de entorno - usa los nombres solicitados)
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'no-reply@example.com';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@example.com';

// Variables relacionadas a Discord (según tus instrucciones)
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN; // admitir ambos nombres
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL || '';
const GUILD_ID = process.env.GUILD_ID;
const MEMBER_ROLE_ID = process.env.MEMBER_ROLE_ID; // role que se asigna / remueve

// ==================================================
// Configurar SendGrid (la función sendWelcomeEmail usa sgMail internamente)
if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
} else {
  console.warn('⚠️ SENDGRID_API_KEY no definido. sendWelcomeEmail fallará si intenta enviar correos.');
}

// ==================================================
// Supabase (usar service role para operaciones administrativas)
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('❌ SUPABASE_URL o SUPABASE_SERVICE_ROLE no están configurados en el entorno.');
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  global: {
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      apikey: SUPABASE_SERVICE_ROLE
    }
  }
});

// ==================================================
// Cliente Discord
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

discordClient.once('ready', () => {
  console.log('✅ Discord listo:', discordClient.user?.tag || '(sin tag)');
});
discordClient.on('error', (err) => console.error('Discord client error:', err));
if (DISCORD_TOKEN) {
  discordClient.login(DISCORD_TOKEN).catch(err => console.error('Error login Discord:', err));
} else {
  console.warn('⚠️ DISCORD_TOKEN no definido. Las operaciones de rol en Discord fallarán.');
}

// ==================================================
// UTILIDADES (pequeñas, en español)
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function emailSafe(e){ return e || ''; }

// ==================================================
// === FUNCIONES DE EMAIL (DEJADAS EXACTAMENTE COMO EN EL INDEX ORIGINAL) ===
// Nota: mantuve buildWelcomeEmailHtml, buildWelcomeText y sendWelcomeEmail sin cambios funcionales.
// Estas funciones referencian variables de entorno como SENDGRID_API_KEY, FROM_EMAIL, SUPPORT_EMAIL,
// DISCORD_CLIENT_ID y DISCORD_REDIRECT_URL. NO CAMBIAR su contenido si querés adherir al requerimiento.

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
@media (prefers-color-scheme: dark) {
  .wrap { background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01)) !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background-color:#000000;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#000000" style="background-color:#000000;width:100%;min-width:100%;margin:0;padding:24px 0;">
    <tr>
      <td align="center" valign="top">
        <table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:680px;margin:0 auto;">
          <tr>
            <td style="padding:0 16px;">
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
    // Este código original crearía un claim si no hay token. Lo dejamos tal cual.
    token = crypto.randomBytes(24).toString('hex'); // fallback simple si se llega aquí
  }

  // OAuth2 directo (el botón del correo irá directamente al OAuth2 de Discord)
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

// ==================================================
// ENDPOINTS REQUERIDOS (sin autenticación adicional)
// 1) POST /create-membership
// 2) POST /redeem-claim

// Helper: calcula expires_at según plan
function calculateExpiryDate(plan) {
  const now = new Date();
  let daysToAdd = 30;
  if (plan === 'trimestral' || plan === 'plan_trimestral') daysToAdd = 90;
  if (plan === 'anual' || plan === 'plan_anual') daysToAdd = 365;
  // también aceptar 'mensual' o 'plan_mensual'
  return new Date(now.getTime() + daysToAdd * 24 * 60 * 60 * 1000).toISOString();
}

// Helper: intenta asignar rol en Discord (si está conectado y params presentes)
async function assignDiscordRole(discordId) {
  if (!discordId) return;
  if (!GUILD_ID || !MEMBER_ROLE_ID) {
    console.warn('⚠️ GUILD_ID o MEMBER_ROLE_ID no configurados; no se asigna rol.');
    return;
  }
  try {
    const guild = await discordClient.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);
    await member.roles.add(MEMBER_ROLE_ID);
    console.log(`✅ Rol ${MEMBER_ROLE_ID} asignado a ${discordId}`);
  } catch (err) {
    console.error('❌ Error asignando rol en Discord:', err?.message || err);
  }
}

// Helper: intenta remover rol en Discord (si está conectado y params presentes)
async function removeDiscordRole(discordId) {
  if (!discordId) return;
  if (!GUILD_ID || !MEMBER_ROLE_ID) {
    console.warn('⚠️ GUILD_ID o MEMBER_ROLE_ID no configurados; no se remueve rol.');
    return;
  }
  try {
    const guild = await discordClient.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);
    // Si el miembro no existe o no tiene el rol, esto puede fallar; atrapamos errores
    await member.roles.remove(MEMBER_ROLE_ID);
    console.log(`✅ Rol ${MEMBER_ROLE_ID} removido de ${discordId}`);
  } catch (err) {
    console.error('❌ Error removiendo rol en Discord:', err?.message || err);
  }
}

// POST /create-membership
// Body: { nombre, email, plan, discordId? }
// Comportamiento: genera claim único, inserta fila en memberships y envía el email (usando sendWelcomeEmail sin tocar su cuerpo).
app.post('/create-membership', async (req, res) => {
  try {
    const body = req.body || {};
    // Aceptar los nombres en español/inglés: nombre / name
    const name = (body.nombre || body.name || '').toString().trim();
    const email = (body.email || '').toString().trim().toLowerCase();
    const plan = (body.plan || '').toString().trim(); // ej. 'plan_mensual' o 'mensual'
    const discordId = body.discordId || body.discord_id || null;

    // Validaciones mínimas (según petición: no agregar validaciones extras, sólo campos esenciales)
    if (!name || !email || !plan) {
      return res.status(400).json({ success: false, message: 'Campos requeridos: nombre, email, plan' });
    }

    // Generar claim único y tratar posibles conflictos (reintentos si UNIQUE constraint falla)
    let claim = null;
    let inserted = null;
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      claim = crypto.randomUUID(); // token/UUID único
      const created_at = new Date().toISOString();
      const expires_at = calculateExpiryDate(plan);
      const row = {
        claim,
        name,
        email,
        plan,
        discord_id: discordId || null,
        created_at,
        expires_at,
        active: true,
        used: false,
        revoked_at: null,
        redeemed_at: null
      };

      // Intentar insertar
      const { data, error } = await supabase.from('memberships').insert([row]).select().limit(1);
      if (error) {
        // Si el error indica conflicto en claim (unique), reintentar con nuevo UUID
        const msg = (error.message || '').toLowerCase();
        console.warn('Insert memberships error (attempt', attempt + 1, '):', error);
        if (msg.includes('duplicate') || msg.includes('unique') || msg.includes('already exists')) {
          // reintentar generando otro claim
          continue;
        } else {
          // error serio de DB
          return res.status(500).json({ success: false, message: 'Error insertando membership', error });
        }
      } else {
        inserted = Array.isArray(data) && data.length > 0 ? data[0] : (data || row);
        break;
      }
    }

    if (!inserted) {
      return res.status(500).json({ success: false, message: 'No se pudo generar un claim único. Intenta de nuevo.' });
    }

    // Enviar email de bienvenida usando la función existente (no tocar su contenido).
    // Pasamos existingToken = claim para que la función no cree otro claim en la DB.
    sendWelcomeEmail(email, name, plan, null, null, {}, claim)
      .then(()=> console.log('Email enviado (llamada async).'))
      .catch(err => console.error('Error enviando email (sendWelcomeEmail):', err?.message || err));

    // Si discordId viene en el body, asignar rol inmediatamente
    if (discordId) {
      assignDiscordRole(discordId).catch(err => console.error('assignDiscordRole error:', err));
    }

    // Responder con la membership creada (incluyendo claim y expires_at)
    return res.status(201).json({
      success: true,
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
    return res.status(500).json({ success: false, message: 'Error interno' });
  }
});

// POST /redeem-claim
// Body: { claim, discordId? }
// Comportamiento: busca membership por claim, si no existe o ya fue usado -> error.
// Si existe y está activa -> marcar used = true, active = false, redeemed_at = now(), asignar discord_id si viene y asignar rol.
app.post('/redeem-claim', async (req, res) => {
  try {
    const { claim, discordId } = req.body || {};
    if (!claim) return res.status(400).json({ success: false, message: 'claim es requerido' });

    // Buscar membership por claim
    const { data: rows, error: fetchErr } = await supabase.from('memberships').select('*').eq('claim', claim).limit(1);
    if (fetchErr) {
      console.error('Error consultando membership por claim:', fetchErr);
      return res.status(500).json({ success: false, message: 'Error interno' });
    }
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Claim no encontrado' });
    }
    const membership = rows[0];

    // Verificar si ya fue usado o no está activo
    if (membership.used === true || membership.active === false) {
      return res.status(400).json({ success: false, message: 'Este claim ya fue usado o la membership no está activa' });
    }

    // Actualizar: marcar used=true, active=false, redeemed_at ahora, guardar discord_id si viene
    const updates = {
      used: true,
      active: false,
      redeemed_at: new Date().toISOString()
    };
    if (discordId) updates.discord_id = discordId;

    const { data: updateData, error: updateErr } = await supabase.from('memberships').update(updates).eq('claim', claim).select().limit(1);
    if (updateErr) {
      console.error('Error actualizando membership al redimir claim:', updateErr);
      return res.status(500).json({ success: false, message: 'Error interno' });
    }

    // Asignar rol si discordId fue pasado ahora (o si ya existía discord_id en DB)
    const finalDiscordId = discordId || membership.discord_id;
    if (finalDiscordId) {
      await assignDiscordRole(finalDiscordId).catch(err => console.error('assignDiscordRole error:', err));
    }

    return res.json({ success: true, membership: (Array.isArray(updateData) ? updateData[0] : updateData) || membership });
  } catch (err) {
    console.error('❌ Error en /redeem-claim:', err);
    return res.status(500).json({ success: false, message: 'Error interno' });
  }
});

// ==================================================
// EXPIRACIONES AUTOMÁTICAS
// - Al iniciar y luego periódicamente (cada hora) se buscan memberships con expires_at <= now y active = true.
// - Para cada una: si tiene discord_id -> quitar role en Discord; marcar active=false, revoked_at = now().

async function expireMemberships() {
  try {
    console.log('⏱️ Comprobando memberships expiradas...');
    const nowIso = new Date().toISOString();
    const { data: rows, error } = await supabase
      .from('memberships')
      .select('*')
      .lte('expires_at', nowIso)
      .eq('active', true)
      .limit(1000); // límite razonable por pasada

    if (error) {
      console.error('Error buscando memberships expiradas:', error);
      return;
    }
    if (!rows || rows.length === 0) {
      console.log('ℹ️ No hay memberships expiradas en este ciclo.');
      return;
    }

    console.log(`ℹ️ Encontradas ${rows.length} memberships expiradas. Procesando...`);
    for (const m of rows) {
      try {
        if (m.discord_id) {
          await removeDiscordRole(m.discord_id).catch(err => console.error('removeDiscordRole error:', err));
        }
        const updates = {
          active: false,
          revoked_at: new Date().toISOString()
        };
        const { error: updErr } = await supabase.from('memberships').update(updates).eq('id', m.id);
        if (updErr) {
          console.error('Error marcando membership como revocada:', updErr);
        } else {
          console.log(`✅ Membership ${m.id || m.claim} marcada como revocada.`);
        }
      } catch (innerErr) {
        console.error('Error procesando membership expirada:', innerErr);
      }
    }
  } catch (err) {
    console.error('❌ Error en expireMemberships:', err);
  }
}

// Ejecutar al inicio y programar cada hora
(async () => {
  // Esperar un poco para que Discord client pueda conectarse (si corresponde)
  setTimeout(() => {
    expireMemberships().catch(err => console.error('expireMemberships startup error:', err));
    // cada hora
    setInterval(() => {
      expireMemberships().catch(err => console.error('expireMemberships interval error:', err));
    }, 60 * 60 * 1000);
  }, 3000);
})();

// ==================================================
// HEALTH CHECK
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ==================================================
// INICIAR SERVIDOR
app.listen(PORT, () => {
  console.log('🚀 Servidor iniciado en puerto', PORT);
  console.log('🔗 Supabase URL:', SUPABASE_URL ? '(configurado)' : '(NO configurado)');
  console.log('🔔 Discord:', DISCORD_TOKEN ? '(token presente)' : '(sin token)');
  console.log('📧 SendGrid:', SENDGRID_API_KEY ? '(token presente)' : '(sin token)');
});
