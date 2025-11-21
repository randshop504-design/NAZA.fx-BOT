require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');
const braintree = require('braintree');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();
// Si estás detrás de un proxy (Render, Heroku, Cloudflare), habilítalo para req.ip correcto
app.set('trust proxy', true);

// middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 30 * 1000, // 30s
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// CORS
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-SHARED-SECRET', 'x-frontend-token']
};
app.use(cors(corsOptions));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const APP_NAME = process.env.APP_NAME || 'NAZA Trading Academy';

const SHARED_SECRET = process.env.SHARED_SECRET || 'NazaFx8upexSecretKey_2024_zzu12AA';
const JWT_SECRET = process.env.JWT_SECRET || 'alexi3i020wi$$$!';
const FRONTEND_TOKEN = (typeof process.env.FRONTEND_TOKEN === 'undefined') ? 'NAZA_TEST_123' : process.env.FRONTEND_TOKEN;
const WAIT_FOR_WEBHOOK = (process.env.WAIT_FOR_WEBHOOK || 'true').toLowerCase() === 'true';

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE) ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } }) : null;
if (!supabase) console.warn('⚠️ SUPABASE NOT CONFIGURED');

// SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');
const FROM_EMAIL = process.env.FROM_EMAIL || 'support@nazatradingacademy.com';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@nazatradingacademy.com';

// Braintree
const BT_ENV_RAW = (process.env.BRAINTREE_ENV || 'Sandbox').toLowerCase();
const BT_ENV = (BT_ENV_RAW === 'production' || BT_ENV_RAW === 'prod') ? braintree.Environment.Production : braintree.Environment.Sandbox;
const gateway = new braintree.BraintreeGateway({
  environment: BT_ENV,
  merchantId: process.env.BRAINTREE_MERCHANT_ID || '',
  publicKey: process.env.BRAINTREE_PUBLIC_KEY || '',
  privateKey: process.env.BRAINTREE_PRIVATE_KEY || ''
});

// Discord
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const GUILD_ID = process.env.GUILD_ID || '';
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL || `${BASE_URL}/discord/callback`;
const DISCORD_INVITE_URL = process.env.DISCORD_INVITE_URL || null;
const SUCCESS_URL = process.env.SUCCESS_URL || `${BASE_URL}/success`;

// Role IDs
const ROLE_ID_SENALES = process.env.ROLE_ID_SENALESDISCORD || null;
const ROLE_ID_MENTORIA = process.env.ROLE_ID_MENTORIADISCORD || null;
const ROLE_ID_ANUAL = process.env.ROLE_ID_ANUALDISCORD || ROLE_ID_MENTORIA || null;

// Helpers
function escapeHtml(s){ if(!s) return ''; return String(s).replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]); }

async function logEvent(event_id, event_type, data){
  try{ if (supabase) await supabase.from('webhook_logs').insert({ event_id, event_type, data, processed: false }); } catch(e){ console.log('logEvent err', e?.message || e); }
}

async function markWebhookProcessed(event_id){
  try{ if (supabase) await supabase.from('webhook_logs').update({ processed: true, processed_at: new Date().toISOString() }).eq('event_id', event_id); } catch(e){ console.log('markWebhookProcessed err', e?.message || e); }
}

async function upsertLink(membership_id, discord_id, discord_username, discord_email){
  if(!membership_id || !discord_id || !supabase) return;
  try{ await supabase.from('membership_links').upsert({ membership_id, discord_id, discord_username: discord_username || null, discord_email: discord_email || null, is_active: true, updated_at: new Date().toISOString() }, { onConflict: 'membership_id' }); } catch(e){ console.log('upsertLink err', e?.message || e); }
}

async function createClaimRecord(jti, membership_id, plan_id){
  if(!supabase) return;
  try{ await supabase.from('claims_issued').insert({ jti, membership_id, plan_id, expires_at: new Date(Date.now() + 24*60*60*1000).toISOString() }); } catch(e){ console.log('createClaimRecord err', e?.message || e); }
}

asyncGeneration cancelled
