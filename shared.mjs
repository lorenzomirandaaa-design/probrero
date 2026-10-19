// Helpers shared by the Netlify functions.
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export const env = (key, fallback) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};

export function requireEnv(...keys) {
  const missing = keys.filter((k) => !env(k));
  if (missing.length) {
    throw new HttpError(500, `Server setup is incomplete. Add ${missing.join(', ')} in Netlify → Site configuration → Environment variables, then redeploy.`);
  }
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// Wraps a handler so thrown errors become clean JSON responses.
export const handle = (fn) => async (req, context) => {
  try {
    return await fn(req, context);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    const message = err instanceof HttpError ? err.message
      : (err && err.type && err.type.startsWith('Stripe') ? `Stripe: ${err.message}` : 'Something went wrong on our side. Try again in a minute.');
    return json({ error: message }, status);
  }
};

// Supabase client with full access. Server-only: never send this key to the browser.
export function adminDb() {
  requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function stripe() {
  requireEnv('STRIPE_SECRET_KEY');
  return new Stripe(env('STRIPE_SECRET_KEY'));
}

// Returns the signed-in Supabase user from the "Authorization: Bearer <token>" header.
export async function requireUser(req, db) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Log in first.');
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'Your session expired. Sign in again.');
  return data.user;
}

export function siteUrl(req) {
  return (env('SITE_URL') || new URL(req.url).origin).replace(/\/$/, '');
}

// Probrero's cut of each card payment, in cents.
// Default 3.9% + 30¢: Stripe charges about 2.9% + 30¢, so Probrero keeps about 1%.
export function feeSettings() {
  return {
    percent: Number(env('PLATFORM_FEE_PERCENT', '3.9')),
    flatCents: Math.round(Number(env('PLATFORM_FEE_FLAT_CENTS', '30'))),
  };
}
export function platformFee(amountCents) {
  const { percent, flatCents } = feeSettings();
  const fee = Math.round((amountCents * percent) / 100) + flatCents;
  return Math.max(0, Math.min(fee, amountCents - 50));
}
