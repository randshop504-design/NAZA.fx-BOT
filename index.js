// NAZA.fx BOT — INDEX DEFINITIVO (Node 18+)
// Whop ↔ Render ↔ Discord + Supabase + Gmail + Claim 1-uso + Debug
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

// Polyfill seguro de fetch (Node 18+ ya trae fetch)
const fetch = global.fetch || ((...a) => import('node-fetch').then(({default:f})=>f(...a)));

const app = express();

/* ========= ENV ========= */
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_BASE_URL || `http://localhost:${PORT}`;

const APP_NAME = process.env.APP_NAME || 'NAZA Trading Academy';

const DISCORD_BOT_TOKEN     = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URL  = process.env.DISCORD_REDIRECT_URL || `${BASE_URL}/discord/callback`;
const GUILD_ID = process.env.GUILD_ID || process.env.DISCORD_GUILD_ID;
const ROLE_ID  = process.env.ROLE_ID  || process.env.DISCORD_ROLE_ID_PRO;

const WHOP_SIGNING_SECRET = process.env.WHOP_SIGNING_SECRET || process.env.WHOP_WEBHOOK_SECRET; // usa uno (ws_...)
const JWT_SECRET = process.env.JWT_SECRET || 'change-me'; // cámbialo en producción

const SUCCESS_URL = process.env.SUCCESS_URL || `${BASE_URL}/redirect`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession:false } });

const {
  GMAIL_USER, GMAIL_PASS, FROM_EMAIL,
  DISCORD_DOWNLOAD_URL = 'https://discord
