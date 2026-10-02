-- Top-ups through a payment gateway.
--
-- 0022's requests are manual: a passenger pays, types the reference, an admin
-- checks and loads. eSewa and Khalti can answer for themselves, so a request
-- through them is opened by the payments function, paid on the gateway's own
-- page, and completed only after the function has checked the gateway's
-- signature and asked the gateway directly. No admin is involved and no
-- browser is believed.
--
-- A gateway request starts `initiated`, which the admin queue does not show,
-- because an abandoned payment page is not work for anyone. It ends `loaded`
-- or `failed`. Every function here is service-role only.

alter table topup_requests drop constraint if exists topup_requests_status_check;
alter table topup_requests add constraint topup_requests_status_check
  check (status in ('initiated', 'pending', 'loaded', 'rejected', 'failed'));

alter table topup_requests add column if not exists channel text not null default 'manual'
  check (channel in ('manual', 'gateway'));
alter table topup_requests add column if not exists provider_ref text;

create or replace function gateway_open_topup(p_user_id uuid, p_method text, p_amount integer)
returns jsonb
language plpgsql
as $$
declare
  v_account passenger_accounts%rowtype;
  v_ref     text;
  v_id      bigint;
begin
  select * into v_account from passenger_accounts where user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_linked');
  end if;
  if v_account.suspended_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'suspended');
  end if;
  if p_method not in ('esewa', 'khalti') then
    return jsonb_build_object('ok', false, 'reason', 'bad_method');
  end if;
  if p_amount is null or p_amount < 10 or p_amount > 10000 then
    return jsonb_build_object('ok', false, 'reason', 'bad_amount');
  end if;
  if (select count(*) from topup_requests
       where user_id = p_user_id and status = 'initiated'
         and created_at > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_pending');
  end if;

  -- eSewa accepts letters, digits and hyphens here; so does Khalti.
  v_ref := 'BH-' || to_char(now() at time zone 'Asia/Kathmandu', 'YYMMDD') || '-'
        || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));

  insert into topup_requests (user_id, wallet_public_key, method, amount, reference, status, channel)
  values (p_user_id, v_account.wallet_public_key, p_method, p_amount, v_ref, 'initiated', 'gateway')
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'reference', v_ref, 'amount', p_amount, 'method', p_method);
end;
$$;

/*
  The gateway has confirmed. `p_amount` is what the gateway says was paid; it
  must be what was asked, or nothing is credited and the request is left for a
  person to look at.
*/
create or replace function gateway_complete_topup(p_reference text, p_method text, p_amount integer, p_provider_ref text)
returns jsonb
language plpgsql
as $$
declare
  v_req    topup_requests%rowtype;
  v_credit jsonb;
begin
  select * into v_req from topup_requests
   where reference = p_reference and method = p_method and channel = 'gateway'
     for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_req.status = 'loaded' then
    return jsonb_build_object('ok', true, 'already', true, 'id', v_req.id,
      'balance', (select balance from passengers where public_key = v_req.wallet_public_key));
  end if;
  if v_req.status <> 'initiated' then
    return jsonb_build_object('ok', false, 'reason', 'already_decided', 'status', v_req.status);
  end if;
  if p_amount <> v_req.amount then
    update topup_requests
       set status = 'pending', provider_ref = p_provider_ref,
           note = format('Gateway reported Rs %s against Rs %s asked. Check before loading.', p_amount, v_req.amount)
     where id = v_req.id;
    return jsonb_build_object('ok', false, 'reason', 'amount_mismatch');
  end if;

  v_credit := credit_wallet(v_req.wallet_public_key, v_req.amount, v_req.method, v_req.reference);
  if not coalesce((v_credit->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', coalesce(v_credit->>'reason', 'credit_failed'));
  end if;
  update wallet_topups set note = nullif(p_provider_ref, '')
   where source = v_req.method and reference = v_req.reference;

  update topup_requests
     set status = 'loaded', provider_ref = p_provider_ref, decided_at = now()
   where id = v_req.id;

  return jsonb_build_object('ok', true, 'id', v_req.id, 'balance', (v_credit->>'balance')::integer);
end;
$$;

create or replace function gateway_fail_topup(p_reference text, p_method text, p_reason text)
returns jsonb
language plpgsql
as $$
begin
  update topup_requests
     set status = 'failed', note = left(coalesce(p_reason, 'Payment not completed'), 200), decided_at = now()
   where reference = p_reference and method = p_method and channel = 'gateway' and status = 'initiated';
  return jsonb_build_object('ok', found);
end;
$$;

-- What the phone needs to finish a payment it started: the request, looked up
-- by the reference the gateway echoed back, for its owner only.
create or replace function gateway_request_for(p_user_id uuid, p_reference text)
returns jsonb
language sql
stable
as $$
  select coalesce((
    select jsonb_build_object('id', id, 'method', method, 'amount', amount, 'reference', reference,
                              'status', status, 'provider_ref', provider_ref)
      from topup_requests
     where user_id = p_user_id and reference = p_reference
  ), jsonb_build_object('ok', false, 'reason', 'not_found'))
$$;

/*
  Khalti names its payment session (pidx) when the request is opened. Keeping
  it on the request is what stops one paid session being presented against a
  second request for the same amount.
*/
create or replace function gateway_attach_topup(p_reference text, p_provider_ref text)
returns jsonb
language plpgsql
as $$
begin
  update topup_requests set provider_ref = p_provider_ref
   where reference = p_reference and channel = 'gateway' and status = 'initiated' and provider_ref is null;
  return jsonb_build_object('ok', found);
end;
$$;

revoke all on function gateway_attach_topup(text, text) from anon, authenticated, public;
revoke all on function gateway_open_topup(uuid, text, integer) from anon, authenticated, public;
revoke all on function gateway_complete_topup(text, text, integer, text) from anon, authenticated, public;
revoke all on function gateway_fail_topup(text, text, text) from anon, authenticated, public;
revoke all on function gateway_request_for(uuid, text) from anon, authenticated, public;

-- The request list shows how each was paid.
create or replace function my_topup_requests()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'method', method, 'amount', amount, 'reference', reference,
           'status', status, 'channel', channel, 'note', note,
           'created_at', created_at, 'decided_at', decided_at
         ) order by created_at desc), '[]'::jsonb)
    from topup_requests
   where user_id = auth.uid()
     and not (status = 'initiated' and created_at < now() - interval '1 day')
$$;
