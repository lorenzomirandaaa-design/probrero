# Probrero setup guide

Probrero is a website where:

- **Customers** create an account, find local pros, request quotes, and pay invoices by card.
- **Pros** create an account, publish a business listing, answer quote requests, send invoices with a pay link, log expenses and receipts, and get paid through Stripe.
- **Probrero** (you) keeps a small fee on every card payment.

Three free services run it:

| Service | What it does | Cost to start |
|---|---|---|
| **Supabase** | Accounts, sign-in, database, receipt photos | Free |
| **Stripe** | Card payments, paying out pros | Free (fees only when money moves) |
| **Netlify** | Hosts the website and the payment code | Free |

Plan on about 45 minutes. Do everything in **test mode** first, so no real money moves until you're ready.

---

## Step 1: Set up the database (Supabase)

1. Go to **supabase.com**, sign up, and click **New project**. Name it `probrero`, set a database password (save it somewhere), pick the region closest to you, and click **Create**.
2. When it's ready, open **SQL Editor** in the left menu, then **New query**.
3. Open the file `supabase/schema.sql` from this folder, copy everything, paste it into the editor, and click **Run**. You should see "Success. No rows returned."
4. Open **Project Settings → API** (sometimes under **Data API** or **API Keys**). Keep this tab open. You'll copy three values from it in Step 4:
   - **Project URL**
   - **anon public** key
   - **service_role** key. This one is secret: never paste it anywhere except Netlify.

## Step 2: Set up payments (Stripe)

1. Go to **stripe.com** and create an account. Leave the **Test mode** switch on (top right).
2. In the dashboard, open **Connect** (search for "Connect" if you don't see it) and click **Get started**. When asked, choose a **platform or marketplace** where your users get paid. Probrero uses **Express** accounts, so Stripe handles each pro's ID check and bank details.
3. Open **Developers → API keys** and copy the **Secret key** (it starts with `sk_test_`). It's secret too.

## Step 3: Put the code online (GitHub + Netlify)

The payment code has to run on a server, so this time you connect Netlify to GitHub instead of dragging a folder onto Netlify Drop.

1. Go to **github.com**, sign up, and click **New repository**. Name it `probrero`, make it **Private**, and click **Create repository**.
2. On the new repository page, click **uploading an existing file**. Drag in **everything inside** this `probrero-app` folder (the `public`, `netlify` and `supabase` folders plus `package.json`, `netlify.toml` and the other files), then click **Commit changes**.
3. Go to **app.netlify.com** → **Add new site → Import an existing project → GitHub**. Choose the `probrero` repository and click **Deploy**. The settings fill themselves in from `netlify.toml`.
   - Already made `probrero.netlify.app` with Netlify Drop? Open that site instead and go to **Site configuration → Build & deploy → Link repository**, so you keep the same name.
4. Note your site's address, for example `https://probrero.netlify.app`.

## Step 4: Connect everything (environment variables)

In Netlify, open your site → **Site configuration → Environment variables → Add a variable**. Add each of these:

| Key | Value |
|---|---|
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_ANON_KEY` | Supabase **anon public** key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase **service_role** key |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_…`) |

Then open **Deploys → Trigger deploy → Deploy site**, so the site picks up the new values.

## Step 5: Tell Stripe when payments go through (webhook)

1. In Stripe, open **Developers → Webhooks → Add endpoint** (on newer dashboards: **Add destination**, then choose "Your account").
2. Endpoint URL: `https://YOUR-SITE.netlify.app/api/stripe-webhook`
3. Select these events: `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Save.
4. Open the endpoint, click **Reveal** under **Signing secret**, and copy it (it starts with `whsec_`).
5. In Netlify, add one more environment variable, `STRIPE_WEBHOOK_SECRET`, with that value, then **Trigger deploy** again.

## Step 6: Tell Supabase your website address

In Supabase, open **Authentication → URL Configuration**:

- **Site URL:** `https://YOUR-SITE.netlify.app`
- **Redirect URLs:** add `https://YOUR-SITE.netlify.app/**`

This makes the "confirm your email" and "reset password" links open your site.

## Step 7: Test it end to end

Use two different email addresses, one for the pro and one for the customer.

