-- Real demo trades, recorded per tenant.
--
-- The simulation wrote rows with is_simulated = true. Now a trade can actually
-- happen: a trader session places a real contract on a Deriv DEMO account, and
-- the result is recorded here. That needs two distinctions the table did not
-- have, because "a real trade happened" and "Deriv reported the markup" and
-- "this is real money owed" are three different things.
--
--   account_type  -- 'demo' or 'real'. A demo trade is real trading activity but
--                    it is not money: nobody earned and nobody is owed. Without
--                    this column a demo contract would look payable.
--
--   markup_basis  -- where the gross markup figure came from:
--                      'deriv_reported' -- Deriv told us the amount.
--                      'allocated'      -- a real trade, but the amount is our
--                                          allocation: Deriv's published formula
--                                          applied to the real contract payout at
--                                          the site's configured rate. Deriv pays
--                                          app markup per application, and both
--                                          tenants currently share one app, so
--                                          Deriv cannot attribute it per tenant.
--                      'computed'       -- purely hypothetical (the simulator).
--
-- Being explicit about 'allocated' matters: it is the difference between "this is
-- what Deriv paid this tenant" and "this is what we are attributing to this
-- tenant". Silently treating the second as the first would misstate earnings.
--
-- payout_status gains 'demo'. mark_payout only touches 'accrued' and 'approved',
-- so neither simulated nor demo rows can ever be marked paid.

alter table public.site_commission_ledger
  add column if not exists account_type text not null default 'demo',
  add column if not exists markup_basis text not null default 'allocated';

-- Existing rows are all simulator output.
update public.site_commission_ledger
   set account_type = 'demo',
       markup_basis = 'computed'
 where is_simulated = true
   and markup_basis <> 'computed';

alter table public.site_commission_ledger
  drop constraint if exists site_commission_ledger_account_type_check;
alter table public.site_commission_ledger
  add constraint site_commission_ledger_account_type_check
  check (account_type in ('demo', 'real'));

alter table public.site_commission_ledger
  drop constraint if exists site_commission_ledger_markup_basis_check;
alter table public.site_commission_ledger
  add constraint site_commission_ledger_markup_basis_check
  check (markup_basis in ('deriv_reported', 'allocated', 'computed'));

alter table public.site_commission_ledger
  drop constraint if exists site_commission_ledger_payout_status_check;
alter table public.site_commission_ledger
  add constraint site_commission_ledger_payout_status_check
  check (payout_status in ('accrued', 'approved', 'paid', 'simulated', 'demo'));

-- Restated so the three states cannot drift apart, in either direction.
alter table public.site_commission_ledger
  drop constraint if exists site_commission_ledger_simulated_payout_check;
alter table public.site_commission_ledger
  add constraint site_commission_ledger_simulated_payout_check
  check (
    (is_simulated = true and payout_status = 'simulated' and markup_basis = 'computed')
    or (
      is_simulated = false and account_type = 'demo' and payout_status = 'demo'
      and markup_basis in ('allocated', 'deriv_reported')
    )
    or (
      is_simulated = false and account_type = 'real'
      and payout_status in ('accrued', 'approved', 'paid')
      and markup_basis in ('allocated', 'deriv_reported')
    )
  );

comment on column public.site_commission_ledger.account_type is
  'demo or real. A demo row is genuine trading activity on a virtual account: nothing was earned and nothing is owed, so it is never payable.';
comment on column public.site_commission_ledger.markup_basis is
  'deriv_reported = Deriv supplied the markup; allocated = real trade with the amount computed at the site rate because Deriv cannot attribute a shared app per tenant; computed = hypothetical simulation.';

create index if not exists idx_site_commission_ledger_account_type
  on public.site_commission_ledger (account_type, traded_at desc);
