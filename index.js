// index.js — NAZA.fx BOT (Node 18+)
// Tu flujo original + Gmail (auto y reenvío)
const express = require("express");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const dotenv = require("dotenv");
dotenv.config();

const app = express();

// ====== ENV / CONFIG ======
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_BASE_URL || `http://localhost:${PORT}`;

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.GUILD_ID || process.env.DISCORD_GUILD_ID;
const DISCORD_ROLE_ID = process.env.ROLE_ID || process.env.DISCORD_ROLE_ID_PRO;

// OAuth2 (importante que coincida con Discord Dev Portal)
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URL = process.env.DISCORD_REDIRECT_URL || `${BASE_URL}/discord/callback`;

// Whop webhook secret (admite 2 nombres)
const WHOP_WEBHOOK_SECRET = process.env.WHOP_SIGNING_SECRET || process.env.WHOP_WEBHOOK_SECRET;

// Opcional: URL de éxito final (donde aterrizas tras OAuth OK)
const SUCCESS_URL = process.env.SUCCESS_URL || `${BASE_URL}/redirect?done=1`;

// ====== Email (Gmail) ======
const {
  GMAIL_USER,
  GMAIL_PASS,
  FROM_EMAIL,
  APP_NAME = "NAZA Trading Academy",
  // enlaces opcionales del correo
  DISCORD_DOWNLOAD_URL = "https://discord.com/download",
  DISCORD_TUTORIAL_URL = "https://youtu.be/_51EAeKtTs0",
  IG_URL = "https://instagram.com/",
  TT_URL = "https://tiktok.com/@",
  WA_URL = "https://wa.me/50400000000",
  TG_URL = "https://t.me/"
} = process.env;

const mailer = (GMAIL_USER && GMAIL_PASS)
  ? nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: GMAIL_USER, pass: GMAIL_PASS }
    })
  : null;

async function sendEmail(to, { subject, html }) {
  if (!mailer) { console.log("📧 [FAKE EMAIL] →", to, "|", subject); return; }
  const info = await mailer.sendMail({ from: FROM_EMAIL || GMAIL_USER, to, subject, html });
  console.log("📧 Email enviado:", info.messageId, "→", to);
}

function buildWelcomeEmailHTML({ email, order_id, username = "Trader" }) {
  const btn = "display:inline-block;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700;";
  const p = "margin:0 0 14px;line-height:1.6;";
  const redirectLink = `${BASE_URL}/redirect?order_id=${encodeURIComponent(order_id || "")}&email=${encodeURIComponent(email || "")}`;

  return `
  <div style="margin:0;padding:0;background:#0b0d10;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#0b0d10" style="background:#0b0d10;">
      <tr><td align="center">
        <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:640px;max-width:640px;background:#0f1217;color:#e6e9ef;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;border:1px solid #1b212a;border-radius:12px;overflow:hidden;">
          <tr><td align="center" style="padding:24px 24px 8px;">
            <h2 style="margin:6px 0 0;font-size:22px;color:#ffffff;">${APP_NAME}</h2>
            <p style="margin:6px 0 0 0;font-size:12px;color:#98a1b3;">Si no ves este correo, revisa <b>Spam</b> o <b>Promociones</b>.</p>
          </td></tr>

          <tr><td style="padding:0 24px;">
            <p style="${p}">¡Bienvenido, <b>${username}</b>! 🎉</p>
            <p style="${p}">Para activar tu acceso, primero acepta Términos y Conecta tu Discord.</p>

            <div style="margin:18px 0">
              <a href="${redirectLink}" style="${btn}background:#2b6cff;color:#fff">Conectar con Discord</a>
              <p style="margin:8px 0 0;color:#98a1b3;font-size:12px">Este botón te muestra los T&C y luego abre el login de Discord.</p>
            </div>

            <div style="margin:18px 0 8px"><a href="${DISCORD_DOWNLOAD_URL}" style="${btn}background:#1f2633;color:#fff">⬇️ Descargar Discord</a></div>
            <div style="margin:8px 0 18px"><a href="${DISCORD_TUTORIAL_URL}" style="${btn}background:#1f2633;color:#fff">▶️ Ver tutorial</a></div>

            <hr style="border:none;border-top:1px solid #2a3240;margin:22px 0">

            <p style="${p}">Redes y soporte:</p>
            <div style="margin:8px 0 20px">
              <a href="${IG_URL}" style="${btn}background:#2a3240;color:#fff;margin-right:8px">📸 Instagram</a>
              <a href="${TT_URL}" style="${btn}background:#2a3240;color:#fff;margin-right:8px">🎵 TikTok</a>
              <a href="${WA_URL}" style="${btn}background:#2a3240;color:#fff;margin-right:8px">💬 WhatsApp</a>
              <a href="${TG_URL}" style="${btn}background:#2a3240;color:#fff">📣 Telegram</a>
            </div>

            <p style="color:#9ca3af;font-size:12px;margin-top:6px">
              <b>Disclaimer:</b> ${APP_NAME} es únicamente educativo. No brindamos asesoría financiera ni garantizamos resultados.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </div>`;
}

