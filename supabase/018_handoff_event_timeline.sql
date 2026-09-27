-- =========================================
-- 018_handoff_event_timeline
-- 「渡した」は1操作＝1イベント（handoff_requests の1行）として保持する。
-- 在庫（household_items）は集約してよいが、受け渡し履歴は集約しない。
--
-- 012〜016 の時点で、create_handoff_request は毎回新しい行を INSERT し、
-- 既存行の quantity を加算して再利用していない。受取・取消も handoff_id 単位。
-- この migration はその前提を変えず、次だけを追加する。
--
-- 1. 取消日時 cancelled_at を記録する（追加列。既存の取消済み行は NULL のまま。
--    過去の取消日時は復元できないため、推測値で埋めない）
-- 2. 取消RPC（016 の定義を踏襲）で cancelled_at を記録する
-- 3. ゲスト本人の受け取り待ち一覧に status / purchaser_label を返し、
--    送り主キーでの参照用インデックスを追加する
-- 4. ゲストの重複確認 get_guest_product_state を追加する。
--    対象は「家の在庫」「購入予定」「そのゲスト本人の受け取り待ち」。
--    他のゲストの受け取り待ちは、件数も存在も返さない（贈り物を漏らさない）。
--    受け取り待ちはイベントごと（日時・その時の数量）に返し、合算しない。
--    既存の get_household_product_state は変更しない。
--
-- 互換性: 列・戻り値フィールドの追加のみ。既存RPCの引数・既存フィールドは不変。
-- ロールバック: 016 の2関数と 015 の get_my_pending_handoffs を再適用し、
--   get_guest_product_state を drop すれば元の挙動に戻る
--   （画面は get_guest_product_state が無い場合、既存RPCの組み合わせで動く）。
--   cancelled_at 列とインデックスは残しても既存コードに影響しない。
-- =========================================

alter table public.handoff_requests
  add column if not exists cancelled_at timestamptz;

create index if not exists handoff_requests_sender_status_created_idx
  on public.handoff_requests (household_id, sender_key, status, created_at desc);

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
  set status = 'CANCELLED',
      cancelled_at = now()
  where id = v_request.id;

  return jsonb_build_object(
    'valid_token', true,
    'request_found', true,
    'cancelled', true,
    'handoff_id', v_request.id,
    'restored_planned_quantity', v_restored,
    'status', 'CANCELLED',
    'cancelled_at', now()
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
  set status = 'CANCELLED',
      cancelled_at = now()
  where id = v_request.id;

  return jsonb_build_object(
    'valid_token', true,
    'request_found', true,
    'cancelled', true,
    'handoff_id', v_request.id,
    'restored_planned_quantity', v_restored,
    'status', 'CANCELLED',
    'cancelled_at', now()
  );
end;
$$;

revoke all on function public.cancel_owner_handoff_request(text, bigint) from public;
grant execute on function public.cancel_owner_handoff_request(text, bigint) to anon, authenticated;

-- ゲスト本人が作った受け取り待ちイベントを、1件ずつ（集約せず）新しい順に返す。
create or replace function public.get_my_pending_handoffs(
  p_token text,
  p_buyer_key text
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
    and st.permission = 'SHOP'
    and st.revoked_at is null
  limit 1;

  if v_household_id is null then
    return jsonb_build_object('valid_token', false, 'items', '[]'::jsonb);
  end if;

  if nullif(trim(coalesce(p_buyer_key, '')), '') is null then
    return jsonb_build_object('valid_token', true, 'items', '[]'::jsonb);
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', hr.id,
        'barcode', hr.barcode,
        'quantity', hr.quantity,
        'sender_label', hr.sender_label,
        'purchaser_label', hr.purchaser_label,
        'status', hr.status,
        'created_at', hr.created_at
      )
      order by hr.created_at desc, hr.id desc
    ),
    '[]'::jsonb
  )
  into v_items
  from public.handoff_requests hr
  where hr.household_id = v_household_id
    and hr.sender_key = p_buyer_key
    and hr.status = 'PENDING';

  return jsonb_build_object('valid_token', true, 'items', v_items);
end;
$$;

revoke all on function public.get_my_pending_handoffs(text, text) from public;
grant execute on function public.get_my_pending_handoffs(text, text) to anon, authenticated;

-- ゲストの「これ持ってる？」: 家の在庫・購入予定に加え、そのゲスト本人の受け取り待ちも重複として扱う。
-- p_buyer_key は get_my_pending_handoffs / cancel_my_handoff_request と同じ本人識別子。
create or replace function public.get_guest_product_state(
  p_token text,
  p_barcode text,
  p_buyer_key text default null
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
  v_my_pending jsonb := '[]'::jsonb;
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
      'my_pending_handoffs', '[]'::jsonb,
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

  if nullif(trim(coalesce(p_buyer_key, '')), '') is not null then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', hr.id,
          'barcode', hr.barcode,
          'quantity', hr.quantity,
          'status', hr.status,
          'created_at', hr.created_at
        )
        order by hr.created_at, hr.id
      ),
      '[]'::jsonb
    )
    into v_my_pending
    from public.handoff_requests hr
    where hr.household_id = v_household_id
      and hr.barcode = p_barcode
      and hr.sender_key = p_buyer_key
      and hr.status = 'PENDING';
  end if;

  return jsonb_build_object(
    'valid_token', true,
    'owned_quantity', v_owned_quantity,
    'planned_quantity', v_planned_quantity,
    'my_pending_handoffs', v_my_pending,
    'duplicate', (v_owned_quantity + v_planned_quantity) > 0
      or jsonb_array_length(v_my_pending) > 0
  );
end;
$$;

revoke all on function public.get_guest_product_state(text, text, text) from public;
grant execute on function public.get_guest_product_state(text, text, text) to anon, authenticated;
