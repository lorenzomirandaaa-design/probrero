// Public settings the website needs to start. Only public keys go here.
import { env, json, feeSettings } from '../shared.mjs';

export default async () => {
  const supabaseUrl = env('SUPABASE_URL');
  const supabaseAnonKey = env('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnonKey) {
    return json({ error: 'missing-config' }, 500);
  }
  return json({
    supabaseUrl,
    supabaseAnonKey,
    payments: Boolean(env('STRIPE_SECRET_KEY')),
    fee: feeSettings(),
  });
};

export const config = { path: '/api/config' };
