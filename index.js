app.post('/webhook/whop', express.json(), (req, res) => {
  try {
    console.log("📩 Webhook recibido desde Whop:");
    console.log(req.body); // para ver exactamente qué datos llegan

    const event = req.body?.event || req.body?.type || "undefined";
    const email = req.body?.data?.email || req.body?.email || "undefined";
    const discordId = req.body?.data?.discord_id || req.body?.discord_id || "undefined";

    console.log(`🧾 Event: ${event}, Email: ${email}, Discord ID: ${discordId}`);

    if (event === "payment_succeeded" || event === "membership_activated") {
      console.log("✅ Evento válido recibido, procesando...");
      // Aquí luego asignaremos el rol en Discord automáticamente
    } else {
      console.log("⚠️ Evento ignorado:", event);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Error al procesar webhook:", error);
    res.status(500).send("Internal Server Error");
  }
});
