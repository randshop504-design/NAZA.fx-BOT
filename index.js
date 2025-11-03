// ===== index.js — NAZA.fx BOT =====
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');

// ===== CONFIGURAR DISCORD BOT =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
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

// ===== SERVIDOR EXPRESS =====
const app = express();

// Acepta JSON desde Whop (cualquier tipo de content-type JSON)
app.use(express.json({ type: '*/*' }));
app.use(express.urlencoded({ extended: true }));

// Ruta principal para comprobar si Render está vivo
app.get('/', (_, res) => res.send('✅ NAZA.fx BOT activo'));

// ===== WEBHOOK DE WHOP =====
app.post('/webhook/whop', express.json(), (req, res) => {
  try {
    console.log('📩 Webhook recibido desde Whop:');
    console.log(req.body); // Muestra todo el contenido exacto que manda Whop

    const event = req.body?.event || req.body?.type || 'undefined';
    const email = req.body?.data?.email || req.body?.email || 'undefined';
    const discordId = req.body?.data?.discord_id || req.body?.discord_id || 'undefined';

    console.log(`🧾 Event: ${event}, Email: ${email}, Discord ID: ${discordId}`);

    if (event === 'payment_succeeded' || event === 'membership_activated') {
      console.log('✅ Evento válido recibido, procesando...');
      // Aquí después agregaremos el rol automático
    } else {
      console.log('⚠️ Evento ignorado:', event);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Error al procesar webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});

// ===== ARRANQUE DEL SERVIDOR =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Servidor activo en Render (puerto ${PORT})`));

// ===== LOGIN DEL BOT =====
client.login(process.env.DISCORD_TOKEN);
