-- =========================================
-- 014_provenance_visibility
-- 「誰から来た本か」の来歴表示を家庭ごとにオーナーが選べるようにする。
-- null = 未選択。false = 非表示。true = 表示。
-- 来歴データ自体は表示設定に関係なく保持する。
-- =========================================

alter table public.households
  add column if not exists show_item_provenance boolean;

create or replace function public.get_owner_household_settings(
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid;
  v_show_item_provenance boolean;
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

  select h.show_item_provenance
    into v_show_item_provenance
  from public.households h
  where h.id = v_household_id;

  return jsonb_build_object(
    'valid_token', true,
    'provenance_visibility_chosen', v_show_item_provenance is not null,
    'show_item_provenance', coalesce(v_show_item_provenance, false)
  );
end;
$$;

revoke all on function public.get_owner_household_settings(text) from public;
grant execute on function public.get_owner_household_settings(text) to anon, authenticated;

create or replace function public.set_owner_provenance_visibility(
  p_token text,
  p_show boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid;
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

  if p_show is null then
    return jsonb_build_object(
      'valid_token', true,
      'valid_value', false
    );
  end if;

  update public.households
  set show_item_provenance = p_show
  where id = v_household_id;

  return jsonb_build_object(
    'valid_token', true,
    'valid_value', true,
    'provenance_visibility_chosen', true,
    'show_item_provenance', p_show
  );
end;
$$;

revoke all on function public.set_owner_provenance_visibility(text, boolean) from public;
grant execute on function public.set_owner_provenance_visibility(text, boolean) to anon, authenticated;

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
  v_show_item_provenance boolean := false;
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
      'show_item_provenance', false,
      'items', '[]'::jsonb
    );
  end if;

  select coalesce(h.show_item_provenance, false)
    into v_show_item_provenance
  from public.households h
  where h.id = v_household_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'barcode', hi.barcode,
        'quantity', hi.quantity,
        'registered_at', hi.registered_at,
        'origins',
          case
            when v_show_item_provenance
              then coalesce(origin_rows.origins, '[]'::jsonb)
            else '[]'::jsonb
          end
      )
      order by hi.registered_at desc
    ),
    '[]'::jsonb
  )
  into v_items
  from public.household_items hi
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'quantity', io.quantity,
        'purchaser_label', io.purchaser_label,
        'giver_label', io.giver_label,
        'acquisition_type', io.acquisition_type,
        'acquired_at', io.acquired_at
      )
      order by io.acquired_at desc, io.id desc
    ) as origins
    from public.item_origins io
    where v_show_item_provenance
      and io.household_id = hi.household_id
      and io.barcode = hi.barcode
  ) origin_rows on true
  where hi.household_id = v_household_id;

  return jsonb_build_object(
    'valid_token', true,
    'show_item_provenance', v_show_item_provenance,
    'items', v_items
  );
end;
$$;

revoke all on function public.get_household_owned_items(text) from public;
grant execute on function public.get_household_owned_items(text) to anon, authenticated;
