// index.js — NAZA.fx BOT (Render)
// Requiere: discord.js v14, express, dotenv
require("dotenv").config();
const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");

// ===== Discord client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ]
});

client.once("ready", () => {
  console.log("💡 Bot conectado como", client.user.tag);
});

// ===== Utilidades =====
function extractDiscordId(payload) {
  let discordId = null;

  // V2: membership.custom_fields_responses_v2 = [{ label/question, answer }]
  const v2 = payload?.data?.membership?.custom_fields_responses_v2;
  if (Array.isArray(v2)) {
    const hit = v2.find(
      f => (String(f.label || f.question || "")).toLowerCase().includes("discord")
    );
    if (hit?.answer) discordId = String(hit.answer).trim();
  }

  // V1: membership.custom_fields_responses = { "Discord ID": "123..." }
  if (!discordId) {
    const v1 = payload?.data?.membership?.custom_fields_responses;
    if (v1 && typeof v1 === "object") {
      const key = Object.keys(v1).find(k => k.toLowerCase().includes("discord"));
      if (key) discordId = String(v1[key]).trim();
    }
  }

  // Fallbacks muy defensivos
  if (!discordId && payload?.discord_id) discordId = String(payload.discord_id).trim();
  if (!discordId && payload?.data?.discord_id) discordId = String(payload.data.discord_id).trim();

  // Validación simple (17–19 dígitos)
  if (discordId && !/^\d{17,19}$/.test(discordId)) {
    console.log("⚠️ Discord ID con formato no válido:", discordId);
    return null;
  }

  return discordId;
}

async function grantRole(discordId) {
  const guildId = process.env.GUILD_ID;
  const roleId = process.env.ROLE_ID;

  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) {
    console.log("⚠️ No encontré miembro con ese Discord ID en el servidor.");
    return { ok: false, reason: "member_not_found" };
  }

  // Asignar rol si no lo tiene
  if (!member.roles.cache.has(roleId)) {
    await member.roles.add(roleId);
    console.log("✅ Rol asignado a", member.user.tag);
  } else {
    console.log("ℹ️ El miembro ya tenía el rol.");
  }
  return { ok: true };
}

// ===== Servidor Express (webhooks + health) =====
const app = express();
app.use(express.json());

// Health y wake-up
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Endpoint webhook Whop (el que pusiste en Whop)
app.post("/webhook/whop", async (req, res) => {
  const payload = req.body || {};
  const event = payload?.action || payload?.event || "undefined";
  const email =
    payload?.data?.email ||
    payload?.data?.user?.email ||
    payload?.email ||
    "undefined";
  const discordId = extractDiscordId(payload);

  console.log("🪝 Webhook recibido ::", {
    event,
    email,
    discordId: discordId || null
  });

  // Solo actuamos en éxitos de pago o activaciones
  const isOkEvent =
    ["payment_succeeded", "membership_activated"].includes(String(event));

  if (!isOkEvent) {
    console.log("🚫 Evento ignorado:", event);
    return res.status(202).json({ status: "ignored" });
  }

  if (!discordId) {
    console.log("❌ Sin Discord ID. Enviaría email de fallback con formulario.");
    // Aquí podrías disparar tu correo con enlace /claim para capturar Discord ID
    return res.status(202).json({ status: "missing_discord_id" });
  }

  try {
    const result = await grantRole(discordId);
    if (result.ok) return res.json({ status: "role_granted" });
    return res.status(202).json({ status: result.reason || "no_action" });
  } catch (e) {
    console.error("🔥 Error asignando rol:", e);
    return res.status(500).json({ status: "error" });
  }
});

// Render asigna el puerto por env
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Servidor web activo en puerto ${PORT}`);
});

// Login del bot
client.login(process.env.DISCORD_TOKEN);
