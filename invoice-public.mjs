// Read-only view of one invoice for its pay link (/?pay=<id>). Works without signing in.
import { handle, json, adminDb, HttpError } from '../shared.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default handle(async (req) => {
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!UUID.test(id)) throw new HttpError(404, 'That invoice link is not valid.');
  const db = adminDb();
  const { data: inv } = await db.from('invoices')
    .select('id, number, pro_id, customer_name, items, total, notes, issued_on, due_on, status, paid_at, payment_method')
    .eq('id', id).maybeSingle();
  if (!inv) throw new HttpError(404, 'We could not find that invoice. Ask the pro to send the link again.');
  const [{ data: pro }, { data: pay }] = await Promise.all([
    db.from('pros').select('business_name, trade, license, city').eq('id', inv.pro_id).maybeSingle(),
    db.from('pro_payments').select('charges_enabled').eq('pro_id', inv.pro_id).maybeSingle(),
  ]);
  return json({ ...inv, pro: pro || {}, accepts_cards: Boolean(pay?.charges_enabled) });
});

export const config = { path: '/api/invoice' };
