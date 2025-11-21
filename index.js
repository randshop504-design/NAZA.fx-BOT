// index.js - NAZA Bot (Node/Express) - Mejorado con webhook Braintree y mejoras solicitadas
const express = require('express');
const bodyParser = require('body-parser');
const braintree = require('braintree');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

const app = express();

// Middlewares
app.use(bodyParser.json({ limit: '1mb' }));
// Para webhooks de Braintree (envía form-urlencoded)
app.use('/webhook/braintree', bodyParser.urlencoded({ extended: false }));

// Config desde env
const PORT = process.env.PORT || 3000;
const FRONTEND_TOKEN = process.env.FRONTEND_TOKEN || ''; // opcional
const BOT_SHARED_SECRET = process.env.BOT_SHARED_SECRET || ''; // opcional

const BT_ENV = process.env.BT_ENV === 'Production' ? 'Production' : 'Sandbox';
const gateway = braintree.connect({
  environment: BT_ENV === 'Production' ? braintree.Environment.Production : braintree.Environment.Sandbox,
  merchantId: process.env.BT_MERCHANT_ID,
  publicKey: process.env.BT_PUBLIC_KEY,
  privateKey: process.env.BT_PRIVATE_KEY,
});

// Supabase (opcional)
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Plan mapping (IDs reales de Braintree en env)
const PLAN_MAP = {
  plan_mensual: process.env.BT_PLAN_MENSUAL,
  plan_trimestral: process.env.BT_PLAN_TRIMESTRAL,
  plan_anual: process.env.BT_PLAN_ANUAL
};
const DEFAULT_PLAN = process.env.DEFAULT_PLAN_ID || 'plan_mensual';

// Validación inicial (logs)
(function validateConfig(){
  if (!process.env.BT_MERCHANT_ID || !process.env.BT_PUBLIC_KEY || !process.env.BT_PRIVATE_KEY) {
    console.warn('⚠️ Braintree credentials missing (BT_MERCHANT_ID / BT_PUBLIC_KEY / BT_PRIVATE_KEY). Sandbox tests will fail without them.');
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn('ℹ️ Supabase not configured. Persistence will be skipped.');
  }
})();

// Helpers
function genMembershipId() {
  try { return uuidv4(); } catch (e) { return 'memb-' + Math.random().toString(36).slice(2,12); }
}

function resolvePlanId(plan_id, product_name, fallback = DEFAULT_PLAN) {
  if (plan_id) return plan_id;
  if (product_name) {
    const txt = (product_name || '').toLowerCase();
    if (txt.includes('mensual')) return 'plan_mensual';
    if (txt.includes('trimestral') || txt.includes('trimestre') || txt.includes('3')) return 'plan_trimestral';
    if (txt.includes('anual') || txt.includes('año')) return 'plan_anual';
  }
  return fallback;
}

async function upsertMembership(membership) {
  if (!supabase) return;
  try {
    await supabase.from('memberships').upsert(membership, { onConflict: 'membership_id' });
  } catch (err) {
    console.warn('Supabase upsert failed:', err && err.message ? err.message : err);
  }
}

async function updateMembershipBySubscriptionId(subscriptionId, patch) {
  if (!supabase) return;
  try {
    await supabase.from('memberships').update(patch).eq('braintree_subscription_id', subscriptionId);
  } catch (err) {
    console.warn('Supabase update by subscription failed:', err && err.message ? err.message : err);
  }
}

async function updateMembershipByTransactionId(transactionId, patch) {
  if (!supabase) return;
  try {
    await supabase.from('memberships').update(patch).eq('braintree_transaction_id', transactionId);
  } catch (err) {
    console.warn('Supabase update by transaction failed:', err && err.message ? err.message : err);
  }
}

function checkFrontendToken(req, res, next) {
  if (FRONTEND_TOKEN) {
    const token = (req.header('x-frontend-token') || '').trim();
    if (!token || token !== FRONTEND_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized (frontend token missing or invalid)' });
    }
  }
  if (BOT_SHARED_SECRET) {
    const shared = (req.header('x-shared-secret') || '').trim();
    if (shared && shared !== BOT_SHARED_SECRET) {
      return res.status(401).json({ error: 'Unauthorized (shared secret mismatch)' });
    }
  }
  next();
}

