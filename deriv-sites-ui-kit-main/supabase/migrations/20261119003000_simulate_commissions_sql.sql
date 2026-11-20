-- Commission simulation, implemented in the database.
--
-- Why this lives in Postgres rather than in an edge function:
--
--   * The ledger had no writer at all, and Deriv's current API cannot report
--     earned app markup (app_markup_details was legacy-only), so the only way to
--     watch the commission split work is to compute it from Deriv's published
--     formula and record it.
--   * Writing rows is the point of the exercise. Doing the arithmetic here keeps
--     the formula and the insert in one transaction, so a partial run cannot
--     leave half a simulation behind, and the numbers in the ledger are always
--     reproducible by re-reading its own raw_payload.
--   * It is small. The equivalent edge-function action required rewriting a
--     65 KB function body to deploy, which is exactly how the previous two
--     deploy attempts were corrupted.
--
-- The formula is Deriv's, verbatim from API Terms §4.3.3 (vR26|03):
--
--   gross = payout × markup% / 100,  and any gross below one cent is truncated
--   to zero. Truncated, not rounded — Deriv pays nothing on a trade whose markup
--   is less than the smallest unit of the account currency.
--
-- We work in integer cents throughout so the truncation boundary is exact
-- rather than at the mercy of float arithmetic.
--
-- The split on top of gross is this console's own model, not Deriv's:
--
--   platform_fee = round(gross × platform_fee_rate / 100)
--   owner_net    = gross - platform_fee            (remainder, so halves sum)
--
-- Every row written is is_simulated = true and payout_status = 'simulated',
-- which the table's check constraint ties together in both directions and
-- mark_payout ignores. Simulated money can never be paid out.
--
-- Per-tenant margins are passed in as a run parameter. They are deliberately NOT
-- written to sites.requested_markup_rate or site_deriv_apps.markup_percentage:
-- a simulation must not change what a live tenant actually charges.

-- ---------------------------------------------------------------------------
-- The per-trade split, as a scalar function so it can be reused and tested.
-- ---------------------------------------------------------------------------
create or replace function public.simulate_commission_split(
  _payout numeric,
  _markup_rate numeric,
  _platform_fee_rate numeric
)
returns table (
  raw_gross_cents numeric,
  gross_cents integer,
  fee_cents integer,
  owner_cents integer,
  truncated_to_zero boolean
)
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  payout_cents integer;
  raw_gross numeric;
  gross integer;
  fee integer;
begin
  if _payout is null or _payout < 0 then
    raise exception 'payout must be zero or positive';
  end if;
  if _markup_rate is null or _markup_rate < 0 then
    raise exception 'markup rate must be zero or positive';
  end if;
  if _platform_fee_rate is null or _platform_fee_rate < 0 or _platform_fee_rate > 100 then
    raise exception 'platform fee rate must be between 0 and 100';
  end if;

  -- Payout to integer cents first, so the rate is applied to a real money amount.
  payout_cents := round(_payout * 100);
  raw_gross := payout_cents * (_markup_rate / 100.0);

  -- Deriv's truncation rule: below one cent, no markup is paid at all.
  if raw_gross < 1 then
    gross := 0;
  else
    gross := round(raw_gross)::integer;
  end if;

  fee := round(gross * (_platform_fee_rate / 100.0))::integer;

  return query select
    round(raw_gross, 4),
    gross,
    fee,
    gross - fee,
    (raw_gross < 1);
end;
$function$;

comment on function public.simulate_commission_split(numeric, numeric, numeric) is
  'Deriv API Terms §4.3.3 app markup for one trade: payout × markup%, truncated to zero below 0.01. Then this console''s platform fee split. All amounts in USD cents.';

