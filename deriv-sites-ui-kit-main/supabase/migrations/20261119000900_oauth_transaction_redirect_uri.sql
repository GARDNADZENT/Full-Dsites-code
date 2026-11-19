-- Use one canonical redirect URI for a tenant's Deriv login.
--
-- Both the authorize request and the token exchange must send the exact
-- redirect_uri that is pre-registered on the OAuth 2.0 client. `deriv-oauth-start`
-- sent `deriv_applications.callback_uri` while `deriv-oauth-callback` sent the
-- same column again at exchange time, so a later edit to one app row silently
-- invalidated every in-flight login with:
--
--   invalid_request: The 'redirect_uri' parameter does not match any of the
--   OAuth 2.0 Client's pre-registered redirect urls
--
-- Deriv answered at its own /dashboard/error page, before ever reaching our
-- callback, which is why nothing appeared in the transaction state.
--
-- The redirect URI now lives on the OAuth transaction that owns the login. It
-- defaults to the existing `callback_uri`, so the migration is behaviour
-- preserving for every row that already exists, and it becomes a hard record of
-- what was sent even if the app row changes mid-flight.

alter table public.deriv_oauth_transactions
  add column if not exists redirect_uri text;

-- Backfill from the app these transactions already point at, so an in-flight
-- login created just before this migration still exchanges with the same URI it
-- sent to Deriv.
update public.deriv_oauth_transactions t
set redirect_uri = a.callback_uri
from public.deriv_applications a
where a.id = t.deriv_application_id
  and t.redirect_uri is null;

-- No row is allowed to reach the exchange step without it. Existing rows are
-- all backfilled above; the column default covers the window between insert and
-- a deploy that sets it explicitly.
alter table public.deriv_oauth_transactions
  alter column redirect_uri set not null;

comment on column public.deriv_oauth_transactions.redirect_uri is
  'Exact redirect_uri sent to Deriv on the authorize request. The token exchange must repeat this value byte for byte.';
