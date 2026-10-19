// Starts a Stripe Checkout payment for an invoice. POST { invoiceId }.
// The money goes to the pro's Stripe account; Probrero keeps its platform fee.
import { handle, json, adminDb, stripe, siteUrl, platformFee, HttpError } from '../shared.mjs';

export default handle(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');
  const { invoiceId } = await req.json().catch(() => ({}));
  if (!invoiceId) throw new HttpError(400, 'Missing invoice.');

  const db = adminDb();
  const { data: inv } = await db.from('invoices').select('*').eq('id', invoiceId).maybeSingle();
  if (!inv) throw new HttpError(404, 'We could not find that invoice.');
  if (inv.status === 'paid') throw new HttpError(409, 'This invoice is already paid.');
  if (inv.status === 'void') throw new HttpError(409, 'This invoice was canceled by the pro.');

  const [{ data: pro }, { data: pay }] = await Promise.all([
    db.from('pros').select('business_name').eq('id', inv.pro_id).single(),
    db.from('pro_payments').select('stripe_account_id, charges_enabled').eq('pro_id', inv.pro_id).maybeSingle(),
  ]);
  if (!pay?.stripe_account_id || !pay.charges_enabled) {
    throw new HttpError(409, `${pro?.business_name || 'This pro'} hasn't set up card payments yet. Pay them directly or ask them to connect Stripe.`);
  }

  const s = stripe();

  // Reuse an unfinished checkout so a customer can't accidentally pay twice.
  if (inv.stripe_session_id) {
    try {
      const prev = await s.checkout.sessions.retrieve(inv.stripe_session_id);
      if (prev.status === 'complete') throw new HttpError(409, 'This invoice is already paid. It may take a minute to show.');
      if (prev.status === 'open' && prev.url) return json({ url: prev.url });
    } catch (e) {
      if (e instanceof HttpError) throw e;
    }
  }

  const amount = Math.round(Number(inv.total) * 100);
  if (amount < 50) throw new HttpError(400, 'Card payments must be at least $0.50.');
  const site = siteUrl(req);

  const session = await s.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: amount,
        product_data: { name: `Invoice ${inv.number} · ${pro.business_name}` },
      },
    }],
    payment_intent_data: {
      application_fee_amount: platformFee(amount),
      transfer_data: { destination: pay.stripe_account_id },
      description: `Probrero invoice ${inv.number} from ${pro.business_name}`,
      metadata: { invoice_id: inv.id },
    },
    metadata: { invoice_id: inv.id },
    customer_email: inv.customer_email || undefined,
    success_url: `${site}/?paid=${inv.id}`,
    cancel_url: `${site}/?pay=${inv.id}`,
  });

  await db.from('invoices').update({ stripe_session_id: session.id }).eq('id', inv.id).eq('status', 'open');
  return json({ url: session.url });
});

export const config = { path: '/api/checkout' };