// Endpoint: confirm desde frontend (crear membership / procesar nonce)
app.post('/api/frontend/confirm', checkFrontendToken, async (req, res) => {
  try {
    const body = req.body || {};
    let { plan_id, product_name, email, user_name, membership_id, payment_method_nonce, discord_id } = body;

    email = (email || '').trim().toLowerCase();
    user_name = (user_name || '').trim();
    product_name = (product_name || '').trim();

    const resolvedPlan = resolvePlanId(plan_id, product_name);
    const braintreePlanId = PLAN_MAP[resolvedPlan] || null;

    if (!membership_id) membership_id = genMembershipId();

    // persist initial record (pending or processing)
    await upsertMembership({
      membership_id,
      email: email || null,
      name: user_name || null,
      plan_id: resolvedPlan,
      status: payment_method_nonce ? 'processing' : 'pending',
      created_at: new Date().toISOString()
    });

    if (!payment_method_nonce) {
      return res.status(200).json({
        ok: true,
        membership_id,
        message: 'No payment_method_nonce provided. Registered as pending; webhook will finalize payment status.'
      });
    }

    // Create customer in Braintree (best-effort)
    let braintreeCustomerId = null;
    try {
      const cRes = await gateway.customer.create({ email, firstName: user_name || undefined });
      if (cRes && cRes.success) braintreeCustomerId = cRes.customer.id;
      else console.warn('Customer create not success:', cRes && cRes.message);
    } catch (err) {
      console.warn('Braintree customer create error:', err && err.message ? err.message : err);
    }

    // Create payment method
    let paymentMethodToken = null;
    try {
      const pmParams = { paymentMethodNonce: payment_method_nonce, options: { verifyCard: true } };
      if (braintreeCustomerId) pmParams.customerId = braintreeCustomerId;
      const pmRes = await gateway.paymentMethod.create(pmParams);
      if (pmRes && pmRes.success) paymentMethodToken = pmRes.paymentMethod.token;
      else console.warn('Payment method create failed:', pmRes && pmRes.message);
    } catch (err) {
      console.warn('paymentMethod.create error:', err && err.message ? err.message : err);
    }

    // If have paymentMethodToken and plan mapping -> create subscription
    if (paymentMethodToken && braintreePlanId) {
      try {
        const subRes = await gateway.subscription.create({
          paymentMethodToken,
          planId: braintreePlanId
        });
        if (subRes && subRes.success) {
          // persist
          await upsertMembership({
            membership_id,
            status: 'active',
            braintree_subscription_id: subRes.subscription.id,
            braintree_customer_id: braintreeCustomerId || null,
            updated_at: new Date().toISOString()
          });

          // assign discord role if possible
          if (discord_id && process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID && process.env.DISCORD_ROLE_ID) {
            try {
              const url = `https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/${discord_id}/roles/${process.env.DISCORD_ROLE_ID}`;
              await fetch(url, { method: 'PUT', headers: { 'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}` } });
            } catch (err) {
              console.warn('Discord role assign failed:', err && err.message ? err.message : err);
            }
          }

          return res.json({ ok: true, membership_id, subscription_id: subRes.subscription.id, message: 'Subscription created.' });
        } else {
          console.warn('subscription.create not success', subRes && subRes.message);
        }
      } catch (err) {
        console.warn('Subscription create error:', err && err.message ? err.message : err);
      }
    }

    // Fallback -> transaction sale using nonce (one-time)
    try {
      const amount = process.env.FALLBACK_TRANSACTION_AMOUNT || '0.00';
      const txRes = await gateway.transaction.sale({
        amount,
        paymentMethodNonce: payment_method_nonce,
        options: { submitForSettlement: true },
        customer: { email, firstName: user_name || undefined }
      });
      if (txRes && txRes.success) {
        await upsertMembership({
          membership_id,
          status: 'paid_onetime',
          braintree_transaction_id: txRes.transaction.id,
          updated_at: new Date().toISOString()
        });
        return res.json({ ok: true, membership_id, transaction_id: txRes.transaction.id, message: 'One-time transaction processed (fallback).' });
      } else {
        console.warn('transaction.sale failed:', txRes && txRes.message);
      }
    } catch (err) {
      console.warn('transaction.sale error:', err && err.message ? err.message : err);
    }

    return res.status(500).json({ ok: false, error: 'Payment processing failed. Check logs.' });

  } catch (err) {
    console.error('confirm endpoint error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Webhook endpoint para Braintree
app.post('/webhook/braintree', async (req, res) => {
  try {
    const bt_signature = req.body.bt_signature;
    const bt_payload = req.body.bt_payload;
    if (!bt_signature || !bt_payload) {
      console.warn('Webhook received without signature/payload');
      return res.status(400).send('Missing bt_signature or bt_payload');
    }

    let webhookNotification;
    try {
      webhookNotification = await gateway.webhookNotification.parse(bt_signature, bt_payload);
    } catch (err) {
      console.error('Webhook parse failed:', err && err.message ? err.message : err);
      return res.status(400).send('Invalid webhook');
    }

    const kind = webhookNotification.kind;
    console.log('Braintree webhook received:', kind);

    // Manejar tipos comunes
    switch (kind) {
      case braintree.WebhookNotification.Kind.SubscriptionChargedSuccessfully:
        {
          const sub = webhookNotification.subscription;
          const subId = sub.id;
          console.log('SubscriptionChargedSuccessfully for', subId);
          await updateMembershipBySubscriptionId(subId, { status: 'active', last_charge_at: new Date().toISOString() });
        }
        break;

      case braintree.WebhookNotification.Kind.SubscriptionCanceled:
        {
          const sub = webhookNotification.subscription;
          await updateMembershipBySubscriptionId(sub.id, { status: 'canceled', canceled_at: new Date().toISOString() });
        }
        break;

      case braintree.WebhookNotification.Kind.SubscriptionWentPastDue:
        {
          const sub = webhookNotification.subscription;
          await updateMembershipBySubscriptionId(sub.id, { status: 'past_due', updated_at: new Date().toISOString() });
        }
        break;

      case braintree.WebhookNotification.Kind.TransactionDisbursed:
      case braintree.WebhookNotification.Kind.TransactionSettled:
        {
          const tx = webhookNotification.transaction;
          console.log('Transaction event', tx && tx.id);
          if (tx && tx.id) {
            await updateMembershipByTransactionId(tx.id, { status: 'settled', braintree_transaction_id: tx.id, updated_at: new Date().toISOString() });
          }
        }
        break;

      default:
        console.log('Unhandled webhook kind:', kind);
        break;
    }

    // Acknowledge
    res.status(200).send('OK');

  } catch (err) {
    console.error('Webhook handling error:', err && err.stack ? err.stack : err);
    res.status(500).send('Internal error');
  }
});

// Health
app.get('/health', (req, res) => res.json({ ok: true, env: (process.env.NODE_ENV || 'dev') }));

app.listen(PORT, () => {
  console.log(`NAZA Bot index.js running on port ${PORT} (env: ${BT_ENV})`);
});
