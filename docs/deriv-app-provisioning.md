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
