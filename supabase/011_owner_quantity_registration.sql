-- =========================================
-- 011_owner_quantity_registration
-- 家主登録を「読取 → 数量選択 → 確定」に変更する。
-- 既存品は勝手に加算せず、UIで確認後に指定数量を加算する。
-- =========================================

-- 家主専用: 登録前に現在の所有数量だけ確認する。
create or replace function public.get_owner_item_state(
  p_token text,
  p_barcode text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid;
  v_quantity integer := 0;
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

  if p_barcode is null or p_barcode !~ '^[0-9]{8,14}$' then
    return jsonb_build_object(
      'valid_token', true,
      'valid_barcode', false,
      'exists', false,
      'quantity', 0
    );
  end if;

  select coalesce(hi.quantity, 0)
    into v_quantity
  from public.household_items hi
  where hi.household_id = v_household_id
    and hi.barcode = p_barcode
  limit 1;

  v_quantity := coalesce(v_quantity, 0);

  return jsonb_build_object(
    'valid_token', true,
    'valid_barcode', true,
    'exists', v_quantity > 0,
    'quantity', v_quantity
  );
end;
$$;

revoke all on function public.get_owner_item_state(text, text) from public;
grant execute on function public.get_owner_item_state(text, text) to anon, authenticated;

-- 家主専用: UIで確定した数量を所有物へ反映する。
-- 新規なら指定数量で作成、既存なら指定数量を加算する。
create or replace function public.register_household_item_quantity(
  p_token text,
  p_barcode text,
  p_quantity integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid;
  v_item_id bigint;
  v_quantity_before integer := 0;
  v_quantity_after integer := 0;
  v_created boolean := false;
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

  if p_barcode is null or p_barcode !~ '^[0-9]{8,14}$' then
    return jsonb_build_object(
      'valid_token', true,
      'valid_barcode', false,
      'valid_quantity', p_quantity is not null and p_quantity >= 1,
      'created', false
    );
  end if;

  if p_quantity is null or p_quantity < 1 then
    return jsonb_build_object(
      'valid_token', true,
      'valid_barcode', true,
      'valid_quantity', false,
      'created', false
    );
  end if;

  -- 同一家の登録を直列化し、数量のbefore/afterを正確に記録する。
  perform 1
  from public.households h
  where h.id = v_household_id
  for update;

  select hi.id, hi.quantity
    into v_item_id, v_quantity_before
  from public.household_items hi
  where hi.household_id = v_household_id
    and hi.barcode = p_barcode
  limit 1;

  if v_item_id is null then
    insert into public.household_items (
      household_id,
      barcode,
      quantity
    )
    values (
      v_household_id,
      p_barcode,
      p_quantity
    )
    returning id, quantity into v_item_id, v_quantity_after;

    v_quantity_before := 0;
    v_created := true;
  else
    update public.household_items
    set quantity = quantity + p_quantity
    where id = v_item_id
    returning quantity into v_quantity_after;
  end if;

  insert into public.event_logs (
    household_id,
    event_type,
    barcode,
    result,
    client_type,
    metadata
  )
  values (
    v_household_id,
    'REGISTER',
    p_barcode,
    case when v_created then 'registered' else 'quantity_added' end,
    'owner_web',
    jsonb_build_object(
      'source', 'owner_camera',
      'created', v_created,
      'added_quantity', p_quantity,
      'quantity_before', v_quantity_before,
      'quantity_after', v_quantity_after
    )
  );

  return jsonb_build_object(
    'valid_token', true,
    'valid_barcode', true,
    'valid_quantity', true,
    'created', v_created,
    'item_id', v_item_id,
    'barcode', p_barcode,
    'added_quantity', p_quantity,
    'quantity_before', v_quantity_before,
    'quantity', v_quantity_after
  );
end;
$$;

revoke all on function public.register_household_item_quantity(text, text, integer) from public;
grant execute on function public.register_household_item_quantity(text, text, integer) to anon, authenticated;