async function sendAccessEmail({ to, email, order_id, username }) {
  const html = buildWelcomeEmailHTML({ email, order_id, username });
  await sendEmail(to, { subject: `${APP_NAME} — Acceso y pasos (Discord)`, html });
}

// ====== Body parsers (raw para webhook) ======
function rawBodySaver(req, res, buf) { if (buf && buf.length) req.rawBody = buf; }
app.use((req, res, next) => {
  if (req.path === "/webhook/whop") {
    express.json({ verify: rawBodySaver })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

// ====== Health ======
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ====== Página post-pago con T&C (bloquea hasta aceptar) ======
app.get("/redirect", (req, res) => {
  const order_id = req.query.order_id || "";
  const email = req.query.email || "";

  const html = `<!doctype html><html lang="es"><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Aviso • NAZA Trading Academy</title>
<style>
  :root{--bg:#0b0d10;--card:#0f1217;--border:#1b212a;--text:#e6e9ef;--muted:#98a1b3;--pill:#2a3240;--btn:#2b6cff}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,Arial,sans-serif}
  .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{width:100%;max-width:720px;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px}
  h2{margin:0 0 10px;font-weight:700}p{margin:0 0 10px;line-height:1.55}
  .pill{display:inline-block;border:1px solid var(--pill);border-radius:999px;padding:10px 18px;background:var(--bg);color:var(--text);cursor:pointer;transition:all .15s ease}
  .btn{padding:12px 18px;border:0;border-radius:10px;background:var(--btn);color:#fff;font-weight:600}
  .btn[disabled]{opacity:.45;cursor:not-allowed;box-shadow:none}
  .hint{margin-top:10px;color:var(--muted);font-size:14px}
</style>
<div class="wrap"><div class="card">
  <h2>Último paso</h2>
  <p><strong>Compra exitosa.</strong> Te enviamos un correo con tus accesos. Revisa también <strong>Spam</strong> o <strong>Promociones</strong>.</p>
  <p><strong>NAZA Trading Academy</strong> es solo educativo; no es asesoría financiera. Eres responsable de tus decisiones.</p>

  <button id="accept-pill" class="pill" aria-pressed="false">Acepto Términos y Condiciones</button>
  <div style="margin-top:16px">
    <button id="continue-btn" class="btn" type="button" disabled>Conectar con Discord</button>
  </div>
  <p class="hint">También podrás continuar desde el correo de confirmación.</p>
</div></div>

<script>
(function(){
  const accept = document.getElementById('accept-pill');
  const go = document.getElementById('continue-btn');
  const state = JSON.stringify({ order_id: ${JSON.stringify(order_id)}, email: ${JSON.stringify(email)} });

  accept.addEventListener('click', function () {
    const on = accept.getAttribute('aria-pressed') !== 'true';
    accept.setAttribute('aria-pressed', on ? 'true' : 'false');
    go.disabled = !on;
  });

  go.addEventListener('click', function () {
    if (go.disabled) return;
    const url = ${JSON.stringify(BASE_URL)} + '/discord/login?state=' + encodeURIComponent(state);
    window.location.href = url;
  });
})();
</script>`;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.status(200).send(html);
});

// ====== Discord OAuth2 ======
function buildDiscordAuthURL(state) {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URL,
    response_type: "code",
    scope: "identify guilds.join",
    prompt: "consent",
    state
  });
  return "https://discord.com/api/oauth2/authorize?" + params.toString();
}

app.get("/discord/login", (req, res) => {
  const state = req.query.state || "{}";
  if (!DISCORD_CLIENT_ID || !DISCORD_REDIRECT_URL) {
    return res.status(500).send("Discord OAuth misconfigured");
  }
  return res.redirect(buildDiscordAuthURL(state));
});

app.get("/discord/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send("Missing code");

    // 1) Intercambiar code por token
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: DISCORD_REDIRECT_URL
      })
    });
    if (!tokenRes.ok) {
      const t = await tokenRes.text().catch(()=> "");
      throw new Error("TOKEN_EXCHANGE_FAIL " + tokenRes.status + " " + t);
    }
    const token = await tokenRes.json(); // { access_token, ... }

    // 2) Obtener usuario
    const meRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    if (!meRes.ok) throw new Error("ME_FAIL " + meRes.status);
    const me = await meRes.json();
    const userId = me.id;

    // 3) (Opcional) validar compra aquí con Whop API / DB usando 'state'
    // const meta = JSON.parse(state || "{}");

    // 4) Asegurar que el usuario esté en el servidor (guilds.join)
    const joinUrl = `https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${userId}`;
    const joinRes = await fetch(joinUrl, {
      method: "PUT",
      headers: {
        "Authorization": "Bot " + DISCORD_BOT_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ access_token: token.access_token })
    });
    if (!joinRes.ok && joinRes.status !== 204) {
      const txt = await joinRes.text().catch(()=> "");
      console.warn("GUILDS_JOIN_WARN", joinRes.status, txt);
    }

    // 5) Asignar rol
    await discordAddRole(DISCORD_GUILD_ID, userId, DISCORD_ROLE_ID);

    // 6) Redirigir a éxito
    return res.redirect(SUCCESS_URL);
  } catch (e) {
    console.error("DISCORD_CALLBACK_ERROR", e);
    return res.status(500).send("OAuth error");
  }
});

