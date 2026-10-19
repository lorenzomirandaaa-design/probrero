// Connects a pro's business to Stripe so they can be paid by card.
// POST { action: "onboard" | "status" | "dashboard" } with the user's session token.
import { handle, json, adminDb, stripe, requireUser, siteUrl, HttpError } from '../shared.mjs';

export default handle(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');
  const { action } = await req.json().catch(() => ({}));
  const db = adminDb();
  const user = await requireUser(req, db);

  const { data: pro } = await db.from('pros').select('id, business_name, trade').eq('id', user.id).maybeSingle();
  if (!pro) throw new HttpError(400, 'Set up your business profile first.');

  const { data: row } = await db.from('pro_payments').select('*').eq('pro_id', pro.id).maybeSingle();
  const s = stripe();
  const site = siteUrl(req);

  if (action === 'onboard') {
    let accountId = row?.stripe_account_id;
    if (!accountId) {
      const account = await s.accounts.create({
        type: 'express',
        country: 'US',
        email: user.email,
        business_profile: { name: pro.business_name, product_description: `${pro.trade} services booked through Probrero` },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        metadata: { probrero_pro_id: pro.id },
      });
      accountId = account.id;
      const { error } = await db.from('pro_payments')
        .upsert({ pro_id: pro.id, stripe_account_id: accountId, charges_enabled: false, updated_at: new Date().toISOString() });
      if (error) throw error;
    }
    const link = await s.accountLinks.create({
      account: accountId,
      type: 'account_onboarding',
      refresh_url: `${site}/?stripe=refresh`,
      return_url: `${site}/?stripe=return`,
    });
    return json({ url: link.url });
  }

  if (action === 'status') {
    if (!row?.stripe_account_id) return json({ connected: false, chargesEnabled: false, detailsSubmitted: false });
    const account = await s.accounts.retrieve(row.stripe_account_id);
    const chargesEnabled = Boolean(account.charges_enabled);
    if (chargesEnabled !== row.charges_enabled) {
      await db.from('pro_payments').update({ charges_enabled: chargesEnabled, updated_at: new Date().toISOString() }).eq('pro_id', pro.id);
    }
    return json({ connected: true, chargesEnabled, detailsSubmitted: Boolean(account.details_submitted) });
  }

  if (action === 'dashboard') {
    if (!row?.stripe_account_id) throw new HttpError(400, 'Connect Stripe first.');
    const login = await s.accounts.createLoginLink(row.stripe_account_id);
    return json({ url: login.url });
  }

  throw new HttpError(400, 'Unknown action.');
});

export const config = { path: '/api/stripe-account' };
