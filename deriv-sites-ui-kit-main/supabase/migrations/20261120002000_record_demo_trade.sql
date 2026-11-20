-- Record a real demo trade in the commission ledger.
--
-- The trade itself has already happened on Deriv by the time this is called: a
-- contract exists on the account with a real contract id. This function only
-- writes what Deriv returned, so that it is visible per tenant.
--
-- Everything about the amount is 'allocated', not 'deriv_reported':
--
--   Both active tenants are bound to the same Deriv app (33MsUFUfuukH8nJjySUAA),
--   and Deriv pays app markup per application. So Deriv cannot say which tenant
--   a contract belonged to, and it cannot report a per-tenant figure. The amount
--   here is Deriv's published rule (API Terms 4.3.3) applied to the payout Deriv
--   actually quoted for this contract, at this site's own configured rate.
--
--   That is a genuine computation over a genuine trade, but it is our
--   attribution, not Deriv's record. The column says so, and the UI must too.
--
-- The row is written as account_type 'demo' and payout_status 'demo'. The table's
-- check constraint ties those together with is_simulated = false, and mark_payout
-- only ever touches 'accrued'/'approved', so a demo trade can never be paid out.

create or replace function public.record_demo_trade(
  _site_id uuid,
  _contract_id text,
  _client_loginid text,
  _currency text,
  _symbol text,
  _contract_type text,
  _stake numeric,
  _payout numeric,
  _run_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_site record;
  v_rate numeric;
  v_fee_rate numeric;
  v_split record;
  v_ledger_id uuid;
  v_gross numeric;
  v_fee numeric;
  v_owner numeric;
begin
  if _contract_id is null or btrim(_contract_id) = '' then
    raise exception 'contract id is required';
  end if;
  if _payout is null or _payout < 0 then
    raise exception 'payout must be zero or positive';
  end if;

  select s.id, s.name, s.organisation_id, s.platform_deriv_app_id,
         s.platform_fee_rate, s.requested_markup_rate
    into v_site
    from public.sites s
   where s.id = _site_id;
  if not found then
    raise exception 'site not found';
  end if;

  -- Which Deriv app did this contract run through? Deriv's own app for the site
  -- if one is bound, else the platform pool app.
  declare
    v_app_id text;
  begin
    select coalesce(sda.deriv_app_id, pda.app_id)
      into v_app_id
      from public.sites s
      left join public.platform_deriv_apps pda on pda.id = s.platform_deriv_app_id
      left join lateral (
        select x.deriv_app_id from public.site_deriv_apps x
        where x.site_id = s.id and x.deriv_app_id is not null
        order by x.id limit 1
      ) sda on true
     where s.id = _site_id;

    if v_app_id is null then
      raise exception 'site has no Deriv app to attribute the contract to';
    end if;

    v_rate := coalesce(v_site.requested_markup_rate, 0);
    v_fee_rate := coalesce(v_site.platform_fee_rate, 17.00);

    select * into v_split from public.simulate_commission_split(_payout, v_rate, v_fee_rate);

    v_gross := v_split.gross_cents / 100.0;
    v_fee := v_split.fee_cents / 100.0;
    v_owner := v_split.owner_cents / 100.0;

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
      account_type,
      markup_basis,
      traded_at,
      raw_payload,
      synchronized_at
    ) values (
      _contract_id,
      v_app_id,
      v_site.platform_deriv_app_id,
      _site_id,
      v_site.organisation_id,
      _client_loginid,
      _contract_id,
      upper(coalesce(_currency, 'USD')),
      v_gross,
      v_rate,
      v_fee_rate,
      v_fee,
      v_owner,
      'attributed',
      'demo',
      false,
      'demo',
      'allocated',
      now(),
      jsonb_build_object(
        'simulated', false,
        'source', 'deriv_demo_contract',
        'contractId', _contract_id,
        'accountId', _client_loginid,
        'accountType', 'demo',
        'symbol', _symbol,
        'contractType', _contract_type,
        'stake', _stake,
        'payout', _payout,
        'markupRate', v_rate,
        'platformFeeRate', v_fee_rate,
        'markupBasis', 'allocated',
        'basis', 'payout',
        'formula', 'payout * markup% / 100, truncated to zero below 0.01 (Deriv API Terms 4.3.3)',
        'rawGrossCents', v_split.raw_gross_cents,
        'truncatedToZero', v_split.truncated_to_zero,
        'correlationId', _run_correlation_id
      ),
      now()
    )
    on conflict (deriv_app_id, external_transaction_id) do nothing
    returning id into v_ledger_id;

    return jsonb_build_object(
      'recorded', v_ledger_id is not null,
      'ledgerId', v_ledger_id,
      'siteName', v_site.name,
      'grossMarkup', v_gross,
      'platformFee', v_fee,
      'ownerNet', v_owner,
      'markupRate', v_rate,
      'markupBasis', 'allocated',
      'truncatedToZero', v_split.truncated_to_zero,
      'payable', false
    );
  end;
end;
$function$;

comment on function public.record_demo_trade(uuid, text, text, text, text, text, numeric, numeric, text) is
  'Records a real Deriv demo contract in site_commission_ledger. The trade is real; the per-tenant markup amount is allocated, not Deriv-reported, because the tenants share one Deriv app. Never payable.';

grant execute on function public.record_demo_trade(uuid, text, text, text, text, text, numeric, numeric, text) to service_role;

-- Demo rows are real trading activity, so include them in the per-tenant totals
-- without letting them look like earnings.
create or replace function public.commission_ledger_totals(
  _is_simulated boolean default null,
  _run_id text default null
)
returns table (
  site_id uuid,
  site_name text,
  is_simulated boolean,
  account_type text,
  markup_basis text,
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
    l.account_type,
    l.markup_basis,
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
  group by l.site_id, s.name, l.is_simulated, l.account_type, l.markup_basis
  order by owner_total desc nulls last;
$function$;

grant execute on function public.commission_ledger_totals(boolean, text) to authenticated;
