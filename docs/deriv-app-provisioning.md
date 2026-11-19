# Deriv app provisioning: what is possible and what is not

This note exists so the question "why not one Deriv app per tenant?" does not
have to be re-investigated. Every claim below was measured, and the scripts that
measured it are in the repo.

## What is not possible

`app_register` is the only way to create a Deriv app, and it exists **only** on
the WebSocket API. There is no REST equivalent — `app_register`, `app_list`,
`app_update`, `app_delete` are all WebSocket methods, and every `/applications/*`
REST path returns 404.

From a datacenter network, that WebSocket API is not reachable:

| target | result |
| --- | --- |
| `ws.derivws.com/websockets/v3?app_id=…` | Cloudflare **520** after ~5.1 s |
| `ws.derivws.com/` (host root) | Cloudflare **520** after ~5.1 s |
| `ws.binaryws.com`, `frontend.binaryws.com` | Cloudflare 520 |
| `api.deriv.com/` | 301 |
| `developers.deriv.com/docs/intro/oauth/` | **200** |
| `app.deriv.com/` | 302 |
| `oauth.deriv.com/oauth2/authorize` | 302 |

The 520 carries a `cf-ray` header, so Cloudflare received the request and its
own connection to Deriv's origin failed. Raw TCP 443 succeeds and the DNS
answers. Everything on `deriv.com` works. So this is an **origin-side gate on
the `*derivws.com` zone**, not egress filtering of Deriv by networks — which is
why a browser connects to the same endpoint without trouble.

Reproduce with:

```
node scripts/deriv-egress-probe.mjs      # WebSocket attempt against every host
node scripts/deriv-egress-sweep.mjs      # plain HTTPS status sweep, no WebSocket
```

Two independent datacenter networks were checked (Supabase Edge and GitHub
Actions `ubuntu-latest`, in `ord`/`iad`/`sea`), with the same result.

The second blocker is the token: the stored operator token carries
`read, trade, account_manage`. `app_register` additionally requires `admin`, and
a PAT with `admin` must belong to a **PAT-type** app, which is a different app
from the OAuth 2.0 client ID used for end-user login.

## What is possible

Endpoint: `POST /api/deriv-app-provisioning/apps` in `dsites-backend`
(`new-user-interface-main/backend`). It calls `app_register` server-side, so no
Deriv token is ever handled in React.

```
POST /api/deriv-app-provisioning/apps
x-platform-admin-token: <PLATFORM_ADMIN_TOKEN>

{ "name": "clinchy", "redirectUri": "https://dsites-admin.vercel.app/api/deriv-oauth-callback" }
```

`GET /api/deriv-app-provisioning/apps` lists apps on the account.

Environment variables (server-side, never `VITE_*` / `NEXT_PUBLIC_*`):

| variable | purpose |
| --- | --- |
| `PLATFORM_ADMIN_TOKEN` | shared secret guarding both routes |
| `DERIV_ADMIN_API_TOKEN` | Deriv token with the `admin` scope on a PAT-type app |

Failure modes are returned as typed codes, so an infrastructure limit is never
mistaken for a bad request:

`network_blocked` (503) · `invalid_token` · `insufficient_scope` ·
`invalid_application` · `deriv_error` (400) · `timeout` · `socket_error`

If `network_blocked` is returned, the code is behaving correctly: it means that
network cannot reach the WebSocket API either.

## Consequence for the data model

Because per-tenant apps cannot be created, the pool holds one app: the
operator's OAuth 2.0 client ID. `bind_platform_deriv_app_to_site()` therefore
allows one app to serve several sites (migration
`20261119000700_allow_shared_platform_deriv_app.sql`) and returns
`sharedApp: true`.

**Accepted cost:** Deriv tracks markup per app, so per-site markup totals are not
separable. Per-site figures remain recorded per row
(`sites.requested_markup_rate`, `sites.platform_fee_rate`,
`sites.deriv_affiliate_id`) and `sites.platform_deriv_app_id` still records which
app each site used. If per-tenant apps ever become obtainable, the pool simply
gains rows and each site is pointed at its own — no schema change needed.

Per-site **attribution** does not require a per-tenant app: Deriv's OAuth
accepts `t` / `affiliate_token` / `sidi` / `ca`, plus `utm_campaign`,
`utm_medium=affiliate` and `utm_source`. That is stored per site in
`sites.deriv_affiliate_id`.
