-- An eSewa payment nobody finished is marked failed, not left waiting forever.
--
-- A gateway top-up is opened before the rider reaches eSewa. If they never
-- come back — the login fails, the tab is closed, the phone loses signal — no
-- success or failure URL is ever hit, and the request sat at 'initiated' for
-- good: "Waiting for payment" on the statement, and five of them in an hour
-- refused every new top-up with too_many_pending.
--
-- Now an initiated request older than 15 minutes is marked failed whenever the
-- rider looks at their requests or opens a new one. eSewa's own session is
-- long gone by then. If eSewa does confirm one afterwards, it is still
-- credited: an expired request can be completed, a cancelled one cannot, so a
-- slow payment never takes money without it reaching the wallet.

create or replace function expire_gateway_topups(p_user_id uuid)
returns integer
language sql
as $$
  with expired as (
    update topup_requests
       set status = 'failed', note = 'Not paid within 15 minutes', decided_at = now()
     where user_id = p_user_id and channel = 'gateway' and status = 'initiated'
       and created_at < now() - interval '15 minutes'
    returning 1
  )
  select count(*)::integer from expired;
$$;

revoke all on function expire_gateway_topups(uuid) from anon, authenticated, public;

create or replace function my_topup_requests()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform expire_gateway_topups(auth.uid());
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', id, 'method', method, 'amount', amount, 'reference', reference,
             'status', status, 'channel', channel, 'note', note,
             'created_at', created_at, 'decided_at', decided_at
           ) order by created_at desc), '[]'::jsonb)
      from topup_requests
     where user_id = auth.uid()
  );
end;
$$;

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
  if p_method is distinct from 'esewa' then
    return jsonb_build_object('ok', false, 'reason', 'bad_method');
  end if;
  if p_amount is null or p_amount < 10 or p_amount > 10000 then
    return jsonb_build_object('ok', false, 'reason', 'bad_amount');
  end if;
  -- Abandoned attempts no longer count against the five.
  perform expire_gateway_topups(p_user_id);
  if (select count(*) from topup_requests
       where user_id = p_user_id and status = 'initiated'
         and created_at > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_pending');
  end if;

  v_ref := 'BH-' || to_char(now() at time zone 'Asia/Kathmandu', 'YYMMDD') || '-'
        || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));

  insert into topup_requests (user_id, wallet_public_key, method, amount, reference, status, channel)
  values (p_user_id, v_account.wallet_public_key, p_method, p_amount, v_ref, 'initiated', 'gateway')
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'reference', v_ref, 'amount', p_amount, 'method', p_method);
end;
$$;

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
  -- Expired for lack of news is not the same as cancelled: eSewa's word that
  -- it was paid still counts.
  if v_req.status <> 'initiated'
     and not (v_req.status = 'failed' and v_req.note = 'Not paid within 15 minutes') then
    return jsonb_build_object('ok', false, 'reason', 'already_decided', 'status', v_req.status);
  end if;
  if p_amount <> v_req.amount then
    update topup_requests
       set status = 'pending', provider_ref = p_provider_ref, decided_at = null,
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
     set status = 'loaded', provider_ref = p_provider_ref, note = null, decided_at = now()
   where id = v_req.id;

  return jsonb_build_object('ok', true, 'id', v_req.id, 'balance', (v_credit->>'balance')::integer);
end;
$$;

revoke all on function gateway_open_topup(uuid, text, integer) from anon, authenticated, public;
revoke all on function gateway_complete_topup(text, text, integer, text) from anon, authenticated, public;
