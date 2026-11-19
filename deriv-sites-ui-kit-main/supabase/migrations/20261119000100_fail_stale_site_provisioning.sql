-- Recover sites wedged at status = 'provisioning'.
--
-- provision-site-vercel writes 'provisioning' before calling Vercel and only
-- writes 'failed' from its catch block. If the invocation dies without throwing
-- (platform timeout, client disconnect, tab closed mid-request) the catch never
-- runs and the row stays 'provisioning' forever: the wizard's fast path requires
-- 'connected', so every retry takes the slow path and the operator sees a site
-- that never resolves.
--
-- A killed process cannot clean up after itself, so the recovery has to live in
-- the database.

-- 1. Heartbeat integrity -------------------------------------------------------
--
-- Staleness is measured from updated_at. The existing trigger already bumps it on
-- every write, but a writer that supplies its own (stale) value would keep a dead
-- row looking fresh, so force the server clock.

create or replace function public.site_integrations_force_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists force_site_integrations_updated_at on public.site_integrations;

create trigger force_site_integrations_updated_at
  before insert or update on public.site_integrations
  for each row
  execute function public.site_integrations_force_updated_at();

-- 2. Sweeper ------------------------------------------------------------------
--
-- Marks stale rows failed with an operator-readable reason. SECURITY DEFINER so
-- it can run from pg_cron regardless of the caller's role. Returns the site ids
-- it changed so the job output is inspectable.

create or replace function public.fail_stale_site_provisioning(
  stall_interval interval default interval '10 minutes'
)
returns table (site_id uuid, stalled_for interval)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with stale as (
    select si.site_id, now() - si.updated_at as age
    from public.site_integrations si
    where si.status = 'provisioning'
      and si.updated_at < now() - stall_interval
  ), updated as (
    update public.site_integrations si
    set status = 'failed',
        last_error = 'Provisioning stalled: the Vercel attach did not report a '
          || 'result within ' || (stall_interval::text) || '. Retry the claim to '
          || 'start a fresh attempt. No domain was created by the stalled attempt.'
    from stale
    where si.site_id = stale.site_id
      and si.status = 'provisioning'
    returning si.site_id
  )
  select s.site_id, s.age
  from stale s
  join updated u on u.site_id = s.site_id;
end;
$$;

comment on function public.fail_stale_site_provisioning(interval) is
  'Flips site_integrations rows stuck at provisioning past the stall interval to failed. Called by pg_cron.';

-- Not callable by API clients: this mutates rows across all tenants.
revoke all on function public.fail_stale_site_provisioning(interval)
  from public, anon, authenticated;
