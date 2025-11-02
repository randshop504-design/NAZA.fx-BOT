const { Client, GatewayIntentBits } = require("discord.js");
require("dotenv").config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages]
});

client.once("ready", () => {
  console.log(✅ Bot conectado como ${client.user.tag});
});

client.login(process.env.DISCORD_TOKEN);
// Servidor Express para mantener vivo el bot
const express = require("express");
const app = express();

app.get("/", (_, res) => res.send("OK")); // Ruta principal para probar
app.listen(process.env.PORT || 3000, () => {
  console.log("🌐 Servidor activo en Render");
});
