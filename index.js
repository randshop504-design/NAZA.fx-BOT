// index.js
// NAZA.fx BOT — Render server (Node 18+)
// Instala dependencias: npm i express dotenv

const express = require("express");
const crypto = require("crypto");
const dotenv = require("dotenv");

dotenv.config();
const app = express();

// ====== Config ======
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const ACCESS_CONTINUE_URL =
  process.env.ACCESS_CONTINUE_URL || "https://discord.com/app";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const DISCORD_ROLE_ID_PRO = process.env.DISCORD_ROLE_ID_PRO;

const WHOP_WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET;

// ====== Idempotencia simple (en memoria; en prod usa Redis/DB) ======
const seenEvents = new Set();

// ====== Parsers ======
// Guardar raw body SOLO para /webhooks/whop (necesario para verificar firma)
function rawBodySaver(req, res, buf) {
  if (buf && buf.length) req.rawBody = buf;
}
app.use((req, res, next) => {
  if (req.path === "/webhooks/whop") {
    express.json({ verify: rawBodySaver })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

// ====== Salud ======
app.get("/health", (_req, res) =>
  res.status(200).json({ ok: true, ts: new Date().toISOString() })
);

// ====== Página pospago (oscuro NAZA/FDX) ======
app.get("/redirect", (_req, res) => {
  const html = `
<!doctype html><html lang="es"><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Aviso • NAZA Trading Academy</title>
<style>
  :root{--bg:#0b0d10;--card:#0f1217;--border:#1b212a;--text:#e6e9ef;--muted:#98a1b3;--pill:#2a3240;--pillOn:#3b4557;--btn:#2b6cff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,Arial,sans-serif}
  .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{width:100%;max-width:720px;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px}
  h2{margin:0 0 10px;font-weight:700;letter-spacing:.2px}
  p{margin:0 0 10px;line-height:1.55}
  .pill{display:inline-block;border:1px solid var(--pill);border-radius:999px;padding:10px 18px;background:var(--bg);color:var(--text);cursor:pointer;transition:all .15s ease}
  .btn{padding:12px 18px;border:0;border-radius:10px;background:var(--btn);color:#fff;font-weight:600}
  .btn[disabled]{opacity:.45;cursor:not-allowed;box-shadow:none}
  .hint{margin-top:10px;color:var(--muted);font-size:14px}
</style>
<div class="wrap"><div class="card">
  <h2>Aviso antes de continuar</h2>
  <p><strong>Compra exitosa.</strong> Enviamos un correo con tus accesos. Revisa también <strong>Spam</strong> o <strong>Promociones</strong>.</p>
  <p><strong>NAZA Trading Academy</strong> tiene carácter <strong>únicamente educativo</strong>, no garantiza resultados ni brinda asesoría financiera. Cada decisión y resultado derivado del uso del contenido es responsabilidad del usuario.</p>

  <button id="accept-pill" class="pill">/Acepto/</button>

  <div style="margin-top:16px">
    <button id="continue-btn" class="btn" type="button" disabled>Obtener acceso ahora</button>
  </div>

  <p class="hint">También puedes continuar desde el correo (busca “NAZA Trading Academy” o “Whop”).</p>
</div></div>

<script>
(function(){
  const accept = document.getElementById('accept-pill');
  const go = document.getElementById('continue-btn');

  accept.addEventListener('click', function () {
    const accepted = accept.getAttribute('aria-pressed') === 'true' ? false : true;
    accept.setAttribute('aria-pressed', accepted);
    accept.style.background = accepted ? '#10151c' : '#0b0d10';
    accept.style.borderColor = accepted ? '#3b4557' : '#2a3240';
    accept.style.transform = accepted ? 'translateY(-1px)' : 'translateY(0)';
    go.disabled = !accepted;
    go.style.opacity = accepted ? '1' : '.45';
    go.style.cursor = accepted ? 'pointer' : 'not-allowed';
    go.style.boxShadow = accepted ? '0 6px 16px rgba(43,108,255,.35)' : 'none';
  });

  go.addEventListener('click', function () {
    if (go.disabled) return;
    window.location.href = ${JSON.stringify(ACCESS_CONTINUE_URL)};
  });
})();
</script>`;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.status(200).send(html);
});

// ====== Webhook Whop (firma + eventos + rol) ======
app.post("/webhooks/whop", async (req, res) => {
  try {
    // 1) Verificar firma HMAC
    if (!WHOP_WEBHOOK_SECRET) {
      console.error("WHOP_WEBHOOK_SECRET faltante");
      return res.status(500).send("secret missing");
    }
    const raw = req.rawBody?.toString("utf8") || "";
    const signatureHeader =
      req.get("Whop-Signature") ||
      req.get("X-Whop-Signature") ||
      req.get("Whop-Webhook-Signature");
    if (!signatureHeader) {
      console.warn("Firma Whop ausente");
      return res.status(400).send("missing signature");
    }
    const expected = crypto
      .createHmac("sha256", WHOP_WEBHOOK_SECRET)
      .update(raw)
      .digest("hex");
    if (!timingSafeEqual(expected, signatureHeader)) {
      console.warn("Firma inválida");
      return res.status(400).send("invalid signature");
    }

    // 2) Idempotencia
    const eventId =
      req.get("Whop-Event-Id") ||
      req.body?.id ||
      req.body?.event_id ||
      `no-id-${Date.now()}`;
    if (seenEvents.has(eventId)) {
      return res.status(200).json({ ok: true, dedup: true });
    }
    seenEvents.add(eventId);

    // 3) Parse evento
    const type = req.body?.type || req.body?.event || "unknown";
    const data = req.body?.data || req.body?.payload || req.body;
    const custom = data?.custom_fields || data?.customFields || {};
    const discordIdRaw =
      custom.discord_id ??
      custom.DISCORD_ID ??
      custom.discordId ??
      data?.discord_id ??
      null;
    const discordId = normalizeDiscordId(discordIdRaw);

    // 4) Acciones por evento
    const assignEvents = new Set([
      "purchase.created",
      "subscription.activated",
      "subscription.trial_started",
    ]);
    const revokeEvents = new Set([
      "subscription.canceled",
      "license.revoked",
      "order.refunded",
      "subscription.expired",
    ]);

    if (assignEvents.has(type)) {
      if (!discordId) {
        console.warn("assign: discord_id faltante", { type });
      } else {
        await discordAddRole(DISCORD_GUILD_ID, discordId, DISCORD_ROLE_ID_PRO);
        console.log("ASSIGN_OK", { type, discordId });
      }
    } else if (revokeEvents.has(type)) {
      if (!discordId) {
        console.warn("revoke: discord_id faltante", { type });
      } else {
        await discordRemoveRole(DISCORD_GUILD_ID, discordId, DISCORD_ROLE_ID_PRO);
        console.log("REVOKE_OK", { type, discordId });
      }
    } else {
      console.log("EVENT_IGNORED", { type });
    }

    // 5) Respuesta rápida
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("WHOP_WEBHOOK_ERROR", err);
    // Opcional: devolver 200 para que Whop no reintente agresivo
    return res.status(200).json({ ok: false, error: "internal" });
  }
});

// ====== Utils ======
function timingSafeEqual(a, b) {
  try {
    const aBuf = Buffer.from(a, "utf8");
    const bBuf = Buffer.from(b, "utf8");
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

function normalizeDiscordId(x) {
  if (!x) return null;
  const s = String(x).trim();
  const id = s.replace(/\D/g, "");
  // Discord snowflake: 17–19 dígitos
  if (id.length < 17 || id.length > 19) return null;
  return id;
}

// ====== Discord (REST v10) ======
// Node 18+ tiene fetch global
async function discordAddRole(guildId, userId, roleId) {
  if (!DISCORD_BOT_TOKEN || !guildId || !userId || !roleId) {
    throw new Error("DISCORD_ENV_MISSING");
  }
  const url = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(\`ADD_ROLE_FAIL \${res.status}: \${body}\`);
  }
}

async function discordRemoveRole(guildId, userId, roleId) {
  if (!DISCORD_BOT_TOKEN || !guildId || !userId || !roleId) {
    throw new Error("DISCORD_ENV_MISSING");
  }
  const url = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
  });
  if (!res.ok) {
    const body = await safeText(res);
    if (res.status === 404) { // ya no está el rol o miembro
      console.warn("REMOVE_ROLE_404", body);
      return;
    }
    throw new Error(\`REMOVE_ROLE_FAIL \${res.status}: \${body}\`);
  }
}

async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}

// ====== Start ======
app.listen(PORT, () => {
  console.log(\`NAZA.fx BOT running on \${BASE_URL} (port \${PORT})\`);
  console.log(\`Redirect page: \${BASE_URL}/redirect\`);
  console.log(\`Webhook path:  \${BASE_URL}/webhooks/whop\`);
});
