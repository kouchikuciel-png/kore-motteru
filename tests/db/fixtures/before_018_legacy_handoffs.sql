-- 018 適用前に存在しうる受け渡しデータを再現する（ローカル検証専用）。
-- 取消済みの行には、当時は取消日時を記録する列が無かった。
insert into public.handoff_requests
  (household_id, barcode, quantity, sender_key, sender_label, purchaser_label, status, created_at, received_at)
select h.id, v.barcode, v.quantity, 'legacy-device-key', 'ばあば', 'ばあば', v.status, v.created_at::timestamptz, v.received_at::timestamptz
from public.households h
cross join (values
  ('9784000000002', 1, 'PENDING',   '2026-09-20 04:20:00+00', null),
  ('9784000000002', 1, 'CANCELLED', '2026-09-20 04:35:00+00', null),
  ('9784000000002', 2, 'RECEIVED',  '2026-09-21 09:42:00+00', '2026-09-22 01:00:00+00')
) as v(barcode, quantity, status, created_at, received_at)
where h.display_name = '新井家・試験';
