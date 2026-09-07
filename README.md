# kore-motteru

家庭の所有物と購入予定を重ねて、重複を「禁止せず警告」する共有状態アプリの初号機。

## 目標

2026-10-06 に新井くんが実生活で使い始められる状態にする。

初号機の中心ユースケースは絵本。

- 家主が持っている本を登録する
- 祖父母など第三者が所有リストを見る
- バーコードで所有・購入予定を確認する
- 重複していても購入は禁止しない
- 「重複しています。それでも買いますか？」と判断を人に返す
- 複数人の購入予定をレイヤーとして重ねる

## 現在のGREEN

### 共有側

- GitHub Pages 公開
- Safari 実機カメラ起動
- EAN-13 / EAN-8 自動読取
- Supabase の家庭別所有物照合
- SHOP共有トークン
- 所有数量 / 購入予定数量の集計
- 重複警告
- 重複していても購入予定へ追加可能
- 購入数量を複数指定可能
- 所有リスト表示
- ISBN書誌情報の補完
- 所有カードの詳細表示

### レイヤー実証

同一コードで以下を実機確認済み。

- owned_quantity = 1
- planned_quantity = 2
- さらに数量2を購入予定へ追加
- planned_quantity = 4 へ更新

よって「重複は検知するが、禁止しない」モデルはGREEN。

## 家主登録ライン

実装済み、Supabase適用・実機試験待ち。

- `supabase/010_add_owner_registration_api.sql`
- `owner.html`
- `owner.js`

設計:

1. OWNER専用トークンで家主権限をSHOP共有権限から分離
2. 「カメラで登録する」を1回押す
3. バーコードを優先して自動検出
4. 数秒見つからなければISBN印字を自動OCR
5. ISBN-13はチェック桁を検算
6. 正しいコードだけ `register_household_item` RPC へ送る
7. 同じコードの再スキャンは数量を勝手に増やさない
8. 写真自体は保存しない

### 次の受入ゲート

`010_add_owner_registration_api.sql` をSupabaseへ適用し、返されたOWNER URLをiPhone Safariで開く。

次の2ケースが通れば「家主登録ライン GREEN」。

#### A. バーコードあり

- カメラ起動
- 自動読取
- 所有物へ登録
- 再登録時は「すでに登録されています」

#### B. バーコードなし・ISBN印字あり

例: `ISBN978-4-19-862573-3`

- カメラ起動
- バーコードが無いまま数秒待つ
- ISBN文字を自動認識
- `9784198625733` へ正規化
- ISBNチェック桁を通過
- 所有物へ登録

## セキュリティ原則

- 生の共有トークンはDBへ保存しない
- DBにはSHA-256ハッシュだけ保存
- OWNERとSHOPを分離
- ブラウザからテーブルを直接読まない
- SECURITY DEFINER RPC 経由のみ
- 商品→所有者の逆引きAPIを作らない
- 家庭IDや家庭の全データを第三者へ直接公開しない

## データ設計の原則

「あとから再現できない事実は、発生時に記録する」。

主なイベント:

- REGISTER
- CHECK_MATCH
- CHECK_NOT_FOUND
- SCAN_FAILED
- DELETE

## 主要SQL

- `001_create_schema.sql`
- `002_test_barcode_match.sql`
- `003_create_share_check_api.sql`
- `004_test_share_check_api.sql`
- `005_rotate_share_token.sql`
- `006_shared_cart_foundation.sql`
- `007_test_purchase_layers.sql`
- `008_add_purchase_plan_api.sql`
- `009_add_owned_items_api.sql`
- `010_add_owner_registration_api.sql`

## 初号機でやらないもの

- 消耗品の購入周期予測
- レシートOCR
- 家計簿
- 家電取説管理
- PDF検索
- AI類似商品判定
- シリーズ・色違いの自動同一視
- Amazon / 楽天の商品画像への依存
- 手入力中心の管理

まず新井くんが実生活で使い、現実の摩擦から次の仕様を決める。
