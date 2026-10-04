// 表紙候補チェーン（オーナー本登録・ゲスト本棚と同じ規則）。
// 1. 書誌取得で得た coverUrls / coverUrl を重複なく並べる（http は https へ）
// 2. 各候補に表紙中継（book-cover-proxy）版を足す。Google系は中継を先、それ以外は直接を先
// 3. 先頭から順に読み込み、失敗・白いダミー（小さすぎる画像）は次の候補へ
// 4. 全候補が失敗した時だけ📚に戻す
(() => {
  // オーナー本登録（owner-cover-proxy.js）と同じ「白いダミー」判定。
  const MIN_WIDTH = 40;
  const MIN_HEIGHT = 50;

  function uniqueCoverUrls(values) {
    const seen = new Set();
    const urls = [];
    for (const value of values || []) {
      const url = String(value || "").trim().replace(/^http:/, "https:");
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
    return urls;
  }

  function prefersProxyFirst(source) {
    try {
      const host = new URL(source).hostname.toLowerCase();
      return host === "books.google.com" ||
        host === "books.google.co.jp" ||
        host.endsWith(".googleusercontent.com");
    } catch (_) {
      return false;
    }
  }

  function coverProxyUrl(proxyBase, source) {
    return `${proxyBase}?src=${encodeURIComponent(source)}`;
  }

  // metadata（{ coverUrls, coverUrl }）から、試す順番の候補一覧を作る。
  function expandCoverCandidates(metadata, proxyBase) {
    const raw = uniqueCoverUrls([
      ...(Array.isArray(metadata?.coverUrls) ? metadata.coverUrls : []),
      metadata?.coverUrl || "",
    ]);
    if (!proxyBase) return raw;

    const expanded = [];
    for (const source of raw) {
      if (source.startsWith(proxyBase)) {
        expanded.push(source);
      } else if (prefersProxyFirst(source)) {
        expanded.push(coverProxyUrl(proxyBase, source), source);
      } else {
        expanded.push(source, coverProxyUrl(proxyBase, source));
      }
    }
    return uniqueCoverUrls(expanded);
  }

  // container に候補を順に試して表紙を入れる。成功までは container の中身（📚）を変えない。
  // 戻り値の Promise は { status: "loaded" | "failed" | "empty" | "aborted", url, tried } で解決する。
  function loadCoverChain(container, urls, options = {}) {
    const candidates = uniqueCoverUrls(urls);
    const createImage = options.createImage || (() => document.createElement("img"));
    const isCurrent = options.isCurrent || (() => true);
    const minWidth = options.minWidth ?? MIN_WIDTH;
    const minHeight = options.minHeight ?? MIN_HEIGHT;
    const fallback = options.fallbackHtml ?? '<span aria-hidden="true">📚</span>';

    return new Promise((resolve) => {
      if (candidates.length === 0) {
        resolve({ status: "empty", url: "", tried: 0 });
        return;
      }

      let index = 0;
      const tryNext = () => {
        if (!isCurrent()) {
          resolve({ status: "aborted", url: "", tried: index });
          return;
        }
        if (index >= candidates.length) {
          container.innerHTML = fallback;
          resolve({ status: "failed", url: "", tried: index });
          return;
        }

        const url = candidates[index++];
        const image = createImage();
        image.alt = options.alt || "本の表紙";
        if ("decoding" in image) image.decoding = "async";
        image.onload = () => {
          if (!isCurrent()) {
            resolve({ status: "aborted", url: "", tried: index });
            return;
          }
          if (Number(image.naturalWidth || 0) < minWidth || Number(image.naturalHeight || 0) < minHeight) {
            tryNext();
            return;
          }
          if (typeof container.replaceChildren === "function") container.replaceChildren(image);
          else {
            container.innerHTML = "";
            container.appendChild(image);
          }
          resolve({ status: "loaded", url, tried: index });
        };
        image.onerror = tryNext;
        image.src = url;
      };

      tryNext();
    });
  }

  const api = {
    MIN_WIDTH,
    MIN_HEIGHT,
    uniqueCoverUrls,
    expandCoverCandidates,
    loadCoverChain,
  };

  if (typeof window !== "undefined") {
    window.KoreMotteruCoverChain = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
