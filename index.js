const { Client, GatewayIntentBits } = require("discord.js");
require("dotenv").config();
const express = require("express");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ],
});

client.once("ready", () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);
});

// Iniciar sesión en Discord
client.login(process.env.DISCORD_TOKEN);

// Servidor Express para mantener vivo el bot
const app = express();

app.get("/", (req, res) => {
  res.send("OK");
});


app.listen(process.env.PORT || 3000, () => {
  console.log("🌐 Servidor activo en Render");
});
