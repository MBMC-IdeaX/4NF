-- Top-up through eSewa only.
--
-- The owner chose one payment method for launch. New requests, manual or
-- through the gateway, are refused for anything else. The table's own check
-- still allows the old method names, so rows written before this stay valid
-- and their statements still read correctly.

create or replace function request_topup(p_method text, p_amount integer, p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account passenger_accounts%rowtype;
  v_id      bigint;
begin
  select * into v_account from passenger_accounts where user_id = auth.uid();
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
  if coalesce(trim(p_reference), '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'reference_required');
  end if;
  if (select count(*) from topup_requests where user_id = auth.uid() and status = 'pending') >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_pending');
  end if;

  insert into topup_requests (user_id, wallet_public_key, method, amount, reference)
  values (auth.uid(), v_account.wallet_public_key, p_method, p_amount, upper(trim(p_reference)))
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'status', 'pending');
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_reference');
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

revoke all on function request_topup(text, integer, text) from anon, public;
grant execute on function request_topup(text, integer, text) to authenticated;
revoke all on function gateway_open_topup(uuid, text, integer) from anon, authenticated, public;

-- Only eSewa's settings remain in use.
delete from platform_settings where key in ('khalti_id', 'khalti_qr_url', 'fonepay_id', 'fonepay_qr_url', 'imepay_id', 'imepay_qr_url');
