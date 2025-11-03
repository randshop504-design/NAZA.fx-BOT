// index.js — NAZA.fx BOT (Discord.js v14 + Express)
require("dotenv").config();

const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
app.use(express.json()); // <-- importante para leer el JSON del webhook

// ==== Discord Client ====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // necesario para buscar/editar miembros
  ],
});

client.once("ready", () => {
  console.log("✅ Bot conectado como", client.user.tag);
});

// ==== Endpoint para Webhook de Whop ====
app.post("/after-payment", async (req, res) => {
  try {
    // Whop nos manda algo como { event: 'payment_succeeded', email, discord_id }
    const { event, discord_id } = req.body || {};

    if (event !== "payment_succeeded") {
      console.log("ℹ️ Evento ignorado:", event);
      return res.status(200).send({ ok: true, ignored: true });
    }

    if (!discord_id) {
      console.log("⚠️ No vino discord_id en el payload");
      return res.status(400).send({ ok: false, error: "missing_discord_id" });
    }

    const guildId = process.env.GUILD_ID;
    const roleId = process.env.ROLE_ID;

    const guild = await client.guilds.fetch(guildId);
    // Buscar miembro en el servidor
    const member = await guild.members.fetch(discord_id).catch(() => null);

    if (!member) {
      console.log("❌ Miembro no encontrado en el guild:", discord_id);
      return res.status(404).send({ ok: false, error: "member_not_found" });
    }

    // Asignar rol si no lo tiene
    if (!member.roles.cache.has(roleId)) {
      await member.roles.add(roleId, "Pago aprobado en Whop");
      console.log(`✅ Rol asignado a ${member.user.tag}`);
    } else {
      console.log(`ℹ️ ${member.user.tag} ya tenía el rol`);
    }

    return res.status(200).send({ ok: true });
  } catch (err) {
    console.error("💥 Error en /after-payment:", err);
    return res.status(500).send({ ok: false, error: "server_error" });
  }
});

// ==== Keep-alive + Arranque ====
app.get("/", (_, res) => res.send("OK"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Servidor activo en Render (puerto ${PORT})`));

client.login(process.env.DISCORD_TOKEN);
