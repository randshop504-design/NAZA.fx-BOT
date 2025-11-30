// ============================================
// WEBHOOK: WHOP (versión SIMPLE, SIN FIRMA HMAC)
app.post('/webhook/whop', bodyParser.json(), async (req, res) => {
  try {
    // Logs para ver TODO lo que manda WHOP
    console.log('TODOS LOS HEADERS WHOP:', req.headers);
    console.log('PAYLOAD WHOP COMPLETO:', JSON.stringify(req.body));

    // Payload básico
    const payload = req.body || {};

    // WHOP en tus tests manda algo como:
    // { "action": "payment.succeeded", "api_version": "v1", "data": null }
    const event =
      payload.event ||
      payload.type ||
      payload.kind ||
      payload.action || // ej. "payment.succeeded", "app_payment.succeeded"
      null;

    const data = payload.data || payload || {};

    // Extraer datos típicos (cuando WHOP mande info real de user)
    const customerId =
      data.customer_id ||
      data.customer?.id ||
      data.user_id ||
      null;

    const subscriptionId =
      data.subscription_id ||
      data.subscription?.id ||
      null;

    const email =
      data.customer?.email ||
      data.email ||
      null;

    console.log('WHOP EVENT:', event, 'customerId:', customerId, 'subscriptionId:', subscriptionId, 'email:', email);

    await logAccess(null, 'whop_webhook_received', {
      event,
      customerId,
      subscriptionId,
      email,
      raw: payload
    });

    // ================================
    // LÓGICA SIMPLE: CUÁNDO DAR / QUITAR ACCESO
    // ================================

    // Eventos para DAR acceso
    const grantEvents = new Set([
      'subscription.created',
      'subscription.activated',
      'subscription.started',
      'access.granted',
      'payment.succeeded',
      'app_payment.succeeded',
      'app_membership.went_valid'
    ]);

    // Eventos para QUITAR acceso
    const revokeEvents = new Set([
      'subscription.deleted',
      'subscription.canceled',
      'subscription.cancelled',
      'subscription.ended',
      'invoice.refund',
      'refund.created',
      'payment.refunded',
      'app_membership.went_invalid',
      'app_membership.went_expired'
    ]);

    const status = String(
      data.status ||
      (data.subscription && data.subscription.status) ||
      ''
    ).toLowerCase();

    const isRevokeByStatus =
      (
        event === 'subscription.updated' ||
        event === 'subscription.status_changed'
      ) &&
      ['canceled', 'cancelled', 'expired', 'past_due'].includes(status);

    const isGrant = grantEvents.has(event);
    const isRevoke = revokeEvents.has(event) || isRevokeByStatus;

    if (isGrant || isRevoke) {
      const membership = await findMembership({ customerId, subscriptionId, email });

      if (!membership) {
        console.warn('No se encontró membership para WHOP:', {
          event,
          customerId,
          subscriptionId,
          email
        });
        await logAccess(null, 'whop_no_membership_found', {
          event,
          customerId,
          subscriptionId,
          email
        });
      } else {
        if (isGrant) {
          await grantRoleInDiscord({
            discord_id: membership.discord_id,
            plan_id: membership.plan_id,
            event
          });
          await logAccess(membership.id, 'access_granted', {
            event,
            membership_id: membership.id
          });
        }

        if (isRevoke) {
          await revokeRolesInDiscord({
            discord_id: membership.discord_id,
            event
          });
          await logAccess(membership.id, 'access_revoked', {
            event,
            membership_id: membership.id
          });
        }
      }
    } else {
      // Evento que no afecta acceso, solo lo registramos
      await logAccess(null, 'whop_webhook_ignored_event', { event, payload });
      console.log('WHOP webhook ignorado, evento:', event);
    }

    // Siempre responder 200 para que WHOP no reintente en bucle
    return res.status(200).send('ok');
  } catch (err) {
    console.error('❌ Error general en /webhook/whop:', err?.message || err);
    return res.status(500).send('internal error');
  }
});
