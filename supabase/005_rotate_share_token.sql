-- =========================================
-- 005_rotate_share_token
-- 現在の共有トークンを失効し、新しい完成URLを1本発行する
-- =========================================

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
    and revoked_at is null
  returning id
),
raw as (
  select encode(gen_random_bytes(32), 'hex') as token
),
saved as (
  insert into public.share_tokens (
    household_id,
    token_hash
  )
  select
    target.id,
    encode(digest(raw.token, 'sha256'), 'hex')
  from raw, target
  returning id
)
select
  'https://kouchikuciel-png.github.io/kore-motteru/#token='
  || raw.token as share_url
from raw, saved;
