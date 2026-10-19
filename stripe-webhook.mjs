// Stripe calls this after a payment. It marks the invoice as paid.
// Add this URL in Stripe → Developers → Webhooks: https://YOUR-SITE/api/stripe-webhook
// Events: checkout.session.completed, checkout.session.async_payment_succeeded
import { json, adminDb, stripe, env } from '../shared.mjs';

export default async (req) => {
  const secret = env('STRIPE_WEBHOOK_SECRET');
  if (!secret) return json({ error: 'STRIPE_WEBHOOK_SECRET is not set' }, 500);

  let event;
  try {
    const raw = await req.text();
    event = stripe().webhooks.constructEvent(raw, req.headers.get('stripe-signature'), secret);
  } catch (err) {
    return json({ error: `Webhook signature check failed: ${err.message}` }, 400);
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    const invoiceId = session.metadata?.invoice_id;
    if (invoiceId && session.payment_status === 'paid') {
      const { error } = await adminDb().from('invoices')
        .update({
          status: 'paid',
          paid_at: new Date().toISOString(),
          payment_method: 'Card via Stripe',
          stripe_session_id: session.id,
        })
        .eq('id', invoiceId)
        .eq('status', 'open');
      if (error) {
        console.error(error);
        return json({ error: 'Could not update invoice' }, 500);  // Stripe will retry
      }
    }
  }
  return json({ received: true });
};

export const config = { path: '/api/stripe-webhook' };
