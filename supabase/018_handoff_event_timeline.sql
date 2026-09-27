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
-- 5. ゲスト本人の識別をサーバー側で確定する（なりすまし対策）。
--    専用QRのSHOPトークンは guest_profiles.share_token_id と1対1なので、
--    その場合はクライアントの p_buyer_key を信用せず 'guest:<guest_profiles.id>' を使う。
--    従来の共有リンク（guest_profiles に紐づかないSHOPトークン）は端末ごとの識別子で
--    動いているため互換のため p_buyer_key を使うが、'guest:' で始まる値
--    （専用QRの人物用に予約）は受け付けない。CHECKトークンでは個人の情報を返さない。
--    対象: get_guest_product_state / get_my_pending_handoffs / cancel_my_handoff_request /
--          create_handoff_request / add_purchase_plan
--
-- 互換性: 列・戻り値フィールドの追加のみ。既存RPCの引数・既存フィールドは不変。
-- ロールバック: 016 の2関数、015 の get_my_pending_handoffs / create_handoff_request、
--   012 の add_purchase_plan を再適用し、get_guest_product_state と
--   guest_effective_buyer_key を drop すれば元の挙動に戻る
--   （画面は get_guest_product_state が無い場合、既存RPCの組み合わせで動く）。
--   cancelled_at 列とインデックスは残しても既存コードに影響しない。
-- =========================================

alter table public.handoff_requests
  add column if not exists cancelled_at timestamptz;

create index if not exists handoff_requests_sender_status_created_idx
  on public.handoff_requests (household_id, sender_key, status, created_at desc);

