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

// Public settings the website needs to start. Only public keys go here.
export default async () => {
  const supabaseUrl = env('SUPABASE_URL'), supabaseAnonKey = env('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnonKey) return json({ error: 'missing-config' }, 500);
  if (!/^https:\/\/[^\s/]+/.test(supabaseUrl)) return json({ error: 'bad-url', message: 'SUPABASE_URL should be your Supabase Project URL, which looks like https://abcdefgh.supabase.co. Right now it holds something else (often a key). Fix it in Netlify → Project configuration → Environment variables, then redeploy.' }, 500);
  return json({ supabaseUrl, supabaseAnonKey, payments: Boolean(env('STRIPE_SECRET_KEY')), fee: feeSettings() });
};
export const config = { path: '/api/config' };