-- ---------------------------------------------------------------------------
-- The simulation run: discover tenants, optionally spread their margins, write
-- the ledger rows, and return per-tenant totals.
-- ---------------------------------------------------------------------------
create or replace function public.simulate_commissions(
  _run_id text default null,
  _site_ids uuid[] default null,
  _trades_per_site integer default 5,
  _payout_min numeric default 10,
  _payout_max numeric default 200,
  _margin_spread boolean default true,
  _base_rate numeric default 1.0,
  _rate_step numeric default 1.0
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_run_id text;
  v_target record;
  v_site record;
  v_total_sites integer := 0;
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_ordinal integer := 0;
  v_rate numeric;
  v_fee_rate numeric;
  v_trades jsonb := '[]'::jsonb;
  v_totals jsonb := '[]'::jsonb;
  v_payout numeric;
  v_split record;
  v_contract_id text;
  v_loginid text;
  v_traded_at timestamptz;
  v_gross_total numeric;
  v_fee_total numeric;
  v_owner_total numeric;
  v_payout_total numeric;
  v_truncated integer;
begin
  -- Finance-level access, and explicitly read-only roles must not write rows.
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not public.has_platform_permission(v_uid, 'finance.read') then
    raise exception 'not authorised to simulate commissions' using errcode = '42501';
  end if;

  if _trades_per_site is null or _trades_per_site < 1 or _trades_per_site > 50 then
    raise exception 'trades per site must be between 1 and 50';
  end if;
  if _payout_min is null or _payout_min <= 0 or _payout_max is null or _payout_max < _payout_min then
    raise exception 'payout range is invalid';
  end if;
  if _base_rate is null or _base_rate < 0 or _rate_step is null then
    raise exception 'markup rates are invalid';
  end if;

  -- A run id makes the run reproducible: the same id produces the same contract
  -- ids, so a re-run collides on UNIQUE(deriv_app_id, external_transaction_id)
  -- instead of double counting. Two distinct sites can share an app id, so the
  -- contract id carries the site too.
  v_run_id := coalesce(nullif(btrim(_run_id), ''), to_char(now(), 'YYYYMMDDHH24MISS'));

  -- Only active tenants with a real Deriv app can be traded through. Deleted or
  -- app-less sites are skipped rather than rejected, so one bad tenant does not
  -- block a whole portfolio run.
  for v_site in
    select
      s.id,
      s.name,
      s.organisation_id,
      s.platform_deriv_app_id,
      s.platform_fee_rate,
      s.requested_markup_rate,
      coalesce(sda.deriv_app_id, pda.app_id) as deriv_app_id
    from public.sites s
    left join public.platform_deriv_apps pda on pda.id = s.platform_deriv_app_id
    left join lateral (
      select x.deriv_app_id from public.site_deriv_apps x
      where x.site_id = s.id and x.deriv_app_id is not null
      order by x.id limit 1
    ) sda on true
    where s.status = 'active'
      and coalesce(sda.deriv_app_id, pda.app_id) is not null
      and (_site_ids is null or s.id = any(_site_ids))
    order by s.name, s.id
  loop
    v_total_sites := v_total_sites + 1;
    v_ordinal := v_ordinal + 1;

    -- Per-tenant margin. The spread is the point: each tenant trades the same
    -- payouts at a different markup so the per-tenant difference is visible.
    -- It is a run parameter only and is never written back to the site.
    if _margin_spread then
      v_rate := round(least(5.0, greatest(0.0, _base_rate + (v_ordinal - 1) * _rate_step))::numeric, 2);
    else
      v_rate := coalesce(v_site.requested_markup_rate, _base_rate);
    end if;

    v_fee_rate := coalesce(v_site.platform_fee_rate, 17.00);

    v_gross_total := 0;
    v_fee_total := 0;
    v_owner_total := 0;
    v_payout_total := 0;
    v_truncated := 0;

    for i in 1.._trades_per_site loop
      -- Deterministic per (run, site, trade) payout in the requested range.
      v_payout := round(
        _payout_min + (
          (abs(hashtext(v_run_id || ':' || v_site.id::text || ':' || i::text)) % 100000)::numeric
          / 100000.0
        ) * (_payout_max - _payout_min), 2);

      select * into v_split from public.simulate_commission_split(v_payout, v_rate, v_fee_rate);

      v_contract_id := format(
        'SIM-%s-%s-%s',
        v_run_id,
        left(replace(v_site.id::text, '-', ''), 8),
        i
      );
      v_loginid := 'SIM' || lpad(i::text, 3, '0') || upper(left(regexp_replace(v_site.name, '[^A-Za-z0-9]', '', 'g'), 3));

      -- Spread the trades back over the last day so the panel's date ordering
      -- has something meaningful to sort on.
      v_traded_at := now() - make_interval(secs => (i * 137));

      insert into public.site_commission_ledger (
        external_transaction_id,
        deriv_app_id,
        platform_deriv_app_id,
        site_id,
        organisation_id,
        client_loginid,
        contract_id,
        currency,
        gross_markup_amount,
        applied_markup_rate,
        platform_fee_rate,
        superuser_fee_amount,
        owner_net_amount,
        attribution_status,
        payout_status,
        is_simulated,
        traded_at,
        raw_payload,
        synchronized_at
      ) values (
        v_contract_id,
        v_site.deriv_app_id,
        v_site.platform_deriv_app_id,
        v_site.id,
        v_site.organisation_id,
        v_loginid,
        v_contract_id,
        'USD',
        v_split.gross_cents / 100.0,
        v_rate,
        v_fee_rate,
        v_split.fee_cents / 100.0,
        v_split.owner_cents / 100.0,
        'attributed',
        'simulated',
        true,
        v_traded_at,
        jsonb_build_object(
          'simulated', true,
          'runId', v_run_id,
          'basis', 'payout',
          'formula', 'payout * markup% / 100, truncated to zero below 0.01 (Deriv API Terms 4.3.3)',
          'payout', v_payout,
          'markupRate', v_rate,
          'platformFeeRate', v_fee_rate,
          'rawGrossCents', v_split.raw_gross_cents,
          'grossCents', v_split.gross_cents,
          'feeCents', v_split.fee_cents,
          'ownerCents', v_split.owner_cents,
          'truncatedToZero', v_split.truncated_to_zero
        ),
        now()
      )
      on conflict (deriv_app_id, external_transaction_id) do nothing;

      if found then
        v_inserted := v_inserted + 1;
      else
        v_skipped := v_skipped + 1;
      end if;

      if v_split.truncated_to_zero then
        v_truncated := v_truncated + 1;
      end if;

      v_payout_total := v_payout_total + v_payout;
      v_gross_total := v_gross_total + (v_split.gross_cents / 100.0);
      v_fee_total := v_fee_total + (v_split.fee_cents / 100.0);
      v_owner_total := v_owner_total + (v_split.owner_cents / 100.0);

      v_trades := v_trades || jsonb_build_object(
        'siteId', v_site.id,
        'siteName', v_site.name,
        'contractId', v_contract_id,
        'payout', v_payout,
        'markupRate', v_rate,
        'gross', v_split.gross_cents / 100.0,
        'fee', v_split.fee_cents / 100.0,
        'ownerNet', v_split.owner_cents / 100.0,
        'truncatedToZero', v_split.truncated_to_zero
      );
    end loop;

    v_totals := v_totals || jsonb_build_object(
      'siteId', v_site.id,
      'siteName', v_site.name,
      'markupRate', v_rate,
      'platformFeeRate', v_fee_rate,
      'trades', _trades_per_site,
      'truncatedTrades', v_truncated,
      'payoutTotal', v_payout_total,
      'grossTotal', v_gross_total,
      'feeTotal', v_fee_total,
      'ownerTotal', v_owner_total
    );
  end loop;

  if v_total_sites = 0 then
    raise exception 'no active tenant has a Deriv app id, so there is nothing to simulate';
  end if;

  return jsonb_build_object(
    'runId', v_run_id,
    'inserted', v_inserted,
    'skipped', v_skipped,
    'basis', 'payout',
    'formula', 'payout * markup% / 100, truncated to zero below 0.01 (Deriv API Terms 4.3.3)',
    'sites', v_totals,
    'trades', v_trades
  );
end;
$function$;

comment on function public.simulate_commissions(text, uuid[], integer, numeric, numeric, boolean, numeric, numeric) is
  'Writes is_simulated commission rows to site_commission_ledger using Deriv''s own payout-based markup formula. Per-tenant margins are run parameters and are never written back to site config.';

grant execute on function public.simulate_commission_split(numeric, numeric, numeric) to authenticated;
grant execute on function public.simulate_commissions(text, uuid[], integer, numeric, numeric, boolean, numeric, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- Per-tenant totals over whatever is already in the ledger, real or simulated.
-- The admin panel reads this instead of aggregating in the browser.
-- ---------------------------------------------------------------------------
create or replace function public.commission_ledger_totals(
  _is_simulated boolean default null,
  _run_id text default null
)
returns table (
  site_id uuid,
  site_name text,
  is_simulated boolean,
  trades bigint,
  truncated_trades bigint,
  gross_total numeric,
  fee_total numeric,
  owner_total numeric
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    l.site_id,
    coalesce(s.name, 'unknown site') as site_name,
    l.is_simulated,
    count(*) as trades,
    count(*) filter (where (l.raw_payload ->> 'truncatedToZero')::boolean is true) as truncated_trades,
    round(sum(l.gross_markup_amount), 2) as gross_total,
    round(sum(l.superuser_fee_amount), 2) as fee_total,
    round(sum(l.owner_net_amount), 2) as owner_total
  from public.site_commission_ledger l
  left join public.sites s on s.id = l.site_id
  where auth.uid() is not null
    and public.has_platform_permission(auth.uid(), 'finance.read')
    and (_is_simulated is null or l.is_simulated = _is_simulated)
    and (_run_id is null or l.raw_payload ->> 'runId' = _run_id)
  group by l.site_id, s.name, l.is_simulated
  order by owner_total desc nulls last;
$function$;

grant execute on function public.commission_ledger_totals(boolean, text) to authenticated;
