-- =========================================
-- 017_guest_invite_qr_identity
-- オーナーが人ごとのゲスト入口を発行し、
-- 呼び名を端末保存ではなくサーバー側の人物情報として保持する。
-- 生のゲストトークンは保存せず、既存 share_tokens には SHA-256 のみ保存する。
-- =========================================

create table if not exists public.guest_profiles (
  id uuid primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  share_token_id bigint unique references public.share_tokens(id) on delete cascade,
  label text check (label is null or (char_length(trim(label)) between 1 and 40)),
  invite_secret bytea not null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  revoked_at timestamptz
);

create index if not exists guest_profiles_household_active_idx
  on public.guest_profiles (household_id, created_at)
  where revoked_at is null;

alter table public.guest_profiles enable row level security;
revoke all on table public.guest_profiles from public, anon, authenticated;

create or replace function public.create_owner_guest_invite(
  p_token text,
  p_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid;
  v_guest_id uuid := extensions.gen_random_uuid();
  v_secret bytea := extensions.gen_random_bytes(32);
  v_guest_token text;
  v_share_token_id bigint;
  v_label text;
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

  v_label := nullif(left(trim(coalesce(p_label, '')), 40), '');
  v_guest_token :=
    'kmtg_' ||
    replace(v_guest_id::text, '-', '') ||
    '_' ||
    encode(
      extensions.hmac(
        v_guest_id::text,
        encode(v_secret, 'hex'),
        'sha256'
      ),
      'hex'
    );

  insert into public.share_tokens (
    household_id,
    token_hash,
    permission
  )
  values (
    v_household_id,
    encode(extensions.digest(v_guest_token, 'sha256'), 'hex'),
    'SHOP'
  )
  returning id into v_share_token_id;

  insert into public.guest_profiles (
    id,
    household_id,
    share_token_id,
    label,
    invite_secret,
    claimed_at
  )
  values (
    v_guest_id,
    v_household_id,
    v_share_token_id,
    v_label,
    v_secret,
    case when v_label is null then null else now() end
  );

  return jsonb_build_object(
    'valid_token', true,
    'guest_id', v_guest_id,
    'label', v_label,
    'claim_required', v_label is null,
    'guest_token', v_guest_token,
    'guest_key', 'guest:' || v_guest_id::text
  );
end;
$$;

revoke all on function public.create_owner_guest_invite(text, text) from public;
grant execute on function public.create_owner_guest_invite(text, text) to anon, authenticated;

create or replace function public.list_owner_guest_invites(
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
    and st.permission = 'OWNER'
    and st.revoked_at is null
  limit 1;

  if v_household_id is null then
    return jsonb_build_object('valid_token', false, 'items', '[]'::jsonb);
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'guest_id', gp.id,
        'label', gp.label,
        'claim_required', gp.label is null,
        'guest_key', 'guest:' || gp.id::text,
        'guest_token',
          'kmtg_' ||
          replace(gp.id::text, '-', '') ||
          '_' ||
          encode(
            extensions.hmac(
              gp.id::text,
              encode(gp.invite_secret, 'hex'),
              'sha256'
            ),
            'hex'
          ),
        'created_at', gp.created_at
      )
      order by gp.created_at, gp.id
    ),
    '[]'::jsonb
  )
  into v_items
  from public.guest_profiles gp
  join public.share_tokens st on st.id = gp.share_token_id
  where gp.household_id = v_household_id
    and gp.revoked_at is null
    and st.revoked_at is null
    and st.permission = 'SHOP';

  return jsonb_build_object('valid_token', true, 'items', v_items);
end;
$$;

revoke all on function public.list_owner_guest_invites(text) from public;
grant execute on function public.list_owner_guest_invites(text) to anon, authenticated;

