-- Schedule the stale-provisioning sweeper.
--
-- pg_cron is available on this project but was not installed. Enabling it turns
-- on a background worker at the account level, so this is split from the function
-- definition: the function is useful on its own (and can be called manually),
-- while this migration is the part that needs cron.

create extension if not exists pg_cron with schema extensions;

-- Every 10 minutes, matching PROVISIONING_STALL_MINUTES in src/lib/site-status.ts.
-- Overlap is impossible in practice (the sweep is a single UPDATE), but the job
-- is idempotent regardless: it only touches rows still in 'provisioning'.
select cron.schedule(
  'fail-stale-site-provisioning',
  '*/10 * * * *',
  $$select public.fail_stale_site_provisioning(interval '10 minutes');$$
);