1. Open your site and click **List your business**. Sign up as a pro, confirm the email, sign in, and fill out your listing.
2. On the Overview page, click **Connect Stripe**. Because you're in test mode, Stripe accepts test details. Use the **Use test data** or **Skip** buttons where Stripe offers them, or enter:
   - Phone: `000 000 0000`, SMS code: `000000`
   - SSN: `000-00-0000`, date of birth: `01/01/1901`
   - Bank routing: `110000000`, account: `000123456789`
3. When Stripe sends you back to Probrero, the Business page should say **Card payments are on**.
4. Click **New invoice**, enter your *other* email as the customer, and create it. Copy the pay link.
5. Open the pay link in a private window and click **Pay**. Use the test card `4242 4242 4242 4242`, any future expiry date, and any 3-digit CVC.
6. You'll land on "Payment sent." Back on the pro account, the invoice shows **Paid**. In Stripe → **Connect → Accounts**, you'll see the pro's balance and Probrero's fee.
7. Sign up as a customer with the second email. The paid invoice appears under **Bills**, and you can leave the pro a review.

## Step 8: Going live with real money

When test payments work:

1. **Stripe:** switch off Test mode and finish activating your account. Copy your **live** secret key (`sk_live_…`) and create the same webhook again in live mode, which gives you a new `whsec_` secret. Update both values in Netlify and redeploy. Stripe may review your platform before live Connect payouts start.
2. **Email:** Supabase's built-in email only sends a few messages per hour, which is fine for testing but not for real customers. In Supabase → **Authentication → Emails → SMTP Settings**, connect an email service such as Resend, Postmark or SendGrid (most have free tiers).
3. **Legal:** add Terms of Service and a Privacy Policy before you take real customers. A marketplace that moves money should have a lawyer look these over.
4. **Domain:** connect `probrero.com` in Netlify → **Domain management**, then update the Site URL in Supabase (Step 6) and the webhook URL in Stripe (Step 5) to the new address.

---

## How the money works

When a customer pays a $100 invoice by card:

- The customer pays **$100**.
- Probrero keeps **3.9% + 30¢ = $4.20**. Stripe takes its card fee (about 2.9% + 30¢ = $3.20) out of that, so **Probrero earns about $1.00**.
- The pro receives **$95.80** in their Stripe balance, and Stripe deposits it to their bank.

To change the fee, add `PLATFORM_FEE_PERCENT` and `PLATFORM_FEE_FLAT_CENTS` in Netlify's environment variables (for example `5` and `30`), then redeploy. Cash and check payments that pros record themselves are free.

## How it's protected

- Every page of data is locked to its owner by database rules. Customers only see their own quotes and bills, and pros only see their own invoices, requests and expenses.
- The database calculates every invoice total itself, so nobody can change the price a customer pays.
- Only customers who actually paid a pro through Probrero can review that pro.
- Paid invoices can't be edited. Only Stripe's verified webhook can mark a card payment as paid.
- Secret keys live only in Netlify's environment variables, never in the website files.

## What's in this folder

```
public/                 The website (what visitors load)
  index.html, app.js, styles.css, icons, sw.js
netlify/functions/      Server code for payments
  config.mjs            Gives the website its public settings
  stripe-account.mjs    Connects a pro to Stripe and checks their status
  checkout.mjs          Starts a card payment for an invoice
  invoice-public.mjs    Shows an invoice on its pay link
  stripe-webhook.mjs    Marks invoices paid when Stripe confirms
netlify/shared.mjs      Helpers, including the fee calculation
supabase/schema.sql     Database tables and security rules
netlify.toml            Netlify settings
package.json            Code libraries Netlify installs (Stripe, Supabase)
.env.example            List of the settings from Step 4
```

## If something isn't working

- **"Almost there… not connected to its database":** `SUPABASE_URL` or `SUPABASE_ANON_KEY` is missing in Netlify, or you didn't redeploy after adding them.
- **Sign-up emails never arrive:** check spam, then see Step 8 (the built-in email limit).
- **"Connect Stripe" shows an error about Connect:** finish Step 2.2 (Connect has to be turned on in Stripe).
- **Invoice stays "Unpaid" after a successful payment:** the webhook isn't reaching the site. Check the webhook URL and `STRIPE_WEBHOOK_SECRET` (Step 5), and look at the endpoint's event log in Stripe for errors.
- **See the server's error messages:** Netlify → your site → **Logs → Functions**.
