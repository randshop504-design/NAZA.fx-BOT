// index.js
const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");
require("dotenv").config();

const TOKEN   = process.env.DISCORD_TOKEN;   // ya lo tienes
const GUILDID = process.env.GUILD_ID;        // ya lo tienes
const ROLEID  = process.env.ROLE_ID || "";   // si no lo tienes, lo buscaremos por nombre

// ---- Discord Bot ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

client.once("clientReady", () => {
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
});

// Comando simple para probar vida
client.on("messageCreate", async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  if (msg.content.trim().toLowerCase() === "!ping") {
    await msg.reply("🔔 Pong!");
  }
});

client.login(TOKEN);

// ---- Web Server (webhook) ----
const app = express();
app.use(express.json());

// health
app.get("/", (_req, res) => res.send("OK"));

// Whop → endpoint de compra
app.post("/after-payment", async (req, res) => {
  try {
    // adapta si tu payload cambia
    const event = req.body?.event || req.body?.type;
    const email = req.body?.email || req.body?.customer?.email;
    const discordId = req.body?.discord_id || req.body?.metadata?.discord_id;

    console.log("📦 Webhook recibido:", { event, email, discordId });

    // solo actuamos en pago aprobado / membership activa
    const okEvents = new Set(["payment_succeeded","invoice_paid","membership_activated"]);
    if (!okEvents.has(event)) {
      console.log("➡️ Evento ignorado:", event);
      return res.status(202).json({ status: "ignored", event });
    }

    if (!discordId) {
      console.log("⚠️ No vino discord_id.");
      return res.status(400).json({ error: "discord_id faltante" });
    }

    const guild = await client.guilds.fetch(GUILDID);
    // traer miembro (requiere SERVER MEMBERS INTENT activado)
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) {
      console.log("❌ No encontré al usuario en el servidor:", discordId);
      return res.status(404).json({ error: "member_not_found" });
    }

    // Obtener el rol
    let role = null;
    if (ROLEID) {
      role = guild.roles.cache.get(ROLEID) || await guild.roles.fetch(ROLEID).catch(()=>null);
    }
    if (!role) {
      // fallback por nombre exacto
      role = guild.roles.cache.find(r => r.name.toLowerCase() === "acceso mentoria");
    }
    if (!role) {
      console.log("❌ Rol 'acceso mentoria' no existe / no visible para el bot.");
      return res.status(500).json({ error: "role_not_found" });
    }

    // Asignar
    if (member.roles.cache.has(role.id)) {
      console.log(`✅ Usuario ya tenía el rol: ${member.id}`);
    } else {
      await member.roles.add(role.id, `Compra Whop de ${email || "sin_email"}`);
      console.log(`🏷️ Rol asignado a ${member.id}`);
    }

    return res.json({ ok: true, member: member.id, role: role.id });
  } catch (err) {
    console.error("💥 Error en /after-payment:", err);
    return res.status(500).json({ error: "internal" });
  }
});

// puerto Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Servidor activo en Render (puerto ${PORT})`);
});
