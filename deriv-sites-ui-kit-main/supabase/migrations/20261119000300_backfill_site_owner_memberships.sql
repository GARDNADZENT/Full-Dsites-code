-- Ensure every site owner can read their own site's data.
--
-- RLS on site_commission_ledger (and other tenant tables) grants reads to
-- organisation members via is_organisation_member(organisation_id, auth.uid()).
-- Creating a site calls create_personal_organisation(), which is meant to make the
-- caller a tenant_owner of that organisation — but two live sites have an
-- organisation_id with no matching organisation_members row, so their owners
-- cannot read their own commission ledger, domain rows, or anything else scoped
-- by membership.
--
-- That silently breaks the Commissions and Payouts views for exactly the users
-- they are for.

-- 1. Repair existing gaps -------------------------------------------------------
--
-- Insert a tenant_owner membership for each site whose owner is not already a
-- member of that site's organisation. `on conflict do nothing` makes this safe to
-- re-run and leaves any existing membership untouched.
--
-- Sites with a NULL organisation_id are skipped: membership is meaningless until
-- they are attached to an organisation, and a NULL row would be a lie.

insert into public.organisation_members (organisation_id, user_id, role, status)
select s.organisation_id, s.user_id, 'tenant_owner'::platform_role, 'active'
from public.sites s
where s.organisation_id is not null
  and s.user_id is not null
  and s.status <> 'deleted'
  and not exists (
    select 1
    from public.organisation_members om
    where om.organisation_id = s.organisation_id
      and om.user_id = s.user_id
  )
on conflict (organisation_id, user_id) do nothing;

-- 2. Prevent recurrence ---------------------------------------------------------
--
-- A trigger rather than a fix inside create_personal_organisation, because the
-- invariant is about the site: whoever owns a site must be able to read data
-- scoped to that site's organisation, no matter which code path created it.

create or replace function public.ensure_site_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.organisation_id is not null and new.user_id is not null then
    insert into public.organisation_members (organisation_id, user_id, role, status)
    values (new.organisation_id, new.user_id, 'tenant_owner'::platform_role, 'active')
    on conflict (organisation_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

comment on function public.ensure_site_owner_membership() is
  'Guarantees the site owner is a tenant_owner of the site organisation, so RLS grants them access to their own data.';

drop trigger if exists ensure_site_owner_membership_on_insert on public.sites;

create trigger ensure_site_owner_membership_on_insert
  after insert or update of organisation_id, user_id on public.sites
  for each row
  execute function public.ensure_site_owner_membership();
