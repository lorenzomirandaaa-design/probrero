// ---- Probrero server helpers (self-contained: no extra libraries needed) ----
const env = (key, fallback) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireEnv(...keys) {
  const missing = keys.filter((k) => !env(k));
  if (missing.length) throw new HttpError(500, `Server setup is incomplete. Add ${missing.join(', ')} in Netlify → Project configuration → Environment variables, then redeploy.`);
}
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const handle = (fn) => async (req, context) => {
  try { return await fn(req, context); }
  catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(err);
    return json({ error: err instanceof HttpError ? err.message : 'Something went wrong on our side. Try again in a minute.' }, status);
  }
};
const siteUrl = (req) => (env('SITE_URL') || new URL(req.url).origin).replace(/\/$/, '');

// Supabase, with full access. The service role key never leaves the server.
function sbHeaders(extra) {
  requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const h = { apikey: key, 'content-type': 'application/json', ...extra };
  if (!key.startsWith('sb_')) h.authorization = 'Bearer ' + key;   // legacy JWT keys
  return h;
}
async function db(path, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(env('SUPABASE_URL').replace(/\/$/, '') + '/rest/v1/' + path, {
    method, headers: sbHeaders(prefer ? { prefer } : {}), body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) { console.error('Supabase error', r.status, text); throw new HttpError(500, 'The database request failed. Check the Supabase keys in Netlify.'); }
  return text ? JSON.parse(text) : null;
}
const one = async (path) => { const rows = await db(path); return Array.isArray(rows) ? rows[0] || null : rows; };
const eq = (v) => 'eq.' + encodeURIComponent(v);
async function requireUser(req) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Log in first.');
  requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  const r = await fetch(env('SUPABASE_URL').replace(/\/$/, '') + '/auth/v1/user', {
    headers: { apikey: env('SUPABASE_SERVICE_ROLE_KEY'), authorization: 'Bearer ' + token },
  });
  if (!r.ok) throw new HttpError(401, 'Your session expired. Log in again.');
  return r.json();
}

// Stripe, called directly over its web API.
function formEncode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out.join('&');
}
async function stripe(method, path, params) {
  requireEnv('STRIPE_SECRET_KEY');
  const qs = method === 'GET' && params ? '?' + formEncode(params) : '';
  const r = await fetch('https://api.stripe.com/v1/' + path + qs, {
    method,
    headers: { authorization: 'Bearer ' + env('STRIPE_SECRET_KEY'), 'content-type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : formEncode(params || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('Stripe error', r.status, JSON.stringify(data));
    throw new HttpError(r.status >= 500 ? 502 : 400, 'Stripe: ' + (data.error?.message || 'request failed'));
  }
  return data;
}

// Probrero's cut of each card payment, in cents. Default 3.9% + 30¢
// (Stripe takes about 2.9% + 30¢ of that, so Probrero keeps about 1%).
function feeSettings() {
  return { percent: Number(env('PLATFORM_FEE_PERCENT', '3.9')), flatCents: Math.round(Number(env('PLATFORM_FEE_FLAT_CENTS', '30'))) };
}
function platformFee(cents) {
  const { percent, flatCents } = feeSettings();
  return Math.max(0, Math.min(Math.round((cents * percent) / 100) + flatCents, cents - 50));
}
// ---- end helpers ----

// Connects a pro's business to Stripe. POST { action: "onboard" | "status" | "dashboard" }.
export default handle(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST.');
  const { action } = await req.json().catch(() => ({}));
  const user = await requireUser(req);
  const pro = await one(`pros?select=id,business_name,trade&id=${eq(user.id)}`);
  if (!pro) throw new HttpError(400, 'Set up your business profile first.');
  const row = await one(`pro_payments?select=*&pro_id=${eq(pro.id)}`);
  const site = siteUrl(req);

  if (action === 'onboard') {
    let accountId = row?.stripe_account_id;
    if (!accountId) {
      const account = await stripe('POST', 'accounts', {
        type: 'express', country: 'US', email: user.email,
        business_profile: { name: pro.business_name, product_description: `${pro.trade} services booked through Probrero` },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        metadata: { probrero_pro_id: pro.id },
      });
      accountId = account.id;
      await db('pro_payments?on_conflict=pro_id', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: { pro_id: pro.id, stripe_account_id: accountId, charges_enabled: false, updated_at: new Date().toISOString() },
      });
    }
    const link = await stripe('POST', 'account_links', {
      account: accountId, type: 'account_onboarding',
      refresh_url: `${site}/?stripe=refresh`, return_url: `${site}/?stripe=return`,
    });
    return json({ url: link.url });
  }

  if (action === 'status') {
    if (!row?.stripe_account_id) return json({ connected: false, chargesEnabled: false, detailsSubmitted: false });
    const account = await stripe('GET', 'accounts/' + encodeURIComponent(row.stripe_account_id));
    const chargesEnabled = Boolean(account.charges_enabled);
    if (chargesEnabled !== row.charges_enabled) {
      await db(`pro_payments?pro_id=${eq(pro.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: { charges_enabled: chargesEnabled, updated_at: new Date().toISOString() } });
    }
    return json({ connected: true, chargesEnabled, detailsSubmitted: Boolean(account.details_submitted) });
  }

  if (action === 'dashboard') {
    if (!row?.stripe_account_id) throw new HttpError(400, 'Connect Stripe first.');
    const login = await stripe('POST', `accounts/${encodeURIComponent(row.stripe_account_id)}/login_links`, {});
    return json({ url: login.url });
  }
  throw new HttpError(400, 'Unknown action.');
});
export const config = { path: '/api/stripe-account' };
