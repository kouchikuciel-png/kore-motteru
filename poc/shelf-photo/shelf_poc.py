#!/usr/bin/env python3
"""Issue #44 PoC: 本棚写真から既存在庫の候補を起こせるかをローカルで実測する。

本番フロー（owner.html / Supabase）とは完全に切り離している。DB へは何も書かない。
写真はローカルで処理し、外部へ送らない（書誌照合を有効にした場合だけ、
OCR で得た「タイトル文字列」を書誌検索APIへ送る。画像は送らない）。

流れ:
  1. 棚の区画（コンパートメント）を切り出す（--compartments で矩形を与える）
  2. 区画内の背表紙を縦方向のエッジから自動で切り分ける
  3. 背表紙ごとに「画像に識別情報が足りているか」を画素数で判定する
  4. 区画を幅 28px・10px 刻みの重なり窓で縦書き OCR（Tesseract jpn_vert）にかけ、
     信頼度 60 以上の文字だけをつなぐ（背表紙の自動切り分けがずれても文字を拾えるように）。
     得た断片は、窓が重なる背表紙に結びつける
  5. OCR 文字列を書誌照合にかけ、確信度で分類する
       high   : 書誌検索で1件に絞れ、OCR 文字列がタイトル全体と一致（自動提示してよい）
       review : 意味のある文字列は取れたが、1件に絞れない／照合できない（人が選ぶ）
       unknown: 本らしいが文字が取れない（登録しない）
       insufficient: 写真の解像度上、識別情報がそもそも写っていない（撮り直し・近接撮影が必要）

precision 優先: 書誌照合で一意に確定しない限り high にしない。照合器が無い（オフライン）
場合、high は常に 0 件になる。

使い方:
  python3 shelf_poc.py PHOTO --compartments compartments.json [--truth truth.json] [--out out.json]
必要なもの: Pillow, numpy, opencv-python-headless, tesseract（jpn, jpn_vert, eng）
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import unicodedata
from dataclasses import dataclass, field, asdict
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

# ---- 判定のしきい値（PoC で実測しながら決めた値。docs に根拠を書く） ----
# 背表紙の幅がこれ未満だと、縦書きタイトル1文字が約 0.7×幅 ≒ 7px 未満になり、
# 人間が拡大しても確実には読めない（テストデータ#1 の人手正解で確認）。
MIN_SPINE_WIDTH_PX = 10
# OCR 文字列のうち「意味のある断片」とみなす最小長（ノイズ1〜2文字を捨てる）
MIN_JA_RUN = 3
MIN_LATIN_WORD = 4
UPSCALE = 4
# 重なり窓 OCR（実測で、正確に切り出した場合に近い読み取りになった設定）
WINDOW_WIDTH_PX = 28
WINDOW_STEP_PX = 10
MIN_WORD_CONFIDENCE = 60

JA_RUN = re.compile(r"[ぁ-ゖァ-ヺー一-鿿]{%d,}" % MIN_JA_RUN)
LATIN_WORD = re.compile(r"[A-Za-z]{%d,}" % MIN_LATIN_WORD)


@dataclass
class Spine:
    compartment: str
    x0: int
    x1: int
    y0: int
    y1: int
    status: str = "unknown"
    ocr_text: str = ""
    fragments: list[str] = field(default_factory=list)
    candidates: list[dict] = field(default_factory=list)
    reason: str = ""

    @property
    def width(self) -> int:
        return self.x1 - self.x0


def load_photo(path: Path) -> Image.Image:
    # EXIF の回転だけ反映し、メタデータ（撮影機種・位置情報など）は以降使わない。
    image = Image.open(path)
    image = ImageOps.exif_transpose(image)
    return image.convert("RGB")


def find_spine_boundaries(gray: np.ndarray) -> list[int]:
    """区画画像の列ごとの縦エッジ強度から、背表紙の境目（x座標）を返す。"""
    h, _ = gray.shape
    band = gray[int(h * 0.2): int(h * 0.85), :]
    sobel = np.abs(cv2.Sobel(band, cv2.CV_32F, 1, 0, ksize=3))
    profile = sobel.mean(axis=0)
    profile = np.convolve(profile, np.ones(3) / 3, mode="same")
    threshold = profile.mean() + 0.35 * profile.std()
    peaks: list[int] = []
    for x in range(1, len(profile) - 1):
        if profile[x] >= threshold and profile[x] >= profile[x - 1] and profile[x] >= profile[x + 1]:
            if peaks and x - peaks[-1] < 4:
                if profile[x] > profile[peaks[-1]]:
                    peaks[-1] = x
                continue
            peaks.append(x)
    return peaks


def segment_spines(image: Image.Image, name: str, box: list[int]) -> list[Spine]:
    x0, y0, x1, y1 = box
    crop = np.asarray(image.crop((x0, y0, x1, y1)).convert("L"))
    bounds = [0, *find_spine_boundaries(crop), crop.shape[1]]
    spines = []
    for left, right in zip(bounds, bounds[1:]):
        if right - left < 3:
            continue
        spines.append(Spine(name, x0 + left, x0 + right, y0, y1))
    return spines


def _png_bytes(image: Image.Image) -> bytes:
    import io
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def meaningful_fragments(text: str) -> list[str]:
    text = unicodedata.normalize("NFKC", text)
    fragments = JA_RUN.findall(text) + LATIN_WORD.findall(text)
    # 「ルルルルル」のように同じ文字が大半を占める断片は、木目や縞模様の誤読として捨てる。
    return [f for f in fragments if max(f.count(ch) for ch in set(f)) / len(f) <= 0.5]


def tesseract_confident_text(image: Image.Image, lang: str, psm: str) -> str:
    proc = subprocess.run(
        ["tesseract", "stdin", "stdout", "-l", lang, "--psm", psm, "tsv"],
        input=_png_bytes(image), capture_output=True, check=False,
    )
    words = []
    for line in proc.stdout.decode("utf-8", "ignore").splitlines()[1:]:
        cols = line.split("\t")
        if len(cols) == 12 and cols[11].strip():
            try:
                if float(cols[10]) >= MIN_WORD_CONFIDENCE:
                    words.append(cols[11].strip())
            except ValueError:
                pass
    return "".join(words)


def window_ocr(image: Image.Image, name: str, box: list[int]) -> list[dict]:
    """区画を重なり窓で縦書き OCR し、窓ごとの意味のある断片を返す。"""
    x0, y0, x1, y1 = box
    hits = []
    for wx in range(x0, max(x0 + 1, x1 - WINDOW_WIDTH_PX + 8), WINDOW_STEP_PX):
        crop = ImageOps.autocontrast(image.crop((wx, y0, wx + WINDOW_WIDTH_PX, y1)).convert("L"))
        crop = crop.resize((crop.width * UPSCALE, crop.height * UPSCALE), Image.LANCZOS)
        text = tesseract_confident_text(crop, "jpn_vert", "5")
        for fragment in meaningful_fragments(text):
            hits.append({"compartment": name, "x0": wx, "x1": wx + WINDOW_WIDTH_PX, "fragment": fragment, "text": text})
    return hits


def normalize_title(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "").lower()
    return re.sub(r"[\s・:：、。,.!！?？「」『』（）()\-ー〜~]", "", value)


class OfflineMatcher:
    """書誌検索APIに届かない環境用。照合できないので high は付けない。"""

    available = False

    def search(self, fragment: str) -> list[dict]:
        return []


def classify(spine: Spine, matcher) -> None:
    # 文字が取れた背表紙は、幅が細くても「情報不足」にはしない（実際に写っている）。
    if spine.width < MIN_SPINE_WIDTH_PX and not spine.fragments:
        spine.status = "insufficient"
        spine.reason = f"背表紙の幅 {spine.width}px < {MIN_SPINE_WIDTH_PX}px（文字が写るだけの画素がない）"
        return
    if not spine.fragments:
        spine.status = "unknown"
        spine.reason = "OCR で意味のある文字列が取れない"
        return
    if not matcher.available:
        spine.status = "review"
        spine.reason = "文字列は取れたが書誌照合できない（オフライン）"
        return
    for fragment in spine.fragments:
        results = matcher.search(fragment)
        spine.candidates.extend(results)
        exact = [r for r in results if normalize_title(r.get("title")) == normalize_title(fragment)]
        isbns = {r.get("isbn") for r in exact if r.get("isbn")}
        if len(isbns) == 1:
            spine.status = "high"
            spine.reason = f"OCR「{fragment}」がタイトル全体と一致し、書誌が1件に絞れた"
            return
    spine.status = "review"
    spine.reason = "候補が複数・部分一致のみ。人が選ぶ"


def longest_common_substring(a: str, b: str) -> str:
    best = ""
    for i in range(len(a)):
        for j in range(i + len(best) + 1, len(a) + 1):
            if a[i:j] in b:
                best = a[i:j]
            else:
                break
    return best


# 実測で、OCR はタイトルの一部を1〜2文字誤読する（例: サ→ョ、ブ→プ）。
# 3文字以上連続して正しければ、書誌のタイトル部分一致検索で候補に入りうるとみなす。
MIN_USEFUL_OVERLAP = 3


def evaluate(spines: list[Spine], truth: dict) -> dict:
    """人手正解（truth.json）と突き合わせる。正解は画像座標の x 範囲で背表紙に対応づける。"""
    report = {"readable_titles": []}
    for entry in truth.get("title_readable", []):
        lo, hi = entry["x_range"]
        overlapping = [s for s in spines if s.compartment == entry["compartment"] and s.x1 > lo and s.x0 < hi]
        title_norm = normalize_title(entry["title"])
        overlaps = sorted({
            (f, longest_common_substring(normalize_title(f), title_norm))
            for s in overlapping for f in s.fragments
        }, key=lambda pair: -len(pair[1]))
        useful = [{"ocr": f, "matches": common} for f, common in overlaps if len(common) >= MIN_USEFUL_OVERLAP]
        report["readable_titles"].append({
            "title": entry["title"],
            "detected_as_spine": bool(overlapping),
            "statuses": sorted({s.status for s in overlapping}),
            "ocr_useful_fragments": useful,
        })
    flagged = [s for s in spines if s.status in ("high", "review")]
    truth_ranges = [(e["compartment"], *e["x_range"]) for e in truth.get("title_readable", [])]
    false_flags = [
        {"compartment": s.compartment, "x0": s.x0, "x1": s.x1, "fragments": s.fragments}
        for s in flagged
        if not any(c == s.compartment and s.x1 > lo and s.x0 < hi for c, lo, hi in truth_ranges)
    ]
    report["flagged_total"] = len(flagged)
    report["flagged_not_matching_any_readable_title"] = false_flags
    report["high_count"] = sum(1 for s in spines if s.status == "high")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("photo", type=Path)
    parser.add_argument("--compartments", type=Path, required=True)
    parser.add_argument("--truth", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    started = time.time()
    image = load_photo(args.photo)
    compartments = json.loads(args.compartments.read_text(encoding="utf-8"))
    compartments = {k: v for k, v in compartments.items() if not k.startswith("_")}
    matcher = OfflineMatcher()

    spines: list[Spine] = []
    hits: list[dict] = []
    for name, box in compartments.items():
        spines.extend(segment_spines(image, name, box))
        hits.extend(window_ocr(image, name, box))
    # 断片は、窓の中心が入る背表紙（無ければ最も近い背表紙）に結びつける。
    for hit in hits:
        center = (hit["x0"] + hit["x1"]) / 2
        same = [s for s in spines if s.compartment == hit["compartment"]]
        if not same:
            continue
        target = min(same, key=lambda s: 0 if s.x0 <= center < s.x1 else min(abs(s.x0 - center), abs(s.x1 - center)))
        if hit["fragment"] not in target.fragments:
            target.fragments.append(hit["fragment"])
            target.ocr_text = (target.ocr_text + " | " + hit["text"]).strip(" |")
    for spine in spines:
        classify(spine, matcher)
    elapsed = time.time() - started

    by_compartment: dict[str, dict] = {}
    for spine in spines:
        row = by_compartment.setdefault(spine.compartment, {"detected": 0, "high": 0, "review": 0, "unknown": 0, "insufficient": 0})
        row["detected"] += 1
        row[spine.status] += 1
    totals = {key: sum(row[key] for row in by_compartment.values()) for key in ["detected", "high", "review", "unknown", "insufficient"]}

    result = {
        "image_size": image.size,
        "seconds": round(elapsed, 1),
        "matcher": "offline (書誌APIに到達できない環境)" if not matcher.available else type(matcher).__name__,
        "totals": totals,
        "by_compartment": by_compartment,
        "review_spines": [asdict(s) for s in spines if s.status in ("high", "review")],
        "window_hits": hits,
    }
    if args.truth:
        result["evaluation"] = evaluate(spines, json.loads(args.truth.read_text(encoding="utf-8")))

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        args.out.write_text(text, encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
