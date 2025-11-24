const express = require('express');
const braintree = require('braintree');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
const fetch = require('node-fetch'); // Asegúrate de tener node-fetch instalado para llamadas fetch en Node.js

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
// ALMACENAMIENTO TEMPORAL PARA OAUTH2
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
// FUNCIONES AUXILIARES PARA CLAIM TOKEN
// ============================================
async function createClaimToken({ email, subscriptionId, plan, ttlHours = 24 }) {
    const token = crypto.randomBytes(24).toString('hex'); // 48 chars
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();

    const { data, error } = await supabase
        .from('claims')
        .insert([{
            token,
            email,
            subscription_id: subscriptionId,
            plan,
            expires_at: expiresAt
        }]);

    if (error) {
        console.error('Error al crear claim token:', error);
        throw error;
    }
    return token;
}

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

function buildWelcomeText({ name, planName, subscriptionId, claimUrl, supportEmail }) {
    return `Hola ${name || 'usuario'},

Tu suscripción "${planName}" ha sido activada.
ID de suscripción: ${subscriptionId}
Email: ${emailSafe(email)}

Para completar el acceso a Discord y asociar tu cuenta, visita:
${claimUrl}

Nota: El enlace expira y solo puede usarse una vez.

Soporte: ${supportEmail || FROM_EMAIL}
`;
}

async function sendWelcomeEmail(email, name, planId, subscriptionId) {
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

    const token = await createClaimToken({ email, subscriptionId, plan: planName, ttlHours: 24 });
    const claimUrl = `${BOT_URL.replace(/\/$/, '')}/api/auth/claim?token=${token}`;

    const html = buildWelcomeEmailHtml({ name, planName, subscriptionId, claimUrl, email, supportEmail: SUPPORT_EMAIL });
    const text = buildWelcomeText({ name, planName, subscriptionId, claimUrl, supportEmail: SUPPORT_EMAIL });

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
        throw error;
    }
}

// ============================================
// ENDPOINT: CLAIM TOKEN PARA OAUTH2
// ============================================
app.get('/api/auth/claim', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(400).send('Token missing');

    const nowIso = new Date().toISOString();
    const { data: updated, error: updateError } = await supabase
        .from('claims')
        .update({ used: true })
        .eq('token', token)
        .eq('used', false)
        .gt('expires_at', nowIso)
        .select('id,email,subscription_id,plan')
        .limit(1);

    if (updateError) {
        console.error('Supabase update error', updateError);
        return res.status(500).send('Error del servidor');
    }

    if (!updated || updated.length === 0) {
        return res.status(400).send('El enlace ya fue usado o expiró. Si necesitas ayuda, contacta soporte.');
    }

    const claimRow = updated[0];
    const state = token;
    const clientId = encodeURIComponent(DISCORD_CLIENT_ID);
    const redirectUri = encodeURIComponent(DISCORD_REDIRECT_URL);
    const scope = encodeURIComponent('identify guilds.join');
    const prompt = 'consent';

    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${state}&prompt=${prompt}`;

    return res.redirect(discordAuthUrl);
});

// ============================================
// Resto de tu código (endpoints, webhook, etc.) permanece igual
// ============================================

// ... Aquí va el resto de tu código existente, incluyendo /api/frontend/confirm, /discord/callback, webhook, etc.

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
    console.log('🚀 NAZA Bot v7.1 con creación correcta de cliente y suscripción');
    console.log('🌐 Puerto:', PORT);
    console.log('🔗 URL:', BASE_URL);
    console.log('✅ Listo para recibir pagos');
});
