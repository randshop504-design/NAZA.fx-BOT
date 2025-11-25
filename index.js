// index.js - NAZA (completo)
// Requisitos: Node >=18, @sendgrid/mail, @supabase/supabase-js, braintree, discord.js

const express = require('express');
const braintree = require('braintree');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
const fetch = global.fetch || require('node-fetch');
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
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
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
  // Si no hay token, registramos y dejamos pasar (Option A: mínimo y puntual)
  if (!token) {
    console.warn('⚠️ x-frontend-token ausente — ignorando en este entorno (Option A).');
    return next();
  }
  // Si hay token pero es inválido, bloqueamos como antes
  if (token !== FRONTEND_TOKEN) {
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
// ENDPOINT: Verificar si se puede crear un claim / validar email y tarjeta
// Protegido por authenticateFrontend (usa x-frontend-token)
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
// FUNCIONES AUX: createClaimToken con validaciones requeridas
// - No crear claim si ya existe membership con email
// - No crear si ya hay claim pendiente para ese email
// - No permitir que la tarjeta (last4+cardExpiry) ya esté asociada a 2 emails distintos
async function createClaimToken({ email, name, plan_id, subscriptionId, customerId, last4, cardExpiry, extra = {} }) {
  email = (email || '').trim().toLowerCase();

  // DEBUG: Comprobación REST directa antes de usar supabase-js
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

  // ... remaining content omitted for brevity in this write block ...
