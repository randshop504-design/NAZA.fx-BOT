// index.js - NAZA Bot (Node/Express)
const express = require('express');
const bodyParser = require('body-parser');
const braintree = require('braintree');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

// Config desde env
const PORT = process.env.PORT || 3000;
const FRONTEND_TOKEN = process.env.FRONTEND_TOKEN || ''; // token opcional que frontend envía en x-frontend-token
const BOT_SHARED_SECRET = process.env.BOT_SHARED_SECRET || ''; // opcional, si usas X-SHARED-SECRET
const BT_ENV = process.env.BT_ENV === 'Production' ? 'Production' : 'Sandbox';

const gateway = braintree.connect({
  environment: BT_ENV === 'Production' ? braintree.Environment.Production : braintree.Environment.Sandbox,
  merchantId: process.env.BT_MERCHANT_ID,
  publicKey: process.env.BT_PUBLIC_KEY,
  privateKey: process.env.BT_PRIVATE_KEY,
});

// Supabase client (opcional, usado para persistencia)
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Plan mapping: mapea los plan_id lógicos a los plan ids de Braintree (poner en env)
const PLAN_MAP = {
  plan_mensual: process.env.BT_PLAN_MENSUAL,     // ejemplo: 'braintree-plan-id-monthly'
  plan_trimestral: process.env.BT_PLAN_TRIMESTRAL,
  plan_anual: process.env.BT_PLAN_ANUAL
};
const DEFAULT_PLAN = process.env.DEFAULT_PLAN_ID || 'plan_mensual'; // fallback lógico, no Braintree id

// Helpers
function genMembershipId() {
  try {
    if (typeof uuidv4 === 'function') return uuidv4();
  } catch (e) {}
  return 'memb-' + Math.random().toString(36).slice(2, 12);
}

function resolvePlanId(plan_id, product_name, fallback = DEFAULT_PLAN) {
  // If frontend provides plan_id, use it.
  if (plan_id) return plan_id;

  // Try to detect from product_name text
  if (product_name) {
    const txt = (product_name || '').toLowerCase();
    if (txt.includes('mensual')) return 'plan_mensual';
    if (txt.includes('trimestral') || txt.includes('trimestre') || txt.includes('3')) return 'plan_trimestral';
    if (txt.includes('anual') || txt.includes('año')) return 'plan_anual';
  }

  // fallback
  return fallback;
}

// Middleware: optional token check (frontend)
function checkFrontendToken(req, res, next) {
  if (FRONTEND_TOKEN) {
    const token = req.header('x-frontend-token') || '';
    if (!token || token !== FRONTEND_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized (frontend token missing or invalid)' });
    }
  }
  // optional shared secret header
  if (BOT_SHARED_SECRET) {
    const shared = req.header('x-shared-secret');
    if (shared && shared !== BOT_SHARED_SECRET) {
      return res.status(401).json({ error: 'Unauthorized (shared secret mismatch)' });
    }
  }
  next();
}

