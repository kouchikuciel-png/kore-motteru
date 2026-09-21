-- =========================================
-- 016_cancel_restore_as_new_plan
-- 同じ購入予定が複数の「渡した」に分割消費された場合でも、
-- 取消対象ぶんだけ正確に購入予定へ戻す。
--
-- 元行を巻き戻すのではなく、取消した数量を新しいPLANNED行として復元する。
-- これにより、後続の別handoffが消費した数量へ干渉しない。
-- =========================================

create or replace function public.cancel_my_handoff_request(
  p_token text,
  p_handoff_id bigint,
  p_buyer_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid;
  v_request public.handoff_requests%rowtype;
  v_link record;
  v_plan record;
  v_restored integer := 0;
begin
  select st.household_id
    into v_household_id
  from public.share_tokens st
  where st.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and st.permission = 'SHOP'
    and st.revoked_at is null
  limit 1;

  if v_household_id is null then
    return jsonb_build_object('valid_token', false);
  end if;

  perform 1 from public.households h where h.id = v_household_id for update;

  select hr.*
    into v_request
  from public.handoff_requests hr
  where hr.id = p_handoff_id
    and hr.household_id = v_household_id
    and hr.sender_key = p_buyer_key
  for update;

  if v_request.id is null then
    return jsonb_build_object('valid_token', true, 'request_found', false, 'cancelled', false);
  end if;

  if v_request.status <> 'PENDING' then
    return jsonb_build_object(
      'valid_token', true,
      'request_found', true,
      'cancelled', false,
      'status', v_request.status
    );
  end if;

  for v_link in
    select hpc.purchase_plan_id, hpc.consumed_quantity
    from public.handoff_plan_consumptions hpc
    where hpc.handoff_id = v_request.id
    order by hpc.id
  loop
    if v_link.purchase_plan_id is null then
      continue;
    end if;

    select pp.barcode, pp.buyer_key, pp.buyer_label, pp.visibility
      into v_plan
    from public.purchase_plans pp
    where pp.id = v_link.purchase_plan_id
      and pp.household_id = v_household_id
    limit 1;

    if v_plan.barcode is not null then
      insert into public.purchase_plans (
        household_id,
        barcode,
        buyer_key,
        buyer_label,
        quantity,
        status,
        visibility
      )
      values (
        v_household_id,
        v_plan.barcode,
        v_plan.buyer_key,
        v_plan.buyer_label,
        v_link.consumed_quantity,
        'PLANNED',
        v_plan.visibility
      );

      v_restored := v_restored + v_link.consumed_quantity;
    end if;
  end loop;

  update public.handoff_requests
  set status = 'CANCELLED'
  where id = v_request.id;

  return jsonb_build_object(
    'valid_token', true,
    'request_found', true,
    'cancelled', true,
    'handoff_id', v_request.id,
    'restored_planned_quantity', v_restored,
    'status', 'CANCELLED'
  );
end;
$$;

revoke all on function public.cancel_my_handoff_request(text, bigint, text) from public;
grant execute on function public.cancel_my_handoff_request(text, bigint, text) to anon, authenticated;

create or replace function public.cancel_owner_handoff_request(
  p_token text,
  p_handoff_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid;
  v_request public.handoff_requests%rowtype;
  v_link record;
  v_plan record;
  v_restored integer := 0;
begin
  select st.household_id
    into v_household_id
  from public.share_tokens st
  where st.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and st.permission = 'OWNER'
    and st.revoked_at is null
  limit 1;

  if v_household_id is null then
    return jsonb_build_object('valid_token', false);
  end if;

  perform 1 from public.households h where h.id = v_household_id for update;

  select hr.*
    into v_request
  from public.handoff_requests hr
  where hr.id = p_handoff_id
    and hr.household_id = v_household_id
  for update;

  if v_request.id is null then
    return jsonb_build_object('valid_token', true, 'request_found', false, 'cancelled', false);
  end if;

  if v_request.status <> 'PENDING' then
    return jsonb_build_object(
      'valid_token', true,
      'request_found', true,
      'cancelled', false,
      'status', v_request.status
    );
  end if;

  for v_link in
    select hpc.purchase_plan_id, hpc.consumed_quantity
    from public.handoff_plan_consumptions hpc
    where hpc.handoff_id = v_request.id
    order by hpc.id
  loop
    if v_link.purchase_plan_id is null then
      continue;
    end if;

    select pp.barcode, pp.buyer_key, pp.buyer_label, pp.visibility
      into v_plan
    from public.purchase_plans pp
    where pp.id = v_link.purchase_plan_id
      and pp.household_id = v_household_id
    limit 1;

    if v_plan.barcode is not null then
      insert into public.purchase_plans (
        household_id,
        barcode,
        buyer_key,
        buyer_label,
        quantity,
        status,
        visibility
      )
      values (
        v_household_id,
        v_plan.barcode,
        v_plan.buyer_key,
        v_plan.buyer_label,
        v_link.consumed_quantity,
        'PLANNED',
        v_plan.visibility
      );

      v_restored := v_restored + v_link.consumed_quantity;
    end if;
  end loop;

  update public.handoff_requests
  set status = 'CANCELLED'
  where id = v_request.id;

  return jsonb_build_object(
    'valid_token', true,
    'request_found', true,
    'cancelled', true,
    'handoff_id', v_request.id,
    'restored_planned_quantity', v_restored,
    'status', 'CANCELLED'
  );
end;
$$;

revoke all on function public.cancel_owner_handoff_request(text, bigint) from public;
grant execute on function public.cancel_owner_handoff_request(text, bigint) to anon, authenticated;
