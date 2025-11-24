/* index.js - NAZA bot (completo) */
/* Requisitos: Node >=18, @sendgrid/mail, @supabase/supabase-js, braintree, discord.js, nodemailer opcional si lo usas */

const express = require('express');
const braintree = require('braintree');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// CONFIGURACIÓN
// ============================================
const BRAINTREE_ENV = process.env.BRAINTREE_ENV || 'Sandbox';
const BRAINTREE_MERCHANT_ID = process.env.BRAINTREE_MERCHANT_ID;
const BRAINTREE_PUBLIC_KEY = process.env.BRAINTREE_PUBLIC_KEY;
const BRAINTREE_PRIVATE_KEY = process.env.BRAINTREE_PRIVATE_KEY;

const FRONTEND_TOKEN = process.env.FRONTEND_TOKEN;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim());

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL;
const GUILD_ID = process.env.GUILD_ID;

const ROLE_ID_ANUALDISCORD = process.env.ROLE_ID_ANUALDISCORD;
const ROLE_ID_MENTORIADISCORD = process.env.ROLE_ID_MENTORIADISCORD;
const ROLE_ID_SENALESDISCORD = process.env.ROLE_ID_SENALESDISCORD;

const DATABASE_URL = process.env.DATABASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL;

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const BOT_URL = process.env.BOT_URL || BASE_URL; // URL pública de tu bot para links
const FRONTEND_URL = process.env.FRONTEND_URL || ''; // opcional, para redirecciones finales

// ============================================
// CONFIGURAR SENDGRID
// ============================================
if (!SENDGRID_API_KEY) {
    console.warn('⚠️ SENDGRID_API_KEY no definido. Los correos no podrán enviarse.');
} else {
    sgMail.setApiKey(SENDGRID_API_KEY);
}

// ============================================
// BRAINTREE GATEWAY
// ============================================
const gateway = new braintree.BraintreeGateway({
    environment: BRAINTREE_ENV === 'Production' 
        ? braintree.Environment.Production 
        : braintree.Environment.Sandbox,
    merchantId: BRAINTREE_MERCHANT_ID,
    publicKey: BRAINTREE_PUBLIC_KEY,
    privateKey: BRAINTREE_PRIVATE_KEY
});

// ============================================
// DISCORD CLIENT
// ============================================
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

discordClient.login(DISCORD_BOT_TOKEN);

discordClient.once('ready', () => {
    console.log('✅ Discord bot conectado:', discordClient.user?.tag || '(sin tag aún)');
});

// ============================================
// SUPABASE CLIENT
// ============================================
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ============================================
// ALMACENAMIENTO TEMPORAL PARA OAUTH2 (FRONTEND FLOW)
// ============================================
const pendingAuths = new Map();

// ============================================
// MAPEO DE PLANES A ROLES
// ============================================
function getRoleIdForPlan(planId) {
    const mapping = {
        'plan_mensual': ROLE_ID_SENALESDISCORD,
        'plan_trimestral': ROLE_ID_MENTORIADISCORD,
        'plan_anual': ROLE_ID_ANUALDISCORD
    };
    const roleId = mapping[planId];
    console.log('🎯 getRoleIdForPlan:', { planId, roleId });
    return roleId || ROLE_ID_SENALESDISCORD;
}

// ============================================
// CORS MIDDLEWARE
// ============================================
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-frontend-token');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// ============================================
// MIDDLEWARE DE AUTENTICACIÓN
// ============================================
function authenticateFrontend(req, res, next) {
    const token = req.headers['x-frontend-token'];

    if (!token || token !== FRONTEND_TOKEN) {
        console.error('❌ Token inválido:', token);
        return res.status(401).json({ 
            success: false, 
            message: 'unauthorized',
            error: 'Token inválido'
        });
    }

    next();
}

// ============================================
// UTIL: ESCAPE Y SAFE
// ============================================
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function emailSafe(e){ return e || ''; }

// ============================================
// FUNCIONES AUXILIARES PARA CLAIM TOKEN (SUPABASE)
// - Puedes añadir/editar qué campos guardar aquí
// ============================================
async function createClaimToken({ email, name, plan_id, subscriptionId, customerId, extra = {}, ttlHours = 24 }) {
    const token = crypto.randomBytes(24).toString('hex'); // 48 chars
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();

    // Campos que guardaremos por defecto (puedes añadir más)
    const row = {
        token,
        email,
        name,
        plan_id,
        subscription_id: subscriptionId,
        customer_id: customerId,
        extra: JSON.stringify(extra), // campo JSON para info flexible
        expires_at: expiresAt,
        used: false,
        created_at: new Date().toISOString()
    };

    const { data, error } = await supabase
        .from('claims')
        .insert([row]);

    if (error) {
        console.error('Error al crear claim token en Supabase:', error);
        throw error;
    }
    return token;
}