// Endpoint recibido desde frontend para confirmar inicio de pago / crear suscripción
app.post('/api/frontend/confirm', checkFrontendToken, async (req, res) => {
  try {
    const body = req.body || {};
    // Campos esperados del frontend:
    // plan_id, product_name, email, user_name, membership_id, payment_method_nonce, discord_id (opcional)
    let { plan_id, product_name, email, user_name, membership_id, payment_method_nonce, discord_id } = body;

    // Normalizaciones ligeras
    email = (email || '').trim().toLowerCase();
    user_name = (user_name || '').trim();
    product_name = (product_name || '').trim();

    // 1) Resolver plan (NO fallamos si plan_id no está presente; en vez de eso intentamos resolver y si no usamos default)
    const resolvedPlan = resolvePlanId(plan_id, product_name);
    const braintreePlanId = PLAN_MAP[resolvedPlan] || null; // puede ser null si no configurado

    // 2) membership_id: si no llega, generarlo automáticamente
    if (!membership_id) {
      membership_id = genMembershipId();
    }

    // 3) Persistir estado inicial en Supabase (si está configurado)
    if (supabase) {
      try {
        // Tabla sugerida: 'memberships' con columnas: membership_id (PK), email, name, plan_id, status, created_at
        await supabase.from('memberships').upsert({
          membership_id,
          email: email || null,
          name: user_name || null,
          plan_id: resolvedPlan,
          status: (payment_method_nonce ? 'processing' : 'pending'),
        }, { onConflict: 'membership_id' });
      } catch (err) {
        console.warn('Supabase upsert failed:', err && err.message ? err.message : err);
      }
    }

    // 4) Si no llega payment_method_nonce => respondemos OK (registro pendiente).
    if (!payment_method_nonce) {
      return res.status(200).json({
        ok: true,
        membership_id,
        message: 'No payment_method_nonce provided. Membership registered as pending. Complete payment via webhook or provide nonce in a future request.'
      });
    }

    // 5) Crear/obtener customer en Braintree y crear payment method -> crear suscripción
    // Nota: cuando braintreePlanId no esté configurado, intentamos crear una transacción puntual en vez de subscription.
    let result = { ok: false };
    // a) create customer (we can search by email)
    let braintreeCustomerId = null;
    try {
      // Buscar cliente por email (Braintree no tiene búsqueda por email simple sin usar API de search; intentar crear y deduplicar)
      const customerResult = await gateway.customer.create({ email, firstName: user_name || undefined });
      if (customerResult && customerResult.success) {
        braintreeCustomerId = customerResult.customer.id;
      } else {
        // If create failed due to duplicate, try to fallback by searching customers with payment methods - lightweight fallback omitted
        // We'll try to continue with created payment method flow using the nonce directly (create payment method without customer)
        console.warn('Braintree customer create: not success', customerResult && customerResult.message);
      }
    } catch (err) {
      console.warn('Braintree customer create error:', err && err.message ? err.message : err);
    }

    // b) create payment method from nonce
    let paymentMethodToken = null;
    try {
      const pmCreateParams = {
        paymentMethodNonce: payment_method_nonce,
        options: { verifyCard: true }
      };
      if (braintreeCustomerId) pmCreateParams.customerId = braintreeCustomerId;

      const pmRes = await gateway.paymentMethod.create(pmCreateParams);
      if (pmRes && pmRes.success) {
        paymentMethodToken = pmRes.paymentMethod.token;
      } else {
        // If creation failed, fallback: try transaction.sale with the nonce (one-time)
        console.warn('Payment method create failed:', pmRes && (pmRes.message || pmRes.errors));
      }
    } catch (err) {
      console.warn('paymentMethod.create error:', err && err.message ? err.message : err);
    }

    // c) If have paymentMethodToken and plan configured -> create subscription
    if (paymentMethodToken && braintreePlanId) {
      try {
        const subRes = await gateway.subscription.create({
          paymentMethodToken,
          planId: braintreePlanId,
          // opcionales: price override, merchantAccountId, etc.
        });
        if (subRes && subRes.success) {
          // update supabase status
          if (supabase) {
            try {
              await supabase.from('memberships').update({
                status: 'active',
                braintree_subscription_id: subRes.subscription.id,
                braintree_customer_id: braintreeCustomerId || null
              }).eq('membership_id', membership_id);
            } catch (e) { /* ignore */ }
          }

          // Optionally add discord role if discord_id provided and DISCORD_TOKEN present
          if (discord_id && process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID && process.env.DISCORD_ROLE_ID) {
            try {
              const url = `https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/${discord_id}/roles/${process.env.DISCORD_ROLE_ID}`;
              await fetch(url, {
                method: 'PUT',
                headers: {
                  'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}`,
                },
              });
            } catch (err) {
              console.warn('Discord role assign failed:', err && err.message ? err.message : err);
            }
          }

          return res.json({
            ok: true,
            membership_id,
            subscription_id: subRes.subscription.id,
            message: 'Subscription created successfully.'
          });
        } else {
          console.warn('subscription.create not success', subRes && subRes.message);
          // fallthrough to try one-time transaction
        }
      } catch (err) {
        console.warn('Subscription create error:', err && err.message ? err.message : err);
      }
    }

    // d) Fallback: si no pudimos crear suscripción, intentamos una transacción puntual con el nonce
    try {
      const txRes = await gateway.transaction.sale({
        amount: (process.env.FALLBACK_TRANSACTION_AMOUNT || '0.00'), // prefer backend compute amount; optional
        paymentMethodNonce: payment_method_nonce,
        options: { submitForSettlement: true },
        customer: { email, firstName: user_name || undefined }
      });
      if (txRes && txRes.success) {
        if (supabase) {
          try {
            await supabase.from('memberships').update({
              status: 'paid_onetime',
              braintree_transaction_id: txRes.transaction.id
            }).eq('membership_id', membership_id);
          } catch (e) {}
        }
        return res.json({
          ok: true,
          membership_id,
          transaction_id: txRes.transaction.id,
          message: 'One-time transaction processed (fallback).'
        });
      } else {
        console.warn('transaction.sale failed:', txRes && txRes.message);
      }
    } catch (err) {
      console.warn('transaction.sale error:', err && err.message ? err.message : err);
    }

    // If reach here -> no success
    return res.status(500).json({ ok: false, error: 'Payment processing failed. Check logs for details.' });

  } catch (err) {
    console.error('confirm endpoint error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Health & debug
app.get('/health', (req, res) => res.json({ ok: true, env: (process.env.NODE_ENV || 'dev') }));

app.listen(PORT, () => {
  console.log(`NAZA Bot index.js running on port ${PORT}`);
});
