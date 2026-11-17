# Deploying Reef Sites / DerivSites on Vercel

All browser frontends and the optional community API deploy directly from this single GitHub repository (`GARDNADZENT/Full-Dsites-code`) as separate Vercel projects, backed by Supabase.

| Component | Root Directory | Vercel Config | Purpose |
| --- | --- | --- | --- |
| **Supabase Backend** | `deriv-sites-ui-kit-main/supabase` | `supabase/config.toml` | Postgres, RLS, Storage, Deriv OAuth/OTP BFF, GitHub publisher, Vercel provisioner |
| **Project 1 — Admin Site Manager** | `deriv-sites-ui-kit-main` | `deriv-sites-ui-kit-main/vercel.json` | Owner onboarding wizard + staff admin dashboard |
| **Project 2 — Tenant Trading App** | `new-user-interface-main` | `new-user-interface-main/vercel.json` | Multi-tenant Deriv DBot trading UI |
| **Project 3 — Community API** *(optional)* | `new-user-interface-main/backend` | `new-user-interface-main/backend/vercel.json` | Serverless Express API for `/api/bot-ideas`, `/api/best-bot-stats`, `/api/scanner` |

---

## 1. Update Your Supabase Project Ref (If Changed)

If you use a different Supabase project than `tsidnkyizypwlxtkkoyd`, replace `tsidnkyizypwlxtkkoyd` in:
- `deriv-sites-ui-kit-main/supabase/config.toml`
- `deriv-sites-ui-kit-main/vercel.json`
- `new-user-interface-main/vercel.json`

---

## 2. Deploy Supabase Migrations & Edge Functions

```bash
# Generate 32-byte AES-256 encryption key once
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

cd deriv-sites-ui-kit-main
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
npx supabase db push
```

Set server secrets:

```bash
npx supabase secrets set \
  TOKEN_ENCRYPTION_KEY="<generated-32-byte-base64url-key>" \
  ENVIRONMENT="production" \
  PLATFORM_BASE_URL="https://admin.yourdomain.com" \
  TRADER_CORS_ORIGINS="https://your-tenant-project.vercel.app" \
  GITHUB_APP_ID="<github-app-id>" \
  GITHUB_APP_INSTALLATION_ID="<github-installation-id>" \
  GITHUB_APP_PRIVATE_KEY="$(cat private-key.pem)" \
  GITHUB_REPO_OWNER="GARDNADZENT" \
  GITHUB_REPO_NAME="Full-Dsites-code" \
  GITHUB_REPO_BRANCH="main" \
  GITHUB_SITES_CONFIG_ROOT="sites" \
  VERCEL_ACCESS_TOKEN="<vercel-api-token>" \
  VERCEL_TEAM_ID="<optional-team_xxx>" \
  VERCEL_TEAM_SLUG="<optional-team-or-account-slug>" \
  VERCEL_SHARED_PROJECT_ID="<prj_xxx-from-step-4>" \
  VERCEL_WEBHOOK_SECRET="<vercel-webhook-signing-secret>"
```

Deploy all Edge Functions:

```bash
# Public / BFF / webhook functions
for fn in deriv-oauth-start deriv-oauth-callback deriv-trader-session \
          deriv-trader-accounts deriv-trader-otp public-site-config \
          vercel-deploy-webhook check-domain mpesa-stk-push mpesa-callback \
          send-purchase-email get-domain-purchases delete-failed-purchase; do
  npx supabase functions deploy "$fn" --no-verify-jwt
done

# Authenticated functions
for fn in deriv-owner-oauth-start fetch-markup-statistics \
          publish-site-to-github provision-site-vercel \
          check-payment-status send-site-live-email; do
  npx supabase functions deploy "$fn"
done
```

In **Supabase Dashboard → Authentication → URL Configuration**, set:
- **Site URL**: `https://admin.yourdomain.com`
- **Redirect URLs**: `https://admin.yourdomain.com/**`, `https://*.vercel.app/**`

---

## 3. Deploy Project 1 — Admin Site Manager

