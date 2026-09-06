-- =========================================
-- 004_test_share_check_api
-- 共有トークン経由の照合テスト
-- 実際の共有トークンはGitHubへ保存しない
-- =========================================

select
  public.check_household_barcode(
    'ここに共有トークン',
    '4904075007420'
  ) as registered_item,

  public.check_household_barcode(
    'ここに共有トークン',
    '4902521110991'
  ) as unregistered_item;
