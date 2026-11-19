# Deriv integration: new API only

The platform talks to exactly one Deriv stack: the **new API**.

| concern | endpoint |
| --- | --- |
| Login / sign-up | `https://auth.deriv.com/oauth2/auth` (OAuth 2.0 + PKCE) |
| Token exchange | `https://auth.deriv.com/oauth2/token` |
| API base | `https://api.derivws.com` |

Authentication is `Authorization: Bearer <access_token>` plus a `Deriv-App-ID`
header. Scopes are `trade`, `account_manage`, `application_read`, `payment`.

## Legacy has been removed

Not deprecated — removed. There is no legacy code path left to fall back to:

- No legacy WebSocket client, no `wss://ws.derivws.com`, no
  `wss://ws.binaryws.com`, no `authorize`-over-socket calls.
- `use_legacy_oauth_login` and `include_legacy_app_id_in_oauth` are gone from
  `site_deriv_apps`, and their two admin toggles are gone from the UI.
- `platform_deriv_apps.legacy_app_id` is gone, so there is no numeric app ID
  concept anywhere.
- No legacy OAuth host, no numeric-only app ID handling.

Migration `20261119000800_remove_legacy_deriv_surfaces.sql` drops the columns.
All three were always written as `false`/`null`, so no site changed behaviour.

## What is not available, and why

`app_register`, `app_list`, `app_update`, `app_delete` and `app_markup_details`
exist **only** on the legacy stack. The new platform has no equivalent:

| check | result |
| --- | --- |
| legacy WS hosts (`ws.derivws.com`, `ws.binaryws.com`) | Cloudflare **520** to server networks |
| new WS (`api.derivws.com/trading/v1/options/ws/public`) | reachable — serves market data and trading |
| …`app_list` / `app_register` / `app_update` / `app_get` | `UnknownMethod` — not routed |
| …`balance` (control) | `AuthorizationRequired` — routed, gated by auth |
| new REST `/applications…` (7 variants) | **404** |
| new REST `/trading/v1/options/accounts` | **401** — real route |

The `UnknownMethod` result matches what a deliberately bogus method name returns,
while `balance` returns `AuthorizationRequired`. So the application methods are
**absent**, not merely unauthorised.

This is also not a token-scope problem. There is no `admin` scope on a new OAuth
2.0 app; `admin` belongs to the legacy app model. Asking an operator to "tick
Admin" is wrong advice, and the UI no longer gives it.

### Consequence

Creating apps is a manual step in the Deriv dashboard: register the application
at `developers.deriv.com`, then add its App ID under **Admin → Deriv Pool → Add
app**. The affected actions return `503` with an explanatory message instead of
pretending or failing obscurely:

| action | response |
| --- | --- |
| `auto_generate_app` | `deriv_app_registration_unavailable` |
| `auto_generate_tier_pool` | `deriv_app_registration_unavailable` |
| `register_site_deriv_app` | `deriv_app_registration_unavailable` |
| `import_deriv_apps` | `deriv_app_list_unavailable` |
| `sync_commissions` | `deriv_markup_reporting_unavailable` |

`upsert_pool_app` still works — it stores an App ID the operator obtained
manually. Sending `syncToDeriv: true` is accepted but returns
`syncWarning`, because the app cannot be pushed to Deriv.

## One app can serve several sites

Because per-tenant apps cannot be created, `bind_platform_deriv_app_to_site()`
allows one app to serve several sites and reports `sharedApp: true`.

**Accepted cost:** Deriv tracks markup per app, so per-site markup totals are not
separable. Per-site values stay recorded per row
(`sites.requested_markup_rate`, `sites.platform_fee_rate`,
`sites.deriv_affiliate_id`), and attribution keeps flowing from real trader
account activity via `deriv-trader-accounts` → `site_trader_attributions`.

Per-site **attribution** never needed a per-tenant app: OAuth sign-up accepts
`t` / `affiliate_token` / `sidi` / `ca` plus `utm_campaign`,
`utm_medium=affiliate` and `utm_source`. That is stored in
`sites.deriv_affiliate_id`.

## Redirect URI: why it cannot be read or set through the API

Confirmed against Deriv's own published spec, not inferred:

- `schemas/rest-api-openapi.json` from
  [deriv-com/deriv-api-schemas](https://github.com/deriv-com/deriv-api-schemas)
  is the full third-party REST surface. The **only** `/applications` route is
  `GET /applications/v1/markup-statistics`, which needs `application_read`.
  There is no list, no get, no update.
- The string `redirect` does not appear anywhere in that spec.

So `application_read` ("read-only access to your registered applications")
does not expose the registered redirect URI, and no API can change it. The
registration lives only in the dashboard at `developers.deriv.com`, and **every
URI that may be sent must be registered individually — subdirectories do not
inherit**, per Deriv's OAuth guide:

> If you have given a URL like https://abc.com but your redirect URL is
> https://abc.com/callback, the flow will fail. Every subdirectory must be
> registered separately.

Deriv also validates `redirect_uri` only **after the user signs in**, which is
why neither the authorize page nor the token endpoint can be probed for it:

| probe | result |
| --- | --- |
| `GET /oauth2/auth` with valid / tenant / bogus URI | identical 246415-byte SPA shell |
| `POST /oauth2/token` with a bogus code, any URI | `invalid_grant … not_found` — code is checked first |

The one conclusive check is a real login, so the platform records the verdict
instead of guessing:

- `deriv-oauth-callback` writes Deriv's own `error` / `error_description` to
  `deriv_oauth_transactions` (`deriv_error_code`, `deriv_error_message`,
  `resolved_at`) — migration `20261119001000`.
- The action `check_deriv_application_callback` reads the latest attempt back
  and reports `registered` / `not_registered` / `unverified`, surfaced in the
  Admin card "Tenant login callbacks" as a **Verify** button.
- A `redirect_uri` rejection now returns `auth_error=redirect_uri_not_registered`
  to the tenant instead of the generic `token_exchange_failed`.

### A listed redirect URL is not automatically an accepted one

Observed on the new developer portal's app editor (screenshot, 2026-11-19). The
"Redirect URLs" card carries a **Pending** badge and a **Verify domains** action,
and every entry has a status dot:

| dot | entry |
| --- | --- |
| amber | `https://traderspulse.site/callback` |
| amber | `https://www.traderspulse.site/callback` |
| red | `https://tradepulse-lovat.vercel.app/` |
| red | `https://dtrader-254.vercel.app/api/deriv-oauth-callback` |
| red | `https://clinchyderiv1.vercel.app/api/deriv-oauth-callback` |
| red | `https://dsites-admin.vercel.app/api/deriv-oauth-callback` |

The three values we send are listed **byte for byte**, so the login failure is
not a string mismatch: the app is *Pending* and those URLs are unverified. Adding
a URL is therefore only half the step — each domain has to pass **Verify
domains** before Deriv honours it, and until then the authorize request is
rejected with the misleading `invalid_request … does not match any of the
OAuth 2.0 Client's pre-registered redirect urls`.

**These tenant hosts are a single-page app with a catch-all rewrite**, which rules
out Deriv's "upload an HTML file" verification method: a request for
`/anything.html` returns `index.html` (200, `text/html`, 4353 bytes), not a 404.
The rewrite excludes only `/api/` and `/site.config.json`. So on `*.vercel.app`
domains the workable method is DNS TXT, and that is impossible for a `vercel.app`
subdomain because Vercel owns it — meaning verification needs a domain the
operator actually controls. Also note `www` must be listed and verified
separately: `www.traderspulse.site` is a distinct entry in the dashboard.

Practical consequence for the platform: the operator cannot finish this from the
admin app, so the tenant site now explains the failure instead of going quiet.
`new-user-interface-main` reads `auth_error` from the callback redirect and shows
a dismissible notice, with `redirect_uri_not_registered` worded as a site
configuration problem rather than trader error. Nothing previously read that
parameter, so a rejected login was indistinguishable from "not logged in".

## Two behaviours the guide pins down, now implemented

1. **Sign-up needs `prompt=registration`.** Without it Deriv shows the login
   form. The tenant header's "Sign up" button already passed it, but the value
   was dropped in `generateOAuthURL` and never reached the server;
   `deriv-oauth-start` now forwards it (and ignores any other value).
2. **There is no refresh token.** The token response has no `refresh_token`,
   and `grant_type=refresh_token` never returns one. The trader session now
   lasts exactly the access token's `expires_in`, and an expired token reports
   `session_expired` so the client re-runs authorization, instead of attempting
   an exchange that can only fail. (Seven copies of that dead branch removed.)

Partner attribution (`t`, `utm_source`, `utm_medium`, `utm_campaign`) is sent
only on sign-up, and only one tracking-token alias is ever used.

## Reading Deriv's answer correctly

A refused login was being reported as a cancellation, which made a real failure
look like the visitor closing the window. The callback received
`error=request_forbidden` and returned `auth_error=login_cancelled`, because every
Deriv error was mapped to the cancellation code unconditionally.

The rule now applied, in both the callback and the admin preflight:

| Deriv's `error` | Meaning | Reported as |
| --- | --- | --- |
| absent | authorization succeeded | the login proceeds |
| `access_denied`, `user_cancelled`, `login_cancelled` | the visitor declined or closed the page | `login_cancelled` |
| `invalid_grant`, `invalid_client` | the token endpoint was reached, so `redirect_uri` was never the objection | accepted |
| anything else, including `request_forbidden`, `invalid_request` | Deriv refused the request before issuing a code | passed through verbatim |

`request_forbidden` is not documented by Deriv, so it is reported as "refused
before issuing a code" with Deriv's own description attached, and not given an
invented cause. The audit row and the transaction both keep the code and the
description, so a later reading does not depend on this table being right.

`classifyAttempt` returns `accepted` / `denied` / `cancelled` for the Verify
action. `cancelled` deliberately reports nothing about the redirect URI rather
than counting as a rejection, because a visitor who closes the page produced no
evidence either way.
