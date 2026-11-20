-- Distinguish simulated commission rows from real ones.
--
-- The platform has no writer for site_commission_ledger, and Deriv's new API
-- cannot report actual earned markup (app_markup_details and
-- app_markup_details-style reporting were legacy-only). So there is currently no
-- way to observe the commission split working except to simulate it.
--
-- A simulation must never be mistaken for money owed. Two independent guards:
--
--  1. `is_simulated` is a column on the row, default false, so every existing
--     and future real row is unambiguous.
--  2. Simulated rows are written with payout_status = 'simulated', which is a new
--     value the accrual/approval flow does not recognise. mark_payout only
--     touches 'accrued' and 'approved', so a simulated row can never be marked
--     paid by accident, even if the flag were ever ignored.
--
-- The check constraint is replaced rather than extended blind: the original set
-- is restated so this migration is safe to re-run.

alter table public.site_commission_ledger
  add column if not exists is_simulated boolean not null default false;

comment on column public.site_commission_ledger.is_simulated is
  'True when the row came from the commission simulator, not from Deriv. Simulated rows are arithmetic only: no money was earned and none is owed.';

alter table public.site_commission_ledger
  drop constraint if exists site_commission_ledger_payout_status_check;

alter table public.site_commission_ledger
  add constraint site_commission_ledger_payout_status_check
  check (payout_status in ('accrued', 'approved', 'paid', 'simulated'));

-- Keep the two signals consistent in both directions.
alter table public.site_commission_ledger
  drop constraint if exists site_commission_ledger_simulated_payout_check;

alter table public.site_commission_ledger
  add constraint site_commission_ledger_simulated_payout_check
  check (
    (is_simulated = true and payout_status = 'simulated')
    or (is_simulated = false and payout_status in ('accrued', 'approved', 'paid'))
  );

create index if not exists idx_site_commission_ledger_simulated
  on public.site_commission_ledger (is_simulated, traded_at desc);

-- Simulated contract ids must be unique per app, and the existing
-- UNIQUE (deriv_app_id, external_transaction_id) already covers that, so a
-- repeated simulation run cannot silently double-count.
