// WEBHOOK: WHOP (raw body required for signature verification)
app.post('/webhook/whop', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const rawBody = req.body; // Buffer
    const signatureHeader = (req.headers['x-whop-signature'] || req.headers['x-signature'] || '').toString();
    if (!WHOP_WEBHOOK_SECRET) {
      console.error('WHOP_WEBHOOK_SECRET no configurado');
      return res.status(500).send('Server misconfigured');
    }
    if (!signatureHeader) {
      console.warn('Webhook sin signature header');
      return res.status(401).send('No signature');
    }

    // ---------- SAFE signature validation (fix) ----------
    // Expected: HMAC-SHA256 hex (64 hex chars)
    const sigHeader = (signatureHeader || '').toString().trim();
    // validate hex format and length before using timingSafeEqual to avoid exceptions
    if (!/^[a-f0-9]{64}$/i.test(sigHeader)) {
      console.warn('Signature header formato inválido o longitud incorrecta:', sigHeader.slice(0,8));
      await logAccess(null, 'webhook_invalid_signature_format', { header_sample: sigHeader.slice(0,8) });
      return res.status(401).send('Invalid signature');
    }
    const computed = crypto.createHmac('sha256', WHOP_WEBHOOK_SECRET).update(rawBody).digest('hex');
    // Convert both to buffers with explicit 'hex'
    const computedBuf = Buffer.from(computed, 'hex');
    const headerBuf = Buffer.from(sigHeader, 'hex');
    // timingSafeEqual requires buffers of same length — they will be if both are 32 bytes
    if (computedBuf.length !== headerBuf.length) {
      console.warn('Signature length mismatch');
      await logAccess(null, 'webhook_invalid_signature_length', { header_sample: sigHeader.slice(0,8) });
      return res.status(401).send('Invalid signature');
    }
    const signatureMatches = crypto.timingSafeEqual(computedBuf, headerBuf);
    if (!signatureMatches) {
      console.warn('Firma webhook inválida');
      await logAccess(null, 'webhook_invalid_signature', { header: sigHeader.slice(0,8) });
      return res.status(401).send('Invalid signature');
    }
    // ---------- end signature validation ----------
    
    // parse JSON safely
    const payload = JSON.parse(rawBody.toString('utf8'));
    // Support different event key names
    const event = payload.event || payload.type || payload.kind || payload?.data?.event || null;
    const data = payload.data || payload || {};
    await logAccess(null, 'webhook_received', { event });

    // Normalize fields
    const orderId = data.order_id || data.id || (data.order && data.order.id) || null;
    const subscriptionId = data.subscription_id || data.subscription?.id || null;
    const status = data.status || data.payment_status || null;
    const productId = data.product_id || data.product?.id || data.product_name || null;
    const amount = data.amount || (data.order && data.order.amount) || null;
    const currency = data.currency || (data.order && data.order.currency) || null;
    const buyer = data.buyer || data.customer || {};
    const email = (buyer.email || '').toString().trim().toLowerCase();
    const last4 = (data.payment_method && data.payment_method.last4) || (buyer.last4) || (data.card_last4) || '';

    // Idempotency: check if we already processed this order
    if (orderId) {
      const { data: existing, error: exErr } = await supabase.from('webhook_events').select('id').eq('order_id', orderId).limit(1);
      if (exErr) console.warn('exErr checking webhook_events:', exErr);
      if (existing && existing.length > 0) {
        // Already received — respond 200
        await logAccess(null, 'webhook_duplicate', { orderId });
        return res.status(200).send('already processed');
      }
      // persist basic event to avoid races
      await supabase.from('webhook_events').insert([{ order_id: orderId, subscription_id: subscriptionId, event: event || status || 'unknown', raw: payload, received_at: new Date().toISOString() }]).catch(err => {
        console.warn('No se pudo persistir webhook_events (continuamos):', err?.message || err);
      });
    }

    // Handle main events
    if (['payment_succeeded', 'order.paid', 'order_paid', 'membership_activated', 'payment_succeeded_v2'].some(e => (event || '').toString().toLowerCase().includes(e))) {
      // if email exists -> create or reuse claim and send email
      if (email) {
        try {
          // Check if membership already exists active for this email (idempotency)
          const { data: members, error: memErr } = await supabase.from('memberships').select('id,status').eq('email', email).limit(1);
          if (memErr) console.warn('memErr checking membership in webhook:', memErr);
          if (members && members.length > 0 && members[0].status === 'active') {
            await logAccess(null, 'webhook_noop_member_already_active', { email, orderId });
            return res.status(200).send('member already active');
          }
          // create claim token and send email
          const { data: existingClaims } = await supabase.from('claims').select('*').or(`subscription_id.eq.${subscriptionId},extra.like.%order:${orderId}%`).limit(1);
          let token = null;
          if (existingClaims && existingClaims.length > 0) {
            token = existingClaims[0].token;
            if (existingClaims[0].used) {
              await logAccess(null, 'webhook_claim_already_used', { email, orderId });
              return res.status(200).send('claim already used');
            }
          } else {
            token = await createClaimToken({ email, name: buyer.full_name || buyer.name || '', plan_id: productId || '', subscriptionId, customerId: buyer.id || '', last4, cardExpiry: data.card_expiry || '' , extra: { order: orderId } });
            await supabase.from('claims').update({ extra: JSON.stringify({ order: orderId }) }).eq('token', token).catch(()=>{});
          }
          // send welcome email (background)
          sendWelcomeEmail(email, buyer.full_name || '', productId || '', subscriptionId, buyer.id || '', { last4, cardExpiry: data.card_expiry || '' }, token)
            .then(()=> logAccess(null, 'webhook_email_dispatched', { email, orderId }))
            .catch(err => logAccess(null, 'webhook_email_failed', { email, orderId, err: err?.message || err }));
          return res.status(200).send('ok');
        } catch (err) {
          console.error('Error processing payment_succeeded webhook:', err?.message || err);
          await logAccess(null, 'webhook_processing_error', { err: err?.message || err });
          return res.status(500).send('error processing');
        }
      } else {
        // No email: create a pending record for manual review
        try {
          await supabase.from('memberships').insert([{
            order_id: orderId,
            subscription_id: subscriptionId,
            product_id: productId,
            amount,
            currency,
            status: 'awaiting_data',
            raw_payload: payload,
            created_at: new Date().toISOString()
          }]);
          await logAccess(null, 'webhook_missing_email_created_pending', { orderId });
          return res.status(200).send('pending awaiting data');
        } catch (err) {
          console.error('Error creating pending membership for missing email:', err?.message || err);
          return res.status(500).send('error');
        }
      }
    }

    // cancellation / deactivation
    if (['subscription.cancelled', 'membership_deactivated', 'subscription_cancelled', 'order_refunded'].some(e => (event || '').toString().toLowerCase().includes(e))) {
      try {
        const lookup = subscriptionId ? { subscription_id: subscriptionId } : (orderId ? { order_id: orderId } : null);
        if (!lookup) {
          await logAccess(null, 'webhook_cancel_no_lookup', { event, orderId, subscriptionId });
          return res.status(200).send('no lookup keys');
        }
        const { data: rows } = await supabase.from('memberships').select('*').or(`subscription_id.eq.${subscriptionId},order_id.eq.${orderId}`).limit(1);
        if (rows && rows.length > 0) {
          const row = rows[0];
          // revoke role if exists
          if (row.discord_id && row.role_id) {
            // attempt to remove role (best-effort)
            try {
              const guild = await discordClient.guilds.fetch(GUILD_ID);
              const member = await guild.members.fetch(row.discord_id);
              await member.roles.remove(row.role_id).catch(err => { throw err; });
              await logAccess(row.id, 'role_revoked', { discord_id: row.discord_id, role_id: row.role_id });
            } catch (err) {
              console.warn('Could not revoke role immediately:', err?.message || err);
              await logAccess(row.id, 'role_revocation_failed', { err: err?.message || err });
            }
          }
          // update membership status
          await supabase.from('memberships').update({ status: 'cancelled', revoked_at: new Date().toISOString() }).eq('id', row.id);
          return res.status(200).send('cancelled processed');
        } else {
          await logAccess(null, 'webhook_cancel_no_membership_found', { subscriptionId, orderId });
          return res.status(200).send('no membership found');
        }
      } catch (err) {
        console.error('Error processing cancel webhook:', err?.message || err);
        return res.status(500).send('error processing cancel');
      }
    }

    // default
    await logAccess(null, 'webhook_unhandled', { event });
    return res.status(200).send('ignored');
  } catch (err) {
    console.error('❌ Error general en /webhook/whop:', err?.message || err);
    return res.status(500).send('internal error');
  }
});
