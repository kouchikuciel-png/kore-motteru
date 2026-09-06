-- =========================================
-- 007_test_purchase_layers
-- A/B購入予定レイヤーの重複許容テスト
-- =========================================

-- Bさんも同じ商品を1個プレゼント予定にする
insert into public.purchase_plans (
  household_id,
  barcode,
  buyer_label,
  quantity,
  status,
  visibility
)
select
  id,
  '4909411089368',
  'Bさん・試験',
  1,
  'PLANNED',
  'GIFT_SECRET'
from public.households
where display_name = '新井家・試験'
limit 1;

-- 所有数量と購入予定数量を確認
select
  '4909411089368' as barcode,
  coalesce((
    select sum(hi.quantity)
    from public.household_items hi
    join public.households h
      on h.id = hi.household_id
    where h.display_name = '新井家・試験'
      and hi.barcode = '4909411089368'
  ), 0) as owned_quantity,
  coalesce((
    select sum(pp.quantity)
    from public.purchase_plans pp
    join public.households h
      on h.id = pp.household_id
    where h.display_name = '新井家・試験'
      and pp.barcode = '4909411089368'
      and pp.status = 'PLANNED'
  ), 0) as planned_quantity;