-- ゲストの本人識別子をサーバー側で決める（内部専用。anon / authenticated からは呼べない）。
-- 専用QRのトークン: guest_profiles から 'guest:<uuid>' を導出し、クライアントの値は無視する。
-- 従来の共有リンク: 端末ごとの識別子（p_client_key）を使う。ただし 'guest:' で始まる値は
--   専用QRの人物用に予約されているため拒否する（従来リンクから専用QRの人物になりすませない）。
create or replace function public.guest_effective_buyer_key(
  p_share_token_id bigint,
  p_client_key text
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when gp.id is not null then 'guest:' || gp.id::text
    when nullif(trim(coalesce(p_client_key, '')), '') is null then null
    when trim(p_client_key) like 'guest:%' then null
    else trim(p_client_key)
  end
  from (select 1) as one
  left join public.guest_profiles gp
    on gp.share_token_id = p_share_token_id
   and gp.revoked_at is null;
$$;

revoke all on function public.guest_effective_buyer_key(bigint, text) from public, anon, authenticated;

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
  v_share_token_id bigint;
  v_household_id uuid;
  v_buyer_key text;
  v_request public.handoff_requests%rowtype;
  v_link record;
  v_plan record;
  v_restored integer := 0;
begin
  select st.id, st.household_id
    into v_share_token_id, v_household_id
  from public.share_tokens st
  where st.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and st.permission = 'SHOP'
    and st.revoked_at is null
  limit 1;

  if v_household_id is null then
    return jsonb_build_object('valid_token', false);
  end if;

  -- 専用QRなら本人はトークンから決まる。他人の p_buyer_key を送っても他人の依頼には届かない。
  v_buyer_key := public.guest_effective_buyer_key(v_share_token_id, p_buyer_key);
  if v_buyer_key is null then
    return jsonb_build_object('valid_token', true, 'request_found', false, 'cancelled', false);
  end if;

  perform 1 from public.households h where h.id = v_household_id for update;

  select hr.*
    into v_request
  from public.handoff_requests hr
  where hr.id = p_handoff_id
    and hr.household_id = v_household_id
    and hr.sender_key = v_buyer_key
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
  v_share_token_id bigint;
  v_household_id uuid;
  v_buyer_key text;
  v_items jsonb;
begin
  select st.id, st.household_id
    into v_share_token_id, v_household_id
  from public.share_tokens st
  where st.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and st.permission = 'SHOP'
    and st.revoked_at is null
  limit 1;

  if v_household_id is null then
    return jsonb_build_object('valid_token', false, 'items', '[]'::jsonb);
  end if;

  v_buyer_key := public.guest_effective_buyer_key(v_share_token_id, p_buyer_key);
  if v_buyer_key is null then
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
    and hr.sender_key = v_buyer_key
    and hr.status = 'PENDING';

  return jsonb_build_object('valid_token', true, 'items', v_items);
end;
$$;

revoke all on function public.get_my_pending_handoffs(text, text) from public;
grant execute on function public.get_my_pending_handoffs(text, text) to anon, authenticated;

-- ゲストの「これ持ってる？」: 家の在庫・購入予定に加え、そのゲスト本人の受け取り待ちも重複として扱う。
-- 本人は guest_effective_buyer_key で決める。専用QRではトークンから導出し、p_buyer_key は使わない。
-- CHECKトークン（閲覧専用リンク）では、個人の受け取り待ちは返さない。
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
  v_share_token_id bigint;
  v_household_id uuid;
  v_permission text;
  v_buyer_key text;
  v_owned_quantity integer := 0;
  v_planned_quantity integer := 0;
  v_my_pending jsonb := '[]'::jsonb;
begin
  select st.id, st.household_id, st.permission
    into v_share_token_id, v_household_id, v_permission
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

  if v_permission = 'SHOP' then
    v_buyer_key := public.guest_effective_buyer_key(v_share_token_id, p_buyer_key);
  end if;

  if v_buyer_key is not null then
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
      and hr.sender_key = v_buyer_key
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

-- 「渡した」: 1操作＝1イベント。送り主（本人）と呼び名はサーバー側で決める（015 の定義を踏襲）。
create or replace function public.create_handoff_request(
  p_token text,
  p_barcode text,
  p_buyer_key text default null,
  p_sender_label text default null,
  p_quantity integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_share_token_id bigint;
  v_household_id uuid;
  v_buyer_key text;
  v_managed_label text;
  v_request_id bigint;
  v_remaining integer;
  v_consumed integer := 0;
  v_take integer := 0;
  v_plan record;
  v_sender_label text;
  v_purchaser_label text;
begin
  if p_barcode is null or p_barcode !~ '^[0-9]{8,14}$' then
    return jsonb_build_object(
      'valid_token', true,
      'valid_barcode', false,
      'valid_quantity', p_quantity is not null and p_quantity >= 1
    );
  end if;

  if p_quantity is null or p_quantity < 1 then
    return jsonb_build_object(
      'valid_token', true,
      'valid_barcode', true,
      'valid_quantity', false
    );
  end if;

  select st.id, st.household_id
    into v_share_token_id, v_household_id
  from public.share_tokens st
  where st.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and st.permission = 'SHOP'
    and st.revoked_at is null
  limit 1;

  if v_household_id is null then
    return jsonb_build_object('valid_token', false);
  end if;

  perform 1
  from public.households h
  where h.id = v_household_id
  for update;

  -- 送り主（本人）はサーバーで決める。専用QRでは guest_profiles の人物と呼び名を使い、
  -- クライアントから別人の p_buyer_key を送っても、その人の名義では記録しない。
  v_buyer_key := public.guest_effective_buyer_key(v_share_token_id, p_buyer_key);

  select nullif(left(trim(coalesce(gp.label, '')), 40), '')
    into v_managed_label
  from public.guest_profiles gp
  where gp.share_token_id = v_share_token_id
    and gp.revoked_at is null
  limit 1;

  v_sender_label := coalesce(
    v_managed_label,
    nullif(left(trim(coalesce(p_sender_label, '')), 40), '')
  );

  if v_buyer_key is not null then
    select nullif(left(trim(coalesce(pp.buyer_label, '')), 40), '')
      into v_purchaser_label
    from public.purchase_plans pp
    where pp.household_id = v_household_id
      and pp.barcode = p_barcode
      and pp.buyer_key = v_buyer_key
      and pp.status = 'PLANNED'
    order by pp.created_at desc, pp.id desc
    limit 1;
  end if;

  v_purchaser_label := coalesce(v_purchaser_label, v_sender_label);

  insert into public.handoff_requests (
    household_id,
    barcode,
    quantity,
    sender_key,
    sender_label,
    purchaser_label
  )
  values (
    v_household_id,
    p_barcode,
    p_quantity,
    v_buyer_key,
    coalesce(v_sender_label, 'ゲスト'),
    coalesce(v_purchaser_label, v_sender_label, 'ゲスト')
  )
  returning id into v_request_id;

  v_remaining := p_quantity;

  if v_buyer_key is not null then
    for v_plan in
      select pp.id, pp.quantity
      from public.purchase_plans pp
      where pp.household_id = v_household_id
        and pp.barcode = p_barcode
        and pp.buyer_key = v_buyer_key
        and pp.status = 'PLANNED'
      order by pp.created_at, pp.id
      for update
    loop
      exit when v_remaining <= 0;
      v_take := least(v_plan.quantity, v_remaining);

      insert into public.handoff_plan_consumptions (
        handoff_id,
        purchase_plan_id,
        consumed_quantity,
        consumed_whole
      )
      values (
        v_request_id,
        v_plan.id,
        v_take,
        v_take = v_plan.quantity
      );

      if v_take = v_plan.quantity then
        update public.purchase_plans
        set status = 'PURCHASED',
            updated_at = now()
        where id = v_plan.id;
      else
        update public.purchase_plans
        set quantity = quantity - v_take,
            updated_at = now()
        where id = v_plan.id;
      end if;

      v_remaining := v_remaining - v_take;
      v_consumed := v_consumed + v_take;
    end loop;
  end if;

  return jsonb_build_object(
    'valid_token', true,
    'valid_barcode', true,
    'valid_quantity', true,
    'handoff_id', v_request_id,
    'quantity', p_quantity,
    'sender_label', coalesce(v_sender_label, 'ゲスト'),
    'purchaser_label', coalesce(v_purchaser_label, v_sender_label, 'ゲスト'),
    'planned_quantity_consumed', v_consumed,
    'status', 'PENDING'
  );
end;
$$;

revoke all on function public.create_handoff_request(text, text, text, text, integer) from public;
grant execute on function public.create_handoff_request(text, text, text, text, integer) to anon, authenticated;

-- 購入予定: 購入者（本人）と呼び名はサーバー側で決める（012 の定義を踏襲）。
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
  v_share_token_id bigint;
  v_household_id uuid;
  v_buyer_key text;
  v_managed_label text;
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

  select st.id, st.household_id
    into v_share_token_id, v_household_id
  from public.share_tokens st
  where st.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and st.permission = 'SHOP'
    and st.revoked_at is null
  limit 1;

  if v_household_id is null then
    return jsonb_build_object('valid_token', false);
  end if;

  -- 購入者（本人）はサーバーで決める。専用QRでは guest_profiles の人物と呼び名を使う。
  v_buyer_key := public.guest_effective_buyer_key(v_share_token_id, p_buyer_key);

  select nullif(left(trim(coalesce(gp.label, '')), 40), '')
    into v_managed_label
  from public.guest_profiles gp
  where gp.share_token_id = v_share_token_id
    and gp.revoked_at is null
  limit 1;

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
    buyer_key,
    buyer_label,
    quantity,
    status,
    visibility
  )
  values (
    v_household_id,
    p_barcode,
    v_buyer_key,
    coalesce(v_managed_label, nullif(trim(p_buyer_label), ''), '共有ユーザー'),
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
    'buyer_key', v_buyer_key
  );
end;
$$;

revoke all on function public.add_purchase_plan(text, text, text, text, integer, text)
  from public;
grant execute on function public.add_purchase_plan(text, text, text, text, integer, text)
  to anon, authenticated;
