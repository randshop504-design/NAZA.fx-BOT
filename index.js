const { Client, GatewayIntentBits } = require("discord.js");
require("dotenv").config();
const express = require("express");
const app = express();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once("ready", () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);
});

// Responde "pong!" cuando alguien diga "!ping"
client.on("messageCreate", (message) => {
  if (message.author.bot) return;
  if (message.content.toLowerCase() === "!ping") {
    message.reply("🏓 Pong!");
  }
});

client.login(process.env.DISCORD_TOKEN);

// Mantener vivo el servidor en Render
app.get("/", (_, res) => res.send("Bot activo y funcionando"));
app.listen(process.env.PORT || 3000, () => {
  console.log("🌐 Servidor activo en Render");
});