create or replace function public.get_guest_identity(
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_share_token_id bigint;
  v_household_id uuid;
  v_household_name text;
  v_guest public.guest_profiles%rowtype;
begin
  select st.id, st.household_id, h.display_name
    into v_share_token_id, v_household_id, v_household_name
  from public.share_tokens st
  join public.households h on h.id = st.household_id
  where st.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and st.permission = 'SHOP'
    and st.revoked_at is null
  limit 1;

  if v_household_id is null then
    return jsonb_build_object('valid_token', false, 'managed_guest', false);
  end if;

  select gp.*
    into v_guest
  from public.guest_profiles gp
  where gp.share_token_id = v_share_token_id
    and gp.household_id = v_household_id
    and gp.revoked_at is null
  limit 1;

  if v_guest.id is null then
    return jsonb_build_object(
      'valid_token', true,
      'managed_guest', false,
      'household_name', v_household_name
    );
  end if;

  return jsonb_build_object(
    'valid_token', true,
    'managed_guest', true,
    'guest_id', v_guest.id,
    'guest_key', 'guest:' || v_guest.id::text,
    'label', v_guest.label,
    'claim_required', v_guest.label is null,
    'household_name', v_household_name
  );
end;
$$;

revoke all on function public.get_guest_identity(text) from public;
grant execute on function public.get_guest_identity(text) to anon, authenticated;

create or replace function public.claim_guest_identity(
  p_token text,
  p_label text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_share_token_id bigint;
  v_guest public.guest_profiles%rowtype;
  v_label text;
begin
  v_label := nullif(left(trim(coalesce(p_label, '')), 40), '');
  if v_label is null then
    return jsonb_build_object('valid_token', true, 'valid_label', false);
  end if;

  select st.id
    into v_share_token_id
  from public.share_tokens st
  where st.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and st.permission = 'SHOP'
    and st.revoked_at is null
  limit 1;

  if v_share_token_id is null then
    return jsonb_build_object('valid_token', false);
  end if;

  select gp.*
    into v_guest
  from public.guest_profiles gp
  where gp.share_token_id = v_share_token_id
    and gp.revoked_at is null
  for update;

  if v_guest.id is null then
    return jsonb_build_object(
      'valid_token', true,
      'managed_guest', false,
      'valid_label', true
    );
  end if;

  if v_guest.label is null then
    update public.guest_profiles
    set label = v_label,
        claimed_at = coalesce(claimed_at, now())
    where id = v_guest.id;

    v_guest.label := v_label;
  end if;

  return jsonb_build_object(
    'valid_token', true,
    'managed_guest', true,
    'valid_label', true,
    'guest_id', v_guest.id,
    'guest_key', 'guest:' || v_guest.id::text,
    'label', v_guest.label,
    'claim_required', false
  );
end;
$$;

revoke all on function public.claim_guest_identity(text, text) from public;
grant execute on function public.claim_guest_identity(text, text) to anon, authenticated;

create or replace function public.rename_owner_guest(
  p_token text,
  p_guest_id uuid,
  p_label text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid;
  v_label text;
  v_changed integer;
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

  v_label := nullif(left(trim(coalesce(p_label, '')), 40), '');
  if v_label is null then
    return jsonb_build_object('valid_token', true, 'valid_label', false);
  end if;

  update public.guest_profiles
  set label = v_label,
      claimed_at = coalesce(claimed_at, now())
  where id = p_guest_id
    and household_id = v_household_id
    and revoked_at is null;

  get diagnostics v_changed = row_count;

  return jsonb_build_object(
    'valid_token', true,
    'valid_label', true,
    'guest_found', v_changed = 1,
    'label', v_label
  );
end;
$$;

revoke all on function public.rename_owner_guest(text, uuid, text) from public;
grant execute on function public.rename_owner_guest(text, uuid, text) to anon, authenticated;

create or replace function public.revoke_owner_guest(
  p_token text,
  p_guest_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid;
  v_share_token_id bigint;
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

  select gp.share_token_id
    into v_share_token_id
  from public.guest_profiles gp
  where gp.id = p_guest_id
    and gp.household_id = v_household_id
    and gp.revoked_at is null
  for update;

  if v_share_token_id is null then
    return jsonb_build_object('valid_token', true, 'guest_found', false, 'revoked', false);
  end if;

  update public.guest_profiles
  set revoked_at = now()
  where id = p_guest_id;

  update public.share_tokens
  set revoked_at = now()
  where id = v_share_token_id
    and household_id = v_household_id;

  return jsonb_build_object(
    'valid_token', true,
    'guest_found', true,
    'revoked', true
  );
end;
$$;

revoke all on function public.revoke_owner_guest(text, uuid) from public;
grant execute on function public.revoke_owner_guest(text, uuid) to anon, authenticated;
