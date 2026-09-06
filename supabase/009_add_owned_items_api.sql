-- =========================================
-- 009_add_owned_items_api
-- 共有リンクから家庭の所有物一覧を取得するRPC
-- =========================================

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
    and st.permission in ('CHECK', 'SHOP')
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

revoke all on function public.get_household_owned_items(text)
  from public;

grant execute on function public.get_household_owned_items(text)
  to anon, authenticated;