// ============================================
// EMAIL: Construcción HTML y texto (SendGrid)
// ============================================
function buildWelcomeEmailHtml({ name, planName, subscriptionId, claimUrl, email, supportEmail }) {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body{font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:0}
    .wrap{max-width:600px;margin:24px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 6px 18px rgba(0,0,0,0.08)}
    .header{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:28px;text-align:center}
    .content{padding:24px;color:#111}
    .btn{display:inline-block;background:#2d9bf0;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600}
    .footer{padding:16px;text-align:center;color:#888;font-size:13px;background:#fafafa}
    .muted{color:#666;font-size:14px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <h1>🎉 ¡Bienvenido a NAZA Trading Academy!</h1>
    </div>
    <div class="content">
      <p>Hola <strong>${escapeHtml(name || 'usuario')}</strong>,</p>
      <p>Tu suscripción <strong>${escapeHtml(planName)}</strong> ha sido activada correctamente.</p>
      <p><strong>Detalles:</strong></p>
      <ul>
        <li>Plan: ${escapeHtml(planName)}</li>
        <li>ID de suscripción: ${escapeHtml(subscriptionId)}</li>
        <li>Email: ${escapeHtml(emailSafe(email))}</li>
      </ul>

      <p style="margin-top:16px">
        Para completar tu acceso a Discord y asociar tu cuenta, pulsa el siguiente botón:
      </p>

      <p style="text-align:center;margin:20px 0">
        <a href="${claimUrl}" class="btn">Obtener acceso</a>
      </p>

      <p class="muted">El enlace expira y sólo puede usarse una vez. Si ya iniciaste sesión por OAuth2, no es necesario volver a usarlo.</p>
    </div>

    <div class="footer">
      <div>© ${new Date().getFullYear()} NAZA Trading Academy</div>
      <div style="margin-top:6px">Soporte: ${escapeHtml(supportEmail || FROM_EMAIL)}</div>
    </div>
  </div>
</body>
</html>`;
}

function buildWelcomeText({ name, planName, subscriptionId, claimUrl, supportEmail, email }) {
    return `Hola ${name || 'usuario'},

Tu suscripción "${planName}" ha sido activada.
ID de suscripción: ${subscriptionId}
Email: ${email || ''}

Para completar el acceso a Discord y asociar tu cuenta, visita:
${claimUrl}

Nota: El enlace expira y solo puede usarse una vez.

Soporte: ${supportEmail || FROM_EMAIL}
`;
}

async function sendWelcomeEmail(email, name, planId, subscriptionId, customerId, extra = {}) {
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

    // Crea claim en Supabase (guarda email, name, plan_id, subscription_id, customer_id, extra)
    const token = await createClaimToken({
        email,
        name,
        plan_id: planId,
        subscriptionId,
        customerId,
        extra
    });

    const claimUrl = `${BOT_URL.replace(/\/$/, '')}/api/auth/claim?token=${token}`;
    const html = buildWelcomeEmailHtml({ name, planName, subscriptionId, claimUrl, email, supportEmail: SUPPORT_EMAIL });
    const text = buildWelcomeText({ name, planName, subscriptionId, claimUrl, supportEmail: SUPPORT_EMAIL, email });

    const msg = {
        to: email,
        from: FROM_EMAIL,
        subject: `¡Bienvenido a NAZA Trading Academy! — Obtener acceso`,
        text,
        html
    };

    try {
        const result = await sgMail.send(msg);
        console.log('✅ Email enviado a:', email, 'SendGrid result:', result?.[0]?.statusCode || 'unknown');
    } catch (error) {
        console.error('❌ Error enviando email con SendGrid:', error?.message || error);
        if (error?.response?.body) {
            console.error('SendGrid response body:', error.response.body);
        }
        // No hacemos throw si queremos que el flujo de pago no falle por un error de email.
        throw error;
    }
}

// ============================================
// ENDPOINT: CONFIRMAR PAGO DESDE FRONTEND (mantenido tal cual)
// ============================================
app.post('/api/frontend/confirm', authenticateFrontend, async (req, res) => {
    console.log('📬 POST /api/frontend/confirm');
    try {
        const { nonce, email, name, plan_id } = req.body;

        console.log('📦 Datos recibidos:', { nonce: nonce ? 'SÍ' : 'NO', email, name, plan_id });

        if (!nonce || !email || !name || !plan_id) {
            return res.status(400).json({ success: false, message: 'Faltan datos requeridos' });
        }

        const customerResult = await gateway.customer.create({
            email: email,
            paymentMethodNonce: nonce
        });

        if (!customerResult.success) {
            console.error('❌ Error creando cliente:', customerResult.message);
            return res.status(400).json({ success: false, message: 'Error creando cliente: ' + customerResult.message });
        }

        const paymentMethodToken = customerResult.customer.paymentMethods[0].token;

        const subscriptionResult = await gateway.subscription.create({
            paymentMethodToken: paymentMethodToken,
            planId: plan_id
        });

        if (!subscriptionResult.success) {
            console.error('❌ Error creando suscripción:', subscriptionResult.message);
            return res.status(400).json({ success: false, message: 'Error creando suscripción: ' + subscriptionResult.message });
        }

        const subscriptionId = subscriptionResult.subscription.id;
        const customerId = (subscriptionResult.subscription.transactions && subscriptionResult.subscription.transactions[0] && subscriptionResult.subscription.transactions[0].customer && subscriptionResult.subscription.transactions[0].customer.id) || (customerResult.customer.id) || null;

        console.log('✅ Suscripción creada:', subscriptionId);
        console.log('👤 Customer ID:', customerId);

        // --- FRONTEND FLOW: generar state y guardar en memoria (para redirección inmediata desde frontend)
        const state = crypto.randomBytes(16).toString('hex');
        pendingAuths.set(state, {
            email,
            name,
            plan_id,
            subscription_id: subscriptionId,
            customer_id: customerId,
            timestamp: Date.now()
        });
        setTimeout(() => { pendingAuths.delete(state); }, 10 * 60 * 1000);

        const oauthUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URL)}&response_type=code&scope=identify%20guilds.join&state=${state}`;

        // Enviar email con claim (email flow) en paralelo. guardamos campos extras si quieres (ejemplo)
        sendWelcomeEmail(email, name, plan_id, subscriptionId, customerId, { source: 'frontend_confirm' })
            .catch(err => console.error('❌ Error al enviar email (background):', err));

        // Respuesta al frontend
        res.json({
            success: true,
            subscription_id: subscriptionId,
            customer_id: customerId,
            oauth_url: oauthUrl,
            message: 'Suscripción creada. Recibirás un email con "Obtener acceso".'
        });

        console.log('✅ Respuesta enviada al frontend');
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================
// ENDPOINT: CLAIM TOKEN PARA OAUTH2 (vía email)
// Marca used=true y redirige a Discord OAuth2
// ============================================
app.get('/api/auth/claim', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(400).send('Token missing');

    const nowIso = new Date().toISOString();
    // Intentamos marcar used=true solo si usado=false y no expirado (operación atómica)
    const { data: updated, error: updateError } = await supabase
        .from('claims')
        .update({ used: true, used_at: new Date().toISOString() })
        .eq('token', token)
        .eq('used', false)
        .gt('expires_at', nowIso)
        .select('id,token,email,name,plan_id,subscription_id,customer_id,extra')
        .limit(1);

    if (updateError) {
        console.error('Supabase update error', updateError);
        return res.status(500).send('Error del servidor');
    }

    if (!updated || updated.length === 0) {
        return res.status(400).send('El enlace ya fue usado o expiró. Si necesitas ayuda, contacta soporte.');
    }

    const claimRow = updated[0];
    const state = token; // usamos token como state para el callback
    const clientId = encodeURIComponent(DISCORD_CLIENT_ID);
    const redirectUri = encodeURIComponent(DISCORD_REDIRECT_URL);
    const scope = encodeURIComponent('identify guilds.join');
    const prompt = 'consent';

    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${state}&prompt=${prompt}`;

    // Redirigimos al flujo de OAuth2 de Discord
    return res.redirect(discordAuthUrl);
});

// ============================================
// ENDPOINT: CALLBACK DE DISCORD OAUTH2
// Soporta BOTH: state puede ser token de claim (DB) o key guardada en pendingAuths (memoria)
// ============================================
app.get('/discord/callback', async (req, res) => {
    console.log('📬 GET /discord/callback');
    try {
        const { code, state } = req.query;
        if (!code || !state) {
            return res.status(400).send('❌ Faltan parámetros');
        }

        // Intentamos recuperar datos desde pendingAuths (frontend flow)
        let authData = pendingAuths.get(state);
        let claimData = null;

        if (!authData) {
            // Buscar en claims por token = state (email flow)
            const { data: claimsRows, error: claimErr } = await supabase
                .from('claims')
                .select('*')
                .eq('token', state)
                .limit(1);

            if (claimErr) {
                console.error('Error leyendo claim de Supabase:', claimErr);
            } else if (claimsRows && claimsRows.length > 0) {
                claimData = claimsRows[0];
                // Crear authData con info del claim para reutilizar el resto del flujo
                authData = {
                    email: claimData.email,
                    name: claimData.name,
                    plan_id: claimData.plan_id,
                    subscription_id: claimData.subscription_id,
                    customer_id: claimData.customer_id
                };
            }
        }

        if (!authData) {
            return res.status(400).send('❌ Sesión expirada o inválida');
        }

        console.log('📦 Datos para completar auth:', {
            email: authData.email,
            plan_id: authData.plan_id,
            subscription_id: authData.subscription_id
        });

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

        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const userData = await userResponse.json();
        const discordId = userData.id;
        const discordUsername = userData.username;

        console.log('👤 Usuario Discord:', discordUsername, '(' + discordId + ')');

        // Agregar al servidor (invite vía OAuth2)
        try {
            await fetch(`https://discord.com/api/guilds/${GUILD_ID}/members/${discordId}`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ access_token: tokenData.access_token })
            });
            console.log('✅ Usuario agregado al servidor');
        } catch (err) {
            console.log('ℹ️ Usuario ya está en el servidor o no pudo agregarse:', err?.message || err);
        }

        // Asignar rol según plan
        const roleId = getRoleIdForPlan(authData.plan_id);
        console.log('🎭 Asignando rol:', roleId, 'para plan:', authData.plan_id);
        try {
            const guild = await discordClient.guilds.fetch(GUILD_ID);
            const member = await guild.members.fetch(discordId);
            await member.roles.add(roleId);
            console.log('✅ Rol asignado correctamente');
        } catch (err) {
            console.error('❌ Error asignando rol:', err);
        }

        // Guardar o actualizar en Supabase (tabla memberships)
        try {
            const { error } = await supabase.from('memberships').insert({
                email: authData.email,
                name: authData.name,
                plan_id: authData.plan_id,
                subscription_id: authData.subscription_id,
                customer_id: authData.customer_id,
                discord_id: discordId,
                discord_username: discordUsername,
                status: 'active',
                created_at: new Date().toISOString()
            });
            if (error) {
                console.error('❌ Error guardando en Supabase memberships:', error);
            } else {
                console.log('✅ Guardado en Supabase memberships');
            }
        } catch (err) {
            console.error('❌ Error con Supabase (memberships):', err);
        }

        // Si venía de pendingAuths, limpiar
        pendingAuths.delete(state);

        // Redirigir a frontend o mostrar una página de éxito
        const successRedirect = FRONTEND_URL ? `${FRONTEND_URL}/gracias` : 'https://discord.gg/sXjU5ZVzXU';
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="UTF-8"><title>¡Bienvenido!</title></head>
            <body style="font-family:Arial,Helvetica,sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
                <div style="background:rgba(255,255,255,0.08);padding:32px;border-radius:12px;text-align:center;">
                    <h1>🎉 ¡Bienvenido!</h1>
                    <p>Tu rol ha sido asignado correctamente. Serás redirigido en unos segundos...</p>
                    <a href="${successRedirect}" style="display:inline-block;margin-top:12px;padding:12px 20px;border-radius:8px;background:#fff;color:#667eea;text-decoration:none;font-weight:bold;">Ir a Discord</a>
                </div>
                <script>setTimeout(()=>{ window.location.href='${successRedirect}' }, 3000);</script>
            </body>
            </html>
        `);

    } catch (error) {
        console.error('❌ Error en callback:', error);
        res.status(500).send('❌ Error procesando la autorización');
    }
});

// ============================================
// WEBHOOK DE BRAINTREE (mantener como tienes)
// ============================================
app.post('/api/braintree/webhook', express.raw({ type: 'application/x-www-form-urlencoded' }), async (req, res) => {
    console.log('📬 Webhook recibido de Braintree');
    try {
        const webhookNotification = await gateway.webhookNotification.parse(
            req.body.bt_signature,
            req.body.bt_payload
        );
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
// ============================================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
    console.log('🚀 NAZA Bot - servidor iniciado');
    console.log('🌐 Puerto:', PORT);
    console.log('🔗 URL:', BASE_URL);
});
