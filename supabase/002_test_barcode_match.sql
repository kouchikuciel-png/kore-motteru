-- =========================================
-- 002_test_barcode_match
-- DB内部の完全一致テスト
-- =========================================

with arai as (
  select id
  from public.households
  where display_name = '新井家・試験'
  limit 1
)
select
  '4904075007420' as barcode,
  exists (
    select 1
    from public.household_items
    where household_id = (select id from arai)
      and barcode = '4904075007420'
  ) as registered

union all

select
  '4902521110991' as barcode,
  exists (
    select 1
    from public.household_items
    where household_id = (select id from arai)
      and barcode = '4902521110991'
  ) as registered;
