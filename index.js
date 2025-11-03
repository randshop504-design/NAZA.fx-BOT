// ===== index.js (PEGA TODO ESTO) =====
require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');

// ----- Discord bot -----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent // para leer mensajes (!ping)
  ]
});

client.once('ready', () => {
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
});

client.on('messageCreate', (msg) => {
  if (msg.author.bot) return;
  if (msg.content.trim().toLowerCase() === '!ping') {
    msg.reply('🏓 Pong!');
  }
});

client.login(process.env.DISCORD_TOKEN);

// ----- Servidor Express / Webhook -----
const app = express();

// Acepta JSON de Whop (cualquier content-type json)
app.use(express.json({ type: '*/*' }));
app.use(express.urlencoded({ extended: true }));

// Health
app.get('/', (_, res) => res.send('OK'));

// Webhook de Whop
app.post('/webhook/whop', (req, res) => {
  const b = req.body || {};

  // v2 usa "type"; v1 usa "event"
  const event = b.type || b.event || null;

  // posibles rutas de email (v1/v2)
  const email =
    b?.data?.user?.email ||
    b?.data?.customer?.email ||
    b?.data?.email ||
    b?.email ||
    null;

  // si algún día capturamos discord_id como custom field
  const discordId =
    b?.data?.custom_fields?.discord_id ||
    b?.data?.custom_fields?.discordId ||
    b?.custom_fields?.discord_id ||
    b?.discord_id ||
    null;

  console.log('📬 Webhook recibido =>', { event, email, discordId });

  if (event === 'payment_succeeded' || event === 'membership_activated') {
    return res.status(200).json({ status: 'ok' });
  }

  return res.status(202).json({ status: 'ignored' });
});

// Arranque
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Servidor activo en puerto ${PORT}`));
