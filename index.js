const { Client, GatewayIntentBits } = require("discord.js");
require("dotenv").config();
const express = require("express");

// Crear el cliente del bot
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

// Cuando el bot esté listo
client.once("ready", () => {
  console.log(`✅ Bot conectado como ${client.user.tag});
});

// Iniciar sesión con el token
client.login(process.env.DISCORD_TOKEN);

// Servidor Express para mantener activo el bot en Render
const app = express();
app.get("/", (_, res) => res.send("OK"));
app.listen(process.env.PORT || 3000, () => {
  console.log("🌐 Servidor activo en Render");
});
