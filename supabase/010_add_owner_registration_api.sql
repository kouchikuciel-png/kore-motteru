-- =========================================
-- 010_add_owner_registration_api
-- 家主専用の登録権限と所有物登録RPCを追加
-- 共有側(SHOP)と家主側(OWNER)を分離する
-- =========================================

-- share_tokens.permission を CHECK / SHOP / OWNER に拡張
alter table public.share_tokens
  drop constraint if exists share_tokens_permission_check;

alter table public.share_tokens
  add constraint share_tokens_permission_check
  check (permission in ('CHECK', 'SHOP', 'OWNER'));

-- 家主も自分の所有物一覧を取得できるようにする
create or replace function public.get_household_owned_items(
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid;
  v_items jsonb;
begin
  select st.household_id
    into v_household_id
  from public.share_tokens st
  where st.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and st.permission in ('CHECK', 'SHOP', 'OWNER')
    and st.revoked_at is null
  limit 1;

  if v_household_id is null then
    return jsonb_build_object(
      'valid_token', false,
      'items', '[]'::jsonb
    );
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'barcode', hi.barcode,
        'quantity', hi.quantity,
        'registered_at', hi.registered_at
      )
      order by hi.registered_at desc
    ),
    '[]'::jsonb
  )
  into v_items
  from public.household_items hi
  where hi.household_id = v_household_id;

  return jsonb_build_object(
    'valid_token', true,
    'items', v_items
  );
end;
$$;

revoke all on function public.get_household_owned_items(text) from public;
grant execute on function public.get_household_owned_items(text) to anon, authenticated;

-- 家主専用: 所有物を登録する。
-- 同じコードを誤って再スキャンしても数量は自動加算しない。
create or replace function public.register_household_item(
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
  v_item_id bigint;
  v_quantity integer := 0;
  v_created boolean := false;
begin
  if p_barcode is null or p_barcode !~ '^[0-9]{8,14}$' then
    return jsonb_build_object(
      'valid_token', true,
      'valid_barcode', false,
      'created', false
    );
  end if;

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

  insert into public.household_items (
    household_id,
    barcode,
    quantity
  )
  values (
    v_household_id,
    p_barcode,
    1
  )
  on conflict (household_id, barcode) do nothing
  returning id, quantity into v_item_id, v_quantity;

  if v_item_id is not null then
    v_created := true;

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
      'registered',
      'owner_web',
      jsonb_build_object('source', 'owner_camera')
    );
  else
    select hi.id, hi.quantity
      into v_item_id, v_quantity
    from public.household_items hi
    where hi.household_id = v_household_id
      and hi.barcode = p_barcode
    limit 1;
  end if;

  return jsonb_build_object(
    'valid_token', true,
    'valid_barcode', true,
    'created', v_created,
    'item_id', v_item_id,
    'barcode', p_barcode,
    'quantity', coalesce(v_quantity, 1)
  );
end;
$$;

revoke all on function public.register_household_item(text, text) from public;
grant execute on function public.register_household_item(text, text) to anon, authenticated;

-- 新井家・試験の家主トークンを再発行し、完成URLを1行で返す。
-- 生トークンはDBに保存せずSHA-256ハッシュだけ保存する。
with target as (
  select id
  from public.households
  where display_name = '新井家・試験'
  limit 1
),
revoked as (
  update public.share_tokens
  set revoked_at = now()
  where household_id = (select id from target)
    and permission = 'OWNER'
    and revoked_at is null
  returning id
),
raw as (
  select encode(gen_random_bytes(32), 'hex') as token
),
saved as (
  insert into public.share_tokens (
    household_id,
    token_hash,
    permission
  )
  select
    target.id,
    encode(extensions.digest(raw.token, 'sha256'), 'hex'),
    'OWNER'
  from raw, target
  returning id
)
select
  'https://kouchikuciel-png.github.io/kore-motteru/owner.html#token=' || raw.token
    as owner_url
from raw, saved;
