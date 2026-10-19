# Probrero setup guide (version 2: no folders)

This version of Probrero is **14 files with no folders**, so you can upload all of them in one go from any browser or device.

| File | What it is |
|---|---|
| `index.html` | The whole website |
| `manifest.webmanifest`, `icon.svg`, `icon-192.png`, `icon-512.png` | App name and icons for phones |
| `config.mjs`, `checkout.mjs`, `invoice-public.mjs`, `stripe-account.mjs`, `stripe-webhook.mjs` | Server code for accounts and payments |
| `netlify.toml`, `package.json` | Settings for Netlify |
| `schema.sql` | Database setup, which you paste into Supabase |
| `README.md` | This guide |

Do the steps in this order: Supabase, then GitHub, then Netlify, and Stripe last.

---

## Step 1: Supabase (accounts and database)

*Skip this if you already did it.*

1. At **supabase.com**, create a free project named `probrero`.
2. Open **SQL Editor → New query**, paste everything from `schema.sql`, and click **Run**.
3. Go to **Project Settings → API Keys** and open the **Legacy API Keys** tab. Copy the **anon** key and the **service_role** key. Copy the **Project URL** from **Project Settings → Data API**, or from the **Connect** button at the top.

## Step 2: GitHub (a fresh repository)

Start a new repository so files from earlier tries can't get in the way.

1. On **github.com**, click **+ → New repository**. Name it `probrero-site`, choose **Private**, and click **Create repository**.
2. On the next page, click the **uploading an existing file** link.
3. Click **choose your files**. Open the unzipped `probrero-site` folder on your computer, select **all 14 files** (on Mac press **Cmd + A**, on Windows press **Ctrl + A**), and click **Open**.
4. Wait until all 14 files are listed, then click **Commit changes**.
5. Check the repository's front page. It should list the 14 files directly, with no folders.

## Step 3: Netlify (switch your project to the new repository)

1. Open your **probrero** project in Netlify.
2. Go to **Project configuration → Build & deploy → Continuous deployment**. In the **Repository** section, click **Manage repository → Link to a different repository**, then choose **GitHub → probrero-site**.
3. On the same page, under **Build settings**, click **Edit settings** and **clear these fields** (`netlify.toml` fills them in):
   - **Base directory:** empty
   - **Build command:** empty
   - **Publish directory:** empty
   - **Functions directory:** empty

   Click **Save**.
4. Your environment variables stay where they are. Under **Project configuration → Environment variables**, check that these three exist: `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.
5. Go to **Deploys → Trigger deploy → Deploy project**. In about a minute it should say **Published**.

> No GitHub button in Step 3.2? Delete the old project in Netlify instead, then use **Add new project → Import an existing project → GitHub → probrero-site**, and add the three environment variables again.

## Step 4: Supabase (tell it your website address)

In Supabase, open **Authentication → URL Configuration**:

- **Site URL:** `https://YOUR-PROJECT.netlify.app`
- **Redirect URLs:** add `https://YOUR-PROJECT.netlify.app/**`

## Step 5: Test accounts

Open your site, click **Sign up**, confirm your email, then **Log in** and **Log out**. If that works, accounts are live.

## Step 6: Stripe (card payments, whenever you're ready)

1. At **stripe.com**, stay in **Test mode**. Turn on **Connect** and choose a marketplace with **Express** accounts.
2. Copy your secret key from **Developers → API keys** (`sk_test_…`) and add it to Netlify as `STRIPE_SECRET_KEY`.
3. Go to **Developers → Webhooks → Add endpoint** (or **Add destination → Your account**):
   - **URL:** `https://YOUR-PROJECT.netlify.app/api/stripe-webhook`
   - **Events:** `checkout.session.completed` and `checkout.session.async_payment_succeeded`
4. Copy the endpoint's **Signing secret** (`whsec_…`) and add it to Netlify as `STRIPE_WEBHOOK_SECRET`.
5. Click **Trigger deploy** again.
6. To test: log in as a pro, click **Connect Stripe** and use Stripe's test details. Create an invoice, open its pay link in a private window, and pay with the test card **4242 4242 4242 4242** (any future date, any CVC).

---

## Keep these private

Only paste `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` into Netlify's environment variables. Never put them in a file, a message or a screenshot.

## How the money works

On a $100 card payment, Probrero keeps 3.9% + 30¢ ($4.20). Stripe takes about $3.20 of that, so you earn about $1.00 and the pro receives $95.80. To change the fee, add `PLATFORM_FEE_PERCENT` and `PLATFORM_FEE_FLAT_CENTS` in Netlify, then redeploy.

## If something isn't working

- **Deploy fails:** open the failed deploy in Netlify, copy the red lines from the log, and send them to Claude.
- **Site says "Almost there":** an environment variable is missing or misspelled, or you didn't redeploy after adding it.
- **Confirmation emails don't arrive:** check spam. Supabase's built-in email sends only a few per hour, so connect an email service (Supabase → Authentication → Emails → SMTP) before launch.
- **See server errors:** Netlify → your project → **Logs → Functions**.
