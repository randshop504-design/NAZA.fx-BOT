const express = require('express');
const braintree = require('braintree');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
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

const GMAIL_PASS = process.env.GMAIL_PASS;
const FROM_EMAIL = process.env.FROM_EMAIL;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL;

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

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
    console.log('✅ Discord bot conectado:', discordClient.user.tag);
});

// ============================================
// SUPABASE CLIENT
// ============================================
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ============================================
// NODEMAILER TRANSPORTER
// ============================================
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: SUPPORT_EMAIL,
        pass: GMAIL_PASS
    }
});

// ============================================
// ALMACENAMIENTO TEMPORAL PARA OAUTH2
// ============================================
const pendingAuths = new Map();

// ============================================
// MAPEO DE PLANES A ROLES
// ============================================
function getRoleIdForPlan(planId) {
    const mapping = {
        'plan_mensual': ROLE_ID_SENALESDISCORD,        // 1439096696301813830
        'plan_trimestral': ROLE_ID_MENTORIADISCORD,    // 1432149252016177233
        'plan_anual': ROLE_ID_ANUALDISCORD             // 1432149252016177233
    };
    return mapping[planId] || ROLE_ID_SENALESDISCORD;
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
// ENDPOINT: CONFIRMAR PAGO DESDE FRONTEND
// ============================================
app.post('/api/frontend/confirm', authenticateFrontend, async (req, res) => {
    console.log('📬 POST /api/frontend/confirm');

    try {
        const { nonce, email, name, plan_id } = req.body;

        console.log('📦 Datos recibidos:', { 
            nonce: nonce ? 'SÍ' : 'NO',
            email, 
            name, 
            plan_id 
        });

        if (!nonce || !email || !name || !plan_id) {
            return res.status(400).json({
                success: false,
                message: 'Faltan datos requeridos'
            });
        }

        // Crear cliente con método de pago
        const customerResult = await gateway.customer.create({
            email: email,
            paymentMethodNonce: nonce
        });

        if (!customerResult.success) {
            console.error('❌ Error creando cliente:', customerResult.message);
            return res.status(400).json({
                success: false,
                message: 'Error creando cliente: ' + customerResult.message
            });
        }

        const paymentMethodToken = customerResult.customer.paymentMethods[0].token;

        // Crear suscripción con paymentMethodToken
        const subscriptionResult = await gateway.subscription.create({
            paymentMethodToken: paymentMethodToken,
            planId: plan_id
        });

        if (!subscriptionResult.success) {
            console.error('❌ Error creando suscripción:', subscriptionResult.message);
            return res.status(400).json({
                success: false,
                message: 'Error creando suscripción: ' + subscriptionResult.message
            });
        }

        const subscriptionId = subscriptionResult.subscription.id;
        const customerId = subscriptionResult.subscription.transactions[0].customer.id;

        console.log('✅ Suscripción creada:', subscriptionId);
        console.log('👤 Customer ID:', customerId);

        // Generar state para OAuth2
        const state = crypto.randomBytes(16).toString('hex');

        // Guardar datos temporalmente
        pendingAuths.set(state, {
            email,
            name,
            plan_id,
            subscription_id: subscriptionId,
            customer_id: customerId,
            timestamp: Date.now()
        });

        // Limpiar después de 10 minutos
        setTimeout(() => {
            pendingAuths.delete(state);
        }, 10 * 60 * 1000);

        // Generar URL de OAuth2
        const oauthUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URL)}&response_type=code&scope=identify%20guilds.join&state=${state}`;

        console.log('🔗 OAuth URL generada');

        // Enviar email en paralelo (sin bloquear)
        sendWelcomeEmail(email, name, plan_id, subscriptionId).catch(err => {
            console.error('❌ Error al enviar email:', err);
        });

        // Retornar respuesta al frontend
        res.json({
            success: true,
            subscription_id: subscriptionId,
            customer_id: customerId,
            oauth_url: oauthUrl,
            message: 'Suscripción creada. Recibirás un email en los próximos minutos.'
        });

        console.log('✅ Respuesta enviada al frontend');

    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// ============================================
// ENDPOINT: CALLBACK DE DISCORD OAUTH2
// ============================================
app.get('/discord/callback', async (req, res) => {
    console.log('📬 GET /discord/callback');

    try {
        const { code, state } = req.query;

        if (!code || !state) {
            return res.status(400).send('❌ Faltan parámetros');
        }

        // Obtener datos guardados
        const authData = pendingAuths.get(state);

        if (!authData) {
            return res.status(400).send('❌ Sesión expirada o inválida');
        }

        console.log('📦 Datos recuperados:', {
            email: authData.email,
            plan_id: authData.plan_id,
            subscription_id: authData.subscription_id
        });

        // Intercambiar code por access_token
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                client_id: DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: DISCORD_REDIRECT_URL
            })
        });

        const tokenData = await tokenResponse.json();

        if (!tokenData.access_token) {
            console.error('❌ Error obteniendo token:', tokenData);
            return res.status(400).send('❌ Error de autorización');
        }

        console.log('✅ Token obtenido');

        // Obtener información del usuario
        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: {
                Authorization: `Bearer ${tokenData.access_token}`
            }
        });

        const userData = await userResponse.json();
        const discordId = userData.id;
        const discordUsername = userData.username;

        console.log('👤 Usuario Discord:', discordUsername, '(' + discordId + ')');

        // Agregar al servidor
        try {
            await fetch(`https://discord.com/api/guilds/${GUILD_ID}/members/${discordId}`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    access_token: tokenData.access_token
                })
            });
            console.log('✅ Usuario agregado al servidor');
        } catch (err) {
            console.log('ℹ️ Usuario ya está en el servidor');
        }

        // Asignar rol
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

        // Guardar en Supabase
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
                console.error('❌ Error guardando en Supabase:', error);
            } else {
                console.log('✅ Guardado en Supabase');
            }
        } catch (err) {
            console.error('❌ Error con Supabase:', err);
        }

        // Limpiar datos temporales
        pendingAuths.delete(state);

        // Redirigir al usuario
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>¡Bienvenido a NAZA Trading Academy!</title>
                <style>
                    body {
                        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                        color: white;
                    }
                    .container {
                        text-align: center;
                        background: rgba(255,255,255,0.1);
                        padding: 40px;
                        border-radius: 20px;
                        backdrop-filter: blur(10px);
                        box-shadow: 0 8px 32px rgba(0,0,0,0.3);
                    }
                    h1 { font-size: 48px; margin-bottom: 20px; }
                    p { font-size: 20px; margin-bottom: 30px; }
                    .button {
                        display: inline-block;
                        background: white;
                        color: #667eea;
                        padding: 15px 40px;
                        border-radius: 50px;
                        text-decoration: none;
                        font-weight: bold;
                        transition: transform 0.3s;
                    }
                    .button:hover {
                        transform: scale(1.05);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🎉 ¡Bienvenido!</h1>
                    <p>Tu rol ha sido asignado correctamente.</p>
                    <p>Revisa tu correo para más información.</p>
                    <a href="https://discord.gg/sXjU5ZVzXU" class="button">Ir a Discord</a>
                </div>
                <script>
                    setTimeout(() => {
                        window.location.href = 'https://discord.gg/sXjU5ZVzXU';
                    }, 3000);
                </script>
            </body>
            </html>
        `);

    } catch (error) {
        console.error('❌ Error en callback:', error);
        res.status(500).send('❌ Error procesando la autorización');
    }
});

// ============================================
// FUNCIÓN: ENVIAR EMAIL DE BIENVENIDA
// ============================================
async function sendWelcomeEmail(email, name, planId, subscriptionId) {
    console.log('📧 Enviando email de bienvenida...');

    const planNames = {
        'plan_anual': 'Plan Anual 🔥',
        'plan_trimestral': 'Plan Trimestral 📈',
        'plan_mensual': 'Plan Mensual 💼'
    };

    const planName = planNames[planId] || 'Plan';

    const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 0; }
                .container { max-width: 600px; margin: 20px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }
                .content { padding: 30px; }
                .button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; border-radius: 50px; text-decoration: none; margin-top: 20px; }
                .footer { background: #f4f4f4; padding: 20px; text-align: center; font-size: 12px; color: #666; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🎉 ¡Bienvenido a NAZA Trading Academy!</h1>
                </div>
                <div class="content">
                    <p>Hola <strong>${name}</strong>,</p>
                    <p>¡Gracias por unirte a nosotros! Tu suscripción al <strong>${planName}</strong> ha sido activada correctamente.</p>
                    <p><strong>📋 Detalles de tu suscripción:</strong></p>
                    <ul>
                        <li>Plan: ${planName}</li>
                        <li>ID de Suscripción: ${subscriptionId}</li>
                        <li>Email: ${email}</li>
                    </ul>
                    <p>Ya deberías tener acceso a Discord. Si no ves el servidor, usa este enlace:</p>
                    <a href="https://discord.gg/sXjU5ZVzXU" class="button">Unirse a Discord</a>
                    <p style="margin-top: 30px;">Si tienes alguna pregunta, no dudes en contactarnos.</p>
                </div>
                <div class="footer">
                    <p>© 2024 NAZA Trading Academy. Todos los derechos reservados.</p>
                    <p>Soporte: ${SUPPORT_EMAIL}</p>
                </div>
            </div>
        </body>
        </html>
    `;

    try {
        await transporter.sendMail({
            from: FROM_EMAIL,
            to: email,
            subject: `¡Bienvenido a NAZA Trading Academy! 🎉`,
            html: htmlContent
        });

        console.log('✅ Email enviado a:', email);
    } catch (error) {
        console.error('❌ Error enviando email:', error);
        throw error;
    }
}

// ============================================
// WEBHOOK DE BRAINTREE
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
    console.log('🚀 NAZA Bot v7.1 con creación correcta de cliente y suscripción');
    console.log('🌐 Puerto:', PORT);
    console.log('🔗 URL:', BASE_URL);
    console.log('✅ Listo para recibir pagos');
});