1. **Vercel → Add New → Project** → import `GARDNADZENT/Full-Dsites-code`.
2. Set **Root Directory** to `deriv-sites-ui-kit-main` (`vercel.json` automatically configures `cd .. && npm install --include=optional`, `npm run build`, `dist`, and SPA rewrites).
3. Under **Settings → General → Node.js Version**, select **20.x**.
4. Add **Environment Variables**:
   - `VITE_SUPABASE_URL=https://<PROJECT_REF>.supabase.co`
   - `VITE_SUPABASE_PUBLISHABLE_KEY=<supabase-anon-or-publishable-key>`
   - `VITE_ENABLE_DEV_AUTH=false`
5. Deploy and attach your admin custom domain (e.g. `admin.yourdomain.com`).
6. Sign up once, then grant admin access in Supabase SQL Editor:
   ```sql
   insert into public.user_roles (user_id, role)
   select id, 'admin' from auth.users where email = 'you@example.com'
   on conflict do nothing;
   ```

---

## 4. Deploy Project 2 — Tenant Trading App

1. **Vercel → Add New → Project** → import `GARDNADZENT/Full-Dsites-code`.
2. Set **Root Directory** to `new-user-interface-main` (`vercel.json` automatically sets workspace install, `npm run build`, `dist`, ignored-build script, and same-origin `/api/deriv-*` + `/api/public-site-config` rewrites).
3. Under **Settings → General → Node.js Version**, select **20.x**.
4. Add **Environment Variables**:
   - `APP_ENV=production`
   - `SITE_CONFIG_API_BASE_URL=https://<PROJECT_REF>.supabase.co/functions/v1`
   - `BACKEND_API_URL=https://<your-project-3>.vercel.app/api` *(optional — only if deploying Project 3)*
5. Deploy, then copy **Settings → General → Project ID** (`prj_...`) and set it in Supabase:
   ```bash
   npx supabase secrets set VERCEL_SHARED_PROJECT_ID="prj_..."
   ```
   - **Shared mode (`VERCEL_SHARED_PROJECT_ID` set — recommended):** Clicking **Provision Website** in Admin attaches each customer domain directly to this single Vercel project, and runtime config loads dynamically by hostname with zero rebuilds.
   - **Dedicated mode (`VERCEL_SHARED_PROJECT_ID` unset):** Clicking **Provision Website** creates a separate Vercel project per tenant with `REEF_SITE_ID=<site-id>` and `scripts/vercel-ignore-site.js`.

### Optional: Connect Vercel Deploy Webhooks
1. **Vercel → Team/Account Settings → Webhooks → Create Webhook**:
   - **Events**: `deployment.created`, `deployment.succeeded`, `deployment.ready`, `deployment.error`, `deployment.canceled`
   - **Endpoint URL**: `https://<PROJECT_REF>.supabase.co/functions/v1/vercel-deploy-webhook`
2. Copy the generated signing secret into Supabase:
   ```bash
   npx supabase secrets set VERCEL_WEBHOOK_SECRET="<signing-secret>"
   ```

---

## 5. Deploy Project 3 — Community & Scanner API *(Optional)*

1. **Vercel → Add New → Project** → import `GARDNADZENT/Full-Dsites-code`.
2. Set **Root Directory** to `new-user-interface-main/backend`.
3. Add **Environment Variables**:
   - `DATABASE_URL=<postgres-connection-string>` *(Supabase Transaction Pooler on port 6543 or Neon)*
   - `NODE_ENV=production`
   - `CORS_ORIGIN=https://client1.com,https://client2.com` *(leave empty to allow all tenant domains)*
4. Deploy and set `BACKEND_API_URL=https://<project-3-domain>/api` on Project 2 (or add `/api/bot-ideas`, `/api/best-bot-stats`, `/api/scanner` rewrites to `new-user-interface-main/vercel.json` for same-origin access).

---

## 6. Launching Each Tenant Domain

1. Create/configure the site in Admin (`https://admin.yourdomain.com`), set the exact Deriv callback URL `https://<tenant-domain>/api/deriv-oauth-callback`, and register that same callback URL in the Deriv Developer Portal.
2. Open the site's **Deploy** tab → click **Provision Website** (auto-attaches `<tenant-domain>` to Vercel) → click **Update Website**.
3. Point the tenant's DNS to Vercel (`A @ 76.76.21.21` / `CNAME www cname.vercel-dns.com`). Vercel provisions SSL automatically.
4. Verify:
   - `https://<tenant-domain>/api/public-site-config?hostname=<tenant-domain>` returns `200` JSON.
   - `https://<tenant-domain>` renders tenant branding and completes Deriv OAuth login.