// ====== Webhook de Whop (PATH UNIFICADO) ======
app.post("/webhook/whop", async (req, res) => {
  try {
    if (!WHOP_WEBHOOK_SECRET) return res.status(500).send("secret missing");
    const raw = (req.rawBody && req.rawBody.toString("utf8")) || "";
    const sig = req.get("Whop-Signature") || req.get("X-Whop-Signature") || req.get("Whop-Webhook-Signature") || "";
    const expected = crypto.createHmac("sha256", WHOP_WEBHOOK_SECRET).update(raw).digest("hex");
    if (!safeEqual(expected, sig)) return res.status(400).send("invalid signature");

    // ------ Envío de email automático post-pago (backup) ------
    try {
      const bodyJson = JSON.parse(raw || "{}");
      const action = bodyJson?.action || bodyJson?.event;
      const email  = bodyJson?.data?.user?.email || bodyJson?.data?.email || "";
      const orderId = bodyJson?.data?.id || bodyJson?.data?.order_id || "";
      const okEvents = new Set(["payment_succeeded","membership_activated","membership_went_valid"]);
      if (email && okEvents.has(action)) {
        await sendAccessEmail({
          to: email,
          email,
          order_id: orderId,
          username: bodyJson?.data?.user?.username || bodyJson?.data?.user?.name || "Trader"
        });
        console.log("📧 Enviado email post-pago a", email);
      }
    } catch(e) {
      console.log("Webhook email skip:", e?.message);
    }
    // -----------------------------------------------------------

    // No damos rol aquí; el rol se da al completar OAuth.
    res.json({ ok: true });
  } catch (err) {
    console.error("WHOP_WEBHOOK_ERROR", err);
    res.json({ ok: false });
  }
});

// ====== Endpoint para reenvío manual de correo ======
app.post("/email/resend", async (req, res) => {
  try {
    const to = String(req.body.to || req.body.email || "").trim().toLowerCase();
    const order_id = String(req.body.order_id || "").trim();
    const username = String(req.body.username || "Trader");
    if (!to) return res.status(400).json({ error: "Falta email (to/email)" });

    await sendAccessEmail({ to, email: to, order_id, username });
    return res.json({ ok: true });
  } catch (e) {
    console.error("email/resend error:", e?.message || e);
    return res.status(500).json({ error: "server_error" });
  }
});

// ====== Discord role helpers (REST) ======
async function discordAddRole(guildId, userId, roleId) {
  if (!DISCORD_BOT_TOKEN || !guildId || !userId || !roleId) throw new Error("DISCORD_ENV_MISSING");
  const url = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`;
  const res = await fetch(url, { method: "PUT", headers: { Authorization: "Bot " + DISCORD_BOT_TOKEN } });
  if (!res.ok) {
    const body = await res.text().catch(()=> "");
    throw new Error("ADD_ROLE_FAIL " + res.status + ": " + body);
  }
}

function safeEqual(a, b) {
  try {
    const A = Buffer.from(String(a), "utf8");
    const B = Buffer.from(String(b), "utf8");
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch { return false; }
}

// ====== Start ======
app.listen(PORT, () => {
  console.log("NAZA.fx BOT running on " + BASE_URL);
  console.log("Post-pago: " + BASE_URL + "/redirect");
  console.log("OAuth callback: " + DISCORD_REDIRECT_URL);
  console.log("Whop webhook: " + BASE_URL + "/webhook/whop");
});
