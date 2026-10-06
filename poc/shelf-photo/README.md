# 本棚写真 PoC（Issue #44）

本番アプリとは無関係のローカル実験コードです。アプリ（index.html / owner.html）からは読み込まれず、
Supabase にも接続しません。結果は [docs/poc/shelf-photo-poc.md](../../docs/poc/shelf-photo-poc.md)。

## 守っていること

- 写真は手元のファイルを読むだけで、保存・送信しない（外部 API・AI へ画像を送らない）
- 実ユーザーの写真・正解表・解析結果は repo に入れない（`.gitignore` で `input/` `output/` `*.jpg` 等を除外）
- 書誌照合は未接続（`OfflineMatcher`）。このため「高確度」は絶対に出ない＝誤登録ゼロ側に倒している

## 必要なもの

- Python 3.11+、`pip install pillow numpy opencv-python-headless`
- Tesseract 5 と日本語データ（例: `apt install tesseract-ocr tesseract-ocr-jpn tesseract-ocr-jpn-vert`）

## 使い方

```sh
python3 shelf_poc.py 写真.jpg --compartments 区画.json [--truth 正解表.json] [--out 結果.json]
```

- 区画.json は `compartments.example.json` の形式（区画名 → `[x0, y0, x1, y1]`）
- 正解表は任意。`title_readable`（人間が確実に読める題名・区画・x 範囲）を書くと、取れた文字列との突き合わせを出す

## 判定区分

| 区分 | 意味 |
|---|---|
| high（高確度） | 書誌照合で ISBN が一意に決まった時だけ。今回は照合未接続のため 0 固定 |
| review（要確認） | 意味のある文字列（日本語3字以上 / 英単語4字以上）が取れた。人の確認が必須 |
| unknown（不明） | 背表紙らしき領域はあるが文字列が取れない |
| insufficient（情報不足） | 背表紙幅が 10px 未満で、画像そのものに識別情報が写っていない |
