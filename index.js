require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const express = require("express");

// === CONFIGURAR EXPRESS (para Render y Whop) ===
const app = express();
app.use(express.json());

// === SERVIDOR WEB ===
app.get("/", (req, res) => res.send("✅ NAZA.fx BOT corriendo correctamente"));
app.post("/after-payment", (req, res) => {
  console.log("✅ Webhook recibido desde Whop:", req.body);
  res.status(200).send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Servidor web activo en puerto ${PORT}`));

// === BOT DE DISCORD ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

client.once("ready", () => {
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
});

client.on("messageCreate", (msg) => {
  if (msg.content === "!ping") {
    msg.reply("🏓 Pong!");
  }
});

// === LOGIN DEL BOT ===
client.login(process.env.DISCORD_TOKEN);
