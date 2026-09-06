-- =========================================
-- 008_add_purchase_plan_api
-- 共有リンクから購入予定を登録するRPC
-- 重複は拒否せず、追加前の状態を返す
-- =========================================

-- 共有トークンの権限を CHECK / SHOP に拡張
alter table public.share_tokens
  drop constraint if exists share_tokens_permission_check;

alter table public.share_tokens
  add constraint share_tokens_permission_check
  check (permission in ('CHECK', 'SHOP'));

-- 現在有効な共有トークンをSHOP権限へ昇格
update public.share_tokens
set permission = 'SHOP'
where revoked_at is null;

-- 既存照合RPCはCHECK/SHOPの両方を許可
create or replace function public.check_household_barcode(
  p_token text,
  p_barcode text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid;
  v_registered boolean;
begin
  select st.household_id
    into v_household_id
  from public.share_tokens st
  where st.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and st.permission in ('CHECK', 'SHOP')
    and st.revoked_at is null
  limit 1;

  if v_household_id is null then
    return false;
  end if;

  select exists (
    select 1
    from public.household_items hi
    where hi.household_id = v_household_id
      and hi.barcode = p_barcode
  )
  into v_registered;

  insert into public.event_logs (
    household_id,
    event_type,
    barcode,
    result
  )
  values (
    v_household_id,
    case when v_registered then 'CHECK_MATCH' else 'CHECK_NOT_FOUND' end,
    p_barcode,
    case when v_registered then 'matched' else 'not_found' end
  );

  return v_registered;
end;
$$;

-- 商品状態RPCもCHECK/SHOPの両方を許可
create or replace function public.get_household_product_state(
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
  v_owned_quantity integer := 0;
  v_planned_quantity integer := 0;
begin
  select st.household_id
    into v_household_id
  from public.share_tokens st
  where st.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and st.permission in ('CHECK', 'SHOP')
    and st.revoked_at is null
  limit 1;

  if v_household_id is null then
    return jsonb_build_object(
      'valid_token', false,
      'owned_quantity', 0,
      'planned_quantity', 0,
      'duplicate', false
    );
  end if;

  select coalesce(sum(hi.quantity), 0)::integer
    into v_owned_quantity
  from public.household_items hi
  where hi.household_id = v_household_id
    and hi.barcode = p_barcode;

  select coalesce(sum(pp.quantity), 0)::integer
    into v_planned_quantity
  from public.purchase_plans pp
  where pp.household_id = v_household_id
    and pp.barcode = p_barcode
    and pp.status = 'PLANNED';

  return jsonb_build_object(
    'valid_token', true,
    'owned_quantity', v_owned_quantity,
    'planned_quantity', v_planned_quantity,
    'duplicate', (v_owned_quantity + v_planned_quantity) > 0
  );
end;
$$;

-- 購入予定追加RPC
create or replace function public.add_purchase_plan(
  p_token text,
  p_barcode text,
  p_buyer_key text,
  p_buyer_label text default null,
  p_quantity integer default 1,
  p_visibility text default 'GIFT_SECRET'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid;
  v_owned_quantity integer := 0;
  v_planned_quantity_before integer := 0;
  v_plan_id bigint;
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'quantity must be >= 1';
  end if;

  if p_visibility not in ('GIFT_SECRET', 'HOUSEHOLD_SHARED') then
    raise exception 'invalid visibility';
  end if;

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

  select coalesce(sum(hi.quantity), 0)::integer
    into v_owned_quantity
  from public.household_items hi
  where hi.household_id = v_household_id
    and hi.barcode = p_barcode;

  select coalesce(sum(pp.quantity), 0)::integer
    into v_planned_quantity_before
  from public.purchase_plans pp
  where pp.household_id = v_household_id
    and pp.barcode = p_barcode
    and pp.status = 'PLANNED';

  insert into public.purchase_plans (
    household_id,
    barcode,
    buyer_label,
    quantity,
    status,
    visibility
  )
  values (
    v_household_id,
    p_barcode,
    coalesce(nullif(trim(p_buyer_label), ''), '共有ユーザー'),
    p_quantity,
    'PLANNED',
    p_visibility
  )
  returning id into v_plan_id;

  return jsonb_build_object(
    'valid_token', true,
    'plan_id', v_plan_id,
    'owned_quantity', v_owned_quantity,
    'planned_quantity_before', v_planned_quantity_before,
    'planned_quantity_after', v_planned_quantity_before + p_quantity,
    'duplicate_before_add', (v_owned_quantity + v_planned_quantity_before) > 0,
    'buyer_key', p_buyer_key
  );
end;
$$;

revoke all on function public.add_purchase_plan(text, text, text, text, integer, text)
  from public;

grant execute on function public.add_purchase_plan(text, text, text, text, integer, text)
  to anon, authenticated;
