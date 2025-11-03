// index.js — NAZA.fx BOT (Render)
// Requiere: discord.js v14, express, dotenv, node-fetch, body-parser, jsonwebtoken
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const jwt = require('jsonwebtoken');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

// ===== Discord client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.GuildMember]
});

client.once('ready', () => {
  console.log('✅ Bot conectado como', client.user.tag);
});

// ============ Utilidades ============

// Intenta extraer el Discord ID desde diferentes estructuras de Whop
function extractDiscordId(payload) {
  let discordId = null;

  const v2 = payload?.data?.membership?.custom_fields_responses_v2;
  if (Array.isArray(v2)) {
    const hit = v2.find(f =>
      (String(f.label ?? f.question ?? '')).toLowerCase().includes('discord')
    );
    if (hit && hit.answer) discordId = String(hit.answer).trim();
  }

  if (!discordId) {
    const v1 = payload?.data?.custom_fields_responses;
    if (v1 && typeof v1 === 'object') {
      for (const [k, v] of Object.entries(v1)) {
        if (String(k).toLowerCase().includes('discord') && v) {
          discordId = String(v).trim();
          break;
        }
      }
    }
  }

  if (!discordId && payload?.data?.discord_id) {
    discordId = String(payload.data.discord_id).trim();
  }

  if (discordId) {
    const onlyDigits = discordId.replace(/\D/g, '');
    if (onlyDigits.length >= 17 && onlyDigits.length <= 21) {
      return onlyDigits;
    }
  }
  return null;
}

// Asigna rol por ID si el usuario YA está en el servidor
async function addRoleIfMember(guildId, roleId, userId) {
  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      console.log('⚠️ Usuario no está en el servidor. No se pudo asignar rol. userId=', userId);
      return { ok: false, reason: 'not_in_guild' };
    }
    await member.roles.add(roleId);
    console.log('✅ Rol asignado a', userId);
    return { ok: true };
  } catch (e) {
    console.error('❌ Error asignando rol:', e?.message || e);
    return { ok: false, reason: 'error' };
  }
}

// Une al guild usando el access_token del usuario (OAuth2) y asigna rol
async function joinGuildAndRoleWithAccessToken(guildId, roleId, userId, accessToken, botToken) {
  try {
    const putRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bot ${botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ access_token: accessToken })
    });

    if (![200, 201, 204].includes(putRes.status)) {
      const txt = await putRes.text().catch(() => '');
      console.log('⚠️ No se pudo unir al guild. status=', putRes.status, txt);
    }

    const patchRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bot ${botToken}` }
    });

    if (![204].includes(patchRes.status)) {
      const txt = await patchRes.text().catch(() => '');
      console.log('⚠️ No se pudo asignar rol tras join. status=', patchRes.status, txt);
      return false;
    }

    console.log('✅ Usuario unido/asignado rol vía OAuth2:', userId);
    return true;
  } catch (e) {
    console.error('❌ Error en joinGuildAndRoleWithAccessToken:', e?.message || e);
    return false;
  }
}

// ============ Servidor Express ============
const app = express();
app.use(bodyParser.json({ type: '*/*' }));

// Ping básico
app.get('/', (_req, res) => {
  res.status(200).send('NAZA.fx BOT up ✔');
});

// ======= Webhook de Whop =======
app.post('/webhook/whop', async (req, res) => {
  try {
    const body = req.body || {};
    const action = body?.action || body?.event;
    const email = body?.data?.email || body?.data?.user?.email || null;
    const discordId = extractDiscordId(body);

    console.log('📦 Webhook Whop:', { action, email, discordId });

    const okEvents = new Set([
      'payment_succeeded',
      'membership_activated',
      'membership_went_valid'
    ]);

    if (!okEvents.has(action)) {
      console.log('ℹ️ Evento ignorado:', action);
      return res.status(202).json({ status: 'ignored' });
    }

    if (discordId) {
      const r = await addRoleIfMember(process.env.GUILD_ID, process.env.ROLE_ID, discordId);
      if (r.ok) return res.json({ status: 'role_assigned', via: 'discord_id' });

      console.log('👉 Usuario no en guild. Redirigir a /discord/login.');
      return res.json({ status: 'need_oauth_join', reason: r.reason });
    }

    return res.json({ status: 'no_discord_id', next: '/discord/login' });
  } catch (e) {
    console.error('❌ Error en /webhook/whop:', e?.message || e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ======= OAuth2: iniciar login =======
app.get('/discord/login', (req, res) => {
  try {
    const state = jwt.sign({ ts: Date.now() }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
      response_type: 'code',
      scope: 'identify guilds.join',
      state
    });
    const url = `https://discord.com/api/oauth2/authorize?${params.toString()}`;
    return res.redirect(url);
  } catch (e) {
    console.error('❌ Error en /discord/login:', e?.message || e);
    return res.status(500).send('OAuth error');
  }
});

// ======= OAuth2: callback =======
app.get('/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Falta "code"');
    jwt.verify(state, process.env.JWT_SECRET);

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI
      })
    });

    if (!tokenRes.ok) {
      const txt = await tokenRes.text().catch(() => '');
      console.log('⚠️ token exchange failed:', tokenRes.status, txt);
      return res.status(400).send('⚠️ Error al obtener tokens de Discord.');
    }

    const tokens = await tokenRes.json();
    const accessToken = tokens.access_token;

    const meRes = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!meRes.ok) {
      const txt = await meRes.text().catch(() => '');
      console.log('⚠️ users/@me failed:', meRes.status, txt);
      return res.status(400).send('⚠️ Error al leer tu usuario de Discord.');
    }

    const me = await meRes.json();
    const ok = await joinGuildAndRoleWithAccessToken(
      process.env.GUILD_ID,
      process.env.ROLE_ID,
      me.id,
      accessToken,
      process.env.DISCORD_BOT_TOKEN
    );

    if (ok) {
      return res.status(200).send('✅ Acceso concedido. Revisa Discord.');
    } else {
      return res.status(200).send('⚠️ Te autorizamos, pero no pudimos asignar el rol automáticamente. Contacta soporte con tu ID: ' + me.id);
    }
  } catch (e) {
    console.error('❌ Error en /discord/callback:', e?.message || e);
    return res.status(500).send('⚠️ Error al obtener tokens de Discord.');
  }
});

// ====== Arranque del server ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🟢 Servidor web activo en puerto ${PORT}`);
});

// ====== Login del bot ======
client.login(process.env.DISCORD_BOT_TOKEN);
