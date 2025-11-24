// index.js - NAZA (completo)
// Requisitos: Node >=18, @sendgrid/mail, @supabase/supabase-js, braintree, discord.js
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
// CONFIGURACIÓN (variables de entorno)
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
// BRAINTREE GATEWAY
const gateway = new braintree.BraintreeGateway({
    environment: BRAINTREE_ENV === 'Production' ? braintree.Environment.Production : braintree.Environment.Sandbox,
    merchantId: BRAINTREE_MERCHANT_ID,
    publicKey: BRAINTREE_PUBLIC_KEY,
    privateKey: BRAINTREE_PRIVATE_KEY
});

// ============================================
// DISCORD CLIENT
const discordClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});
discordClient.login(DISCORD_BOT_TOKEN);
discordClient.once('ready', () => {
    console.log('✅ Discord bot conectado:', discordClient.user?.tag || '(sin tag aún)');
});

// ============================================
// SUPABASE CLIENT
// Añado headers globales para asegurar que use la service_role key en las llamadas
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
// MAPEO DE PLANES A ROLES
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
// MIDDLEWARE DE AUTENTICACIÓN
function authenticateFrontend(req, res, next) {
    const token = req.headers['x-frontend-token'];
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
// FUNCIONES AUX: createClaimToken con validaciones requeridas
// - No crear claim si ya existe membership con email
// - No crear si ya hay claim pendiente para ese email
// - No permitir que la tarjeta (last4+cardExpiry) ya esté asociada a 2 emails distintos
async function createClaimToken({ email, name, plan_id, subscriptionId, customerId, last4, cardExpiry, extra = {} }) {
    email = (email || '').trim().toLowerCase();

    // DEBUG: Comprobación REST directa antes de usar supabase-js
    // (imprime status y body para diagnosticar PGRST205)
    try {
        console.log('DEBUG: probando REST direct a /rest/v1/memberships');
        const restResp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/memberships?select=*&limit=1`, {
            headers: {
                apikey: SUPABASE_SERVICE_ROLE,
                Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
                Accept: 'application/json'
            }
        });
        console.log('DEBUG rest status:', restResp.status);
        const restText = await restResp.text();
        console.log('DEBUG rest body:', restText.substring(0, 2000)); // recorta por seguridad
    } catch (dbgErr) {
        console.error('DEBUG rest fetch error:', dbgErr);
    }

    // 1) Verificar si ya existe una membresía (memberships) con ese email
    try {
        const { data: existingMembership, error: memErr } = await supabase
            .from('memberships')
            .select('id')
            .eq('email', email)
            .limit(1);

        if (memErr) {
            console.error('Error consultando memberships:', memErr);
            // Mostrar info adicional si PGRST205
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
            .select('id,used')
            .eq('email', email)
            .limit(1);

        if (claimErr) {
            console.error('Error consultando claims por email:', claimErr);
            throw new Error('Error interno');
        }
        if (existingClaimsForEmail && existingClaimsForEmail.length > 0) {
            // Si ya hay un claim (sea usado o no), prevenir duplicado por email
            throw new Error('Existe ya una solicitud para este correo. Revisa tu email.');
        }
    } catch (err) {
        throw err;
    }

    // 3) Verificar uso de la tarjeta (no permitir >2 correos distintos)
    try {
        const { data: cardRows, error: cardErr } = await supabase
            .from('claims')
            .select('email')
            .eq('last4', last4 || '')
            .eq('card_expiry', cardExpiry || '');

        if (cardErr) {
            console.error('Error consultando claims por tarjeta:', cardErr);
            throw new Error('Error interno');
        }
        const distinctEmails = new Set((cardRows || []).map(r => (r.email || '').toLowerCase()));
        // Si ya hay 2 o más emails distintos usando esa tarjeta --> bloquear
        if (distinctEmails.size >= 2 && !distinctEmails.has(email)) {
            throw new Error('Esta tarjeta ya está asociada a dos cuentas distintas. Contacta soporte.');
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
// EMAIL: Templates y envíos (SendGrid)
function buildWelcomeEmailHtml({ name, planName, subscriptionId, claimUrl, email, supportEmail }) {
    return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><style>body{font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:0}.wrap{max-width:600px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 6px 18px rgba(0,0,0,0.08)}.header{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:28px;text-align:center}.content{padding:24px;color:#111}.btn{display:inline-block;background:#2d9bf0;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600}.footer{padding:16px;text-align:center;color:#888;font-size:13px;background:#fafafa}.muted{color:#666;font-size:14px}</style></head><body><div class="wrap"><div class="header"><h1>🎉 ¡Bienvenido a NAZA Trading Academy!</h1></div><div class="content"><p>Hola <strong>${escapeHtml(name || 'usuario')}</strong>,</p><p>Tu suscripción <strong>${escapeHtml(planName)}</strong> ha sido activada correctamente.</p><p><strong>Detalles:</strong></p><ul><li>Plan: ${escapeHtml(planName)}</li><li>ID de suscripción: ${escapeHtml(subscriptionId)}</li><li>Email: ${escapeHtml(emailSafe(email))}</li></ul><p style="margin-top:16px">Para completar tu acceso a Discord y asociar tu cuenta, pulsa el siguiente botón:</p><p style="text-align:center;margin:20px 0"><a href="${claimUrl}" class="btn">Obtener acceso</a></p><p class="muted">El enlace funciona hasta que completes el registro en Discord. Si ya iniciaste sesión por OAuth2, no es necesario volver a usarlo.</p></div><div class="footer"><div>© ${new Date().getFullYear()} NAZA Trading Academy</div><div style="margin-top:6px">Soporte: ${escapeHtml(supportEmail || FROM_EMAIL)}</div></div></div></body></html>`;
}
function buildWelcomeText({ name, planName, subscriptionId, claimUrl, supportEmail, email }) {
    return `Hola ${name || 'usuario'},\n\nTu suscripción "${planName}" ha sido activada.\nID de suscripción: ${subscriptionId}\nEmail: ${email || ''}\n\nPara completar el acceso a Discord y asociar tu cuenta, visita:\n${claimUrl}\n\nNota: El enlace funciona hasta que completes el registro.\n\nSoporte: ${supportEmail || FROM_EMAIL}\n`;
}

async function sendWelcomeEmail(email, name, planId, subscriptionId, customerId, extra = {}) {
    console.log('📧 Enviando email de bienvenida (SendGrid)...');
    const planNames = { 'plan_anual': 'Plan Anual 🔥', 'plan_trimestral': 'Plan Trimestral 📈', 'plan_mensual': 'Plan Mensual 💼' };
    const planName = planNames[planId] || 'Plan';

    if (!SENDGRID_API_KEY) {
        console.error('❌ No hay SENDGRID_API_KEY configurada. Abortando envío de correo.');
        throw new Error('SENDGRID_API_KEY no configurada');
    }

    const last4 = extra.last4 || '';
    const cardExpiry = extra.cardExpiry || '';

    const token = await createClaimToken({
        email,
        name,
        plan_id: planId,
        subscriptionId,
        customerId,
        last4,
        cardExpiry,
        extra
    });

    const claimUrl = `${BOT_URL.replace(/\/$/, '')}/api/auth/claim?token=${token}`;
    const html = buildWelcomeEmailHtml({ name, planName, subscriptionId, claimUrl, email, supportEmail: SUPPORT_EMAIL });
    const text = buildWelcomeText({ name, planName, subscriptionId, claimUrl, supportEmail: SUPPORT_EMAIL, email });

    const msg = { to: email, from: FROM_EMAIL, subject: `¡Bienvenido a NAZA Trading Academy! — Obtener acceso`, text, html };
    try {
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
// ENDPOINT: CONFIRMAR PAGO DESDE FRONTEND (mantenido)
// Extraemos last4 y expirationDate y los pasamos a sendWelcomeEmail
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
        const cardExpiry = paymentMethod.expirationDate || ''; // formato MM/YYYY o MM/YY

        const subscriptionResult = await gateway.subscription.create({ paymentMethodToken: paymentMethodToken, planId: plan_id });
        if (!subscriptionResult.success) {
            console.error('❌ Error creando suscripción:', subscriptionResult.message);
            return res.status(400).json({ success: false, message: 'Error creando suscripción: ' + subscriptionResult.message });
        }

        const subscriptionId = subscriptionResult.subscription.id;
        const customerId = customerResult.customer.id || null;
        console.log('✅ Suscripción creada:', subscriptionId, 'Customer ID:', customerId);

        // FRONTEND FLOW: generar state y guardar en memoria
        const state = crypto.randomBytes(16).toString('hex');
        pendingAuths.set(state, {
            email,
            name,
            plan_id,
            subscription_id: subscriptionId,
            customer_id: customerId,
            timestamp: Date.now()
        });
        setTimeout(()=> pendingAuths.delete(state), 10 * 60 * 1000);

        const oauthUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URL)}&response_type=code&scope=identify%20guilds.join&state=${state}`;

        // Enviar email con claim (email flow) en paralelo y pasar last4/cardExpiry
        sendWelcomeEmail(email, name, plan_id, subscriptionId, customerId, { last4, cardExpiry, source: 'frontend_confirm' })
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

        // Agregar al servidor (invite via OAuth2)
        try {
            await fetch(`https://discord.com/api/guilds/${GUILD_ID}/members/${discordId}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
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

        // Si venía de pendingAuths, limpiamos
        pendingAuths.delete(state);

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
});
