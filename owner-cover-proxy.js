(() => {
  const COVER_PROXY_BASE = `${SUPABASE_URL}/functions/v1/book-cover-proxy`;

  function uniqueUrls(values) {
    const seen = new Set();
    const result = [];
    for (const value of values || []) {
      const url = String(value || "").trim().replace(/^http:/, "https:");
      if (!url || seen.has(url)) continue;
      seen.add(url);
      result.push(url);
    }
    return result;
  }

  function proxyUrl(source) {
    return `${COVER_PROXY_BASE}?src=${encodeURIComponent(source)}`;
  }

  function preferProxyFirst(source) {
    try {
      const host = new URL(source).hostname.toLowerCase();
      return host === "books.google.com" ||
        host === "books.google.co.jp" ||
        host.endsWith(".googleusercontent.com");
    } catch (_) {
      return false;
    }
  }

  function expandCoverCandidates(values) {
    const expanded = [];
    for (const source of uniqueUrls(values)) {
      if (preferProxyFirst(source)) {
        expanded.push(proxyUrl(source), source);
      } else {
        expanded.push(source, proxyUrl(source));
      }
    }
    return uniqueUrls(expanded);
  }

  if (typeof loadBookPreview !== "function") return;

  window.loadBookPreview = async function loadBookPreviewViaProxy(isbn) {
    showBookPreviewLoading();
    const metadata = await fetchBookMetadata(isbn);
    if (pendingCode !== isbn) return;

    if (!metadata || (!metadata.title && !(metadata.coverUrls || []).length && !metadata.coverUrl)) {
      bookPreview.classList.add("hidden");
      return;
    }

    bookTitle.textContent = metadata.title || "本の名前は見つかりませんでした";

    if (metadata.author) {
      bookAuthor.textContent = metadata.author;
      bookAuthor.classList.remove("hidden");
    } else {
      bookAuthor.classList.add("hidden");
    }

    const coverUrls = expandCoverCandidates([
      ...(metadata.coverUrls || []),
      metadata.coverUrl,
    ]);

    if (coverUrls.length === 0) {
      bookCover.innerHTML = '<span aria-hidden="true">📚</span>';
      bookLoading.classList.add("hidden");
      return;
    }

    let index = 0;
    const tryNext = () => {
      if (pendingCode !== isbn) return;

      if (index >= coverUrls.length) {
        bookCover.innerHTML = '<span aria-hidden="true">📚</span>';
        bookLoading.textContent = "表紙は見つかりませんでした。";
        bookLoading.classList.remove("hidden");
        return;
      }

      const url = coverUrls[index++];
      const image = document.createElement("img");
      image.alt = `${metadata.title || "本"}の表紙`;
      image.loading = "eager";
      image.decoding = "async";
      image.onload = () => {
        if (pendingCode !== isbn) return;
        if (image.naturalWidth < 40 || image.naturalHeight < 50) {
          tryNext();
          return;
        }

        bookCover.innerHTML = "";
        bookCover.appendChild(image);
        bookLoading.classList.add("hidden");
      };
      image.onerror = tryNext;
      image.src = url;
    };

    bookLoading.textContent = "表紙を探しています…";
    bookLoading.classList.remove("hidden");
    tryNext();
  };
})();

// 初回ガイドは別ファイルで段階的に改善できるよう、ここから読み込む。
(() => {
  if (document.querySelector('script[data-owner-tutorial-v2]')) return;
  const script = document.createElement("script");
  script.src = "./owner-tutorial-v2.js";
  script.dataset.ownerTutorialV2 = "1";
  document.head.appendChild(script);
})();
