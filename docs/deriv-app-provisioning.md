# Deriv app provisioning: what is possible and what is not

This note exists so the question "why not one Deriv app per tenant?" does not
have to be re-investigated. Everything below was measured; the scripts that
measured it are in this repo and run in CI.

## The short version

Creating a Deriv app **programmatically is not possible**, and the reason is not
a missing token scope. It is a platform split:

- **Registering apps** belongs to Deriv's **legacy stack**. `app_register`,
  `app_list`, `app_update`, `app_delete` exist only on the legacy WebSocket API.
  There is no REST equivalent — every `/applications/*` path on the new API
  returns 404.
- **Logging users in** uses the **new OAuth 2.0 stack** (`auth.deriv.com` +
  `api.derivws.com`), whose scope set is `trade`, `account_manage`,
  `application_read`, `payment`. **There is no `admin` scope**, so no token of
  this kind can ever call `app_register`.

The two half-platforms do not meet: the thing that could register an app is on a
host that is unreachable, and the reachable host does not have that thing.

## The measurement

| path | result |
| --- | --- |
| `ws.derivws.com/websockets/v3` (legacy WS) | Cloudflare **520** after ~5.1 s |
| `ws.binaryws.com`, `frontend.binaryws.com` (legacy WS) | Cloudflare **520** |
| `api.derivws.com/trading/v1/options/ws/public` (new WS) | **reachable**, `ping` replied, `active_symbols` ok |
| …its `app_list` / `app_register` / `app_update` / `app_get` | `UnknownMethod` — **not routed** |
| …its `balance` | `AuthorizationRequired` — routed, gated by auth |
| …its `authorize` | `UnknownMethod` — legacy auth is not served here |
| `api.derivws.com/applications…` (7 path variants) | **404** |
| `api.derivws.com/trading/v1/options/accounts` | **401** — host is real |
| `api.deriv.com`, `app.deriv.com`, `oauth.deriv.com`, `developers.deriv.com` | 301 / 302 / 302 / 200 |

Two things to note, because both are easy to misread:

1. The 520 carries a `cf-ray` header, so Cloudflare received the request and its
   own connection to the legacy origin failed. Raw TCP 443 succeeds and DNS
   answers. That is why a **browser** reaches the legacy host without trouble —
   the block is not on the client's network, and not on Deriv-wide.
2. The control request in the method probe is a deliberately bogus method name,
   which answers `UnknownMethod`. Every `app_*` method answers exactly that, while
   `balance` answers `AuthorizationRequired`. So `app_*` is absent, not merely
   unauthorised — the distinction is measured, not assumed.

Reproduce:

```
node scripts/deriv-egress-probe.mjs     # every legacy WS host
node scripts/deriv-egress-sweep.mjs     # plain HTTPS status sweep across deriv.com
node scripts/deriv-ws-candidates.mjs    # new vs legacy WebSocket hosts
node scripts/deriv-ws-methods.mjs       # which methods the reachable socket serves
node scripts/deriv-new-api-probe.mjs    # is there an HTTPS applications API
```

Checked from two independent datacenter networks (Supabase Edge and GitHub
Actions `ubuntu-latest`, in `ord`/`iad`/`sea`) with the same result.

## What is possible

`app_update` is also legacy-only, so an existing app cannot be reconfigured
either. What remains is the operator registering an app in the DevHub UI once and
pasting the App ID — which is what the platform does now, and which the admin UI
states plainly rather than implying a token would fix it.

The `POST /api/deriv-app-provisioning/apps` endpoint in `dsites-backend`
(`new-user-interface-main/backend`) still exists and is correct: it calls
`app_register` over WebSocket with per-host fallback and typed errors. It is the
right code for the day a network can reach the legacy host, or for self-hosting on
a network that can. It returns a typed failure today rather than pretending.

Environment variables (server-side only, never `VITE_*` / `NEXT_PUBLIC_*`):

| variable | purpose |
| --- | --- |
| `PLATFORM_ADMIN_TOKEN` | shared secret guarding both routes |
| `DERIV_ADMIN_API_TOKEN` | legacy token with the `admin` scope on a PAT-type app — note this is a **legacy** app model token, separate from the OAuth 2.0 client ID used for end-user login |

Failure codes: `network_blocked` (503) · `invalid_token` · `insufficient_scope` ·
`invalid_application` · `deriv_error` (400) · `timeout` · `socket_error`

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

Per-site **attribution** never required a per-tenant app: Deriv's OAuth 2.0
accepts `t` / `affiliate_token` / `sidi` / `ca`, plus `utm_campaign`,
`utm_medium=affiliate` and `utm_source`. That is stored per site in
`sites.deriv_affiliate_id`.
