-- Record what Deriv actually said about a login attempt.
--
-- Deriv validates redirect_uri after the user signs in, so the only conclusive
-- signal that a redirect URI is registered comes from completing the flow. The
-- callback used to discard Deriv's error code and message, which made a
-- redirect-URI mismatch indistinguishable from an expired code, and left the
-- operator with a generic "token_exchange_failed" and no way to tell whether the
-- registration or the platform was at fault.
--
-- The callback now stores Deriv's own code and description here, and the admin
-- preflight reads them back to answer "is this redirect URI registered?".
--
-- Codes that matter:
--   NULL          the exchange succeeded, so the redirect URI was accepted
--   invalid_request with a pre-registered-redirect-url description
--                 the redirect URI is not registered on the OAuth client
--   invalid_grant the code was unknown or already used, which means Deriv got
--                 past redirect_uri validation
--
-- resolved_at marks any attempt that reached a verdict, either way.

alter table public.deriv_oauth_transactions
  add column if not exists deriv_error_code text,
  add column if not exists deriv_error_message text,
  add column if not exists resolved_at timestamptz;

comment on column public.deriv_oauth_transactions.deriv_error_code is
  'Deriv OAuth error code recorded when the token exchange failed. NULL means the exchange succeeded.';
comment on column public.deriv_oauth_transactions.deriv_error_message is
  'Deriv error_description for a failed exchange, truncated to 500 characters.';
comment on column public.deriv_oauth_transactions.resolved_at is
  'When the attempt reached a verdict: success or a recorded Deriv error.';

-- The admin preflight reads the most recent attempt per site.
create index if not exists deriv_oauth_transactions_site_recent_idx
  on public.deriv_oauth_transactions (site_id, created_at desc);

-- Backfill: attempts that were consumed by a successful exchange before this
-- column existed are successes. Unconsumed rows stay NULL, which the preflight
-- reports as "unverified" rather than a failure.
update public.deriv_oauth_transactions
set resolved_at = consumed_at
where resolved_at is null
  and consumed_at is not null;
