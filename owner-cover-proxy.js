(() => {
  const COVER_PROXY_BASE = `${SUPABASE_URL}/functions/v1/book-cover-proxy`;
  const diag = [];
  function resetDiag(isbn) { diag.length = 0; logDiag(`ISBN ${isbn}`); }
  function logDiag(message, data) {
    const line = data === undefined ? message : `${message} ${typeof data === "string" ? data : JSON.stringify(data)}`;
    diag.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
    window.__coverDiagnostics = [...diag];
    console.info("[cover-diag]", line);
  }
  function exposeDiag() {
    window.getCoverDiagnostics = () => [...diag];
    window.copyCoverDiagnostics = async () => {
      const text = diag.join("\n");
      try { await navigator.clipboard.writeText(text); } catch (_) {}
      return text;
    };
  }
  exposeDiag();

  function uniqueUrls(values) {
    const seen = new Set(), result = [];
    for (const value of values || []) {
      const url = String(value || "").trim().replace(/^http:/, "https:");
      if (!url || seen.has(url)) continue;
      seen.add(url); result.push(url);
    }
    return result;
  }
  function cleanAuthorName(value) {
    let text = String(value || "").normalize("NFKC").trim();
    if (!text) return "";
    text = text.replace(/\s*[（(]?\s*\d{4}\s*[-–—]\s*\d{0,4}\s*[）)]?\s*$/u, "");
    text = text.replace(/\s*,\s*(?=\d{4}\b).*$/u, "");
    return text.replace(/\s*,\s*/g, " ").replace(/\s+/g, " ").trim();
  }
  function proxyUrl(source) { return `${COVER_PROXY_BASE}?src=${encodeURIComponent(source)}`; }
  function preferProxyFirst(source) {
    try {
      const host = new URL(source).hostname.toLowerCase();
      return host === "books.google.com" || host === "books.google.co.jp" || host.endsWith(".googleusercontent.com");
    } catch (_) { return false; }
  }
  function expandCoverCandidates(values) {
    const expanded = [];
    for (const source of uniqueUrls(values)) {
      if (preferProxyFirst(source)) expanded.push(proxyUrl(source), source);
      else expanded.push(source, proxyUrl(source));
    }
    return uniqueUrls(expanded);
  }
  function describeUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.pathname.includes("book-cover-proxy")) {
        const src = parsed.searchParams.get("src");
        return `proxy→${src ? new URL(src).hostname : "?"}`;
      }
      return parsed.hostname;
    } catch (_) { return "invalid-url"; }
  }
  async function probeCandidate(url, n) {
    try {
      const response = await fetch(url, { method: "GET", cache: "no-store" });
      const type = response.headers.get("content-type") || "";
      logDiag(`candidate#${n} fetch`, `${describeUrl(url)} status=${response.status} type=${type || "-"}`);
    } catch (error) {
      logDiag(`candidate#${n} fetch-error`, `${describeUrl(url)} ${error?.name || "Error"}:${error?.message || error}`);
    }
  }

  if (typeof loadBookPreview !== "function") return;
  window.loadBookPreview = async function loadBookPreviewViaProxy(isbn) {
    resetDiag(isbn);
    showBookPreviewLoading();
    logDiag("metadata:start");
    const metadata = await fetchBookMetadata(isbn);
    if (pendingCode !== isbn) { logDiag("abort:pendingCode changed"); return; }
    logDiag("metadata:result", { title: metadata?.title || "", author: metadata?.author || "", rawCoverCount: uniqueUrls([...(metadata?.coverUrls || []), metadata?.coverUrl]).length });
    if (!metadata || (!metadata.title && !(metadata.coverUrls || []).length && !metadata.coverUrl)) {
      logDiag("stop:no metadata and no cover candidates");
      bookPreview.classList.add("hidden"); return;
    }

    bookTitle.textContent = metadata.title || "本の名前は見つかりませんでした";
    const author = cleanAuthorName(metadata.author || "");
    if (author) { bookAuthor.textContent = author; bookAuthor.classList.remove("hidden"); }
    else bookAuthor.classList.add("hidden");

    const rawUrls = uniqueUrls([...(metadata.coverUrls || []), metadata.coverUrl]);
    const coverUrls = expandCoverCandidates(rawUrls);
    logDiag("covers:candidates", { raw: rawUrls.length, expanded: coverUrls.length, hosts: coverUrls.slice(0, 12).map(describeUrl) });
    if (coverUrls.length === 0) {
      logDiag("stop:zero cover candidates");
      bookCover.innerHTML = '<span aria-hidden="true">📚</span>';
      bookLoading.textContent = "表紙候補が見つかりませんでした。";
      bookLoading.classList.remove("hidden"); return;
    }

    let index = 0;
    const tryNext = () => {
      if (pendingCode !== isbn) { logDiag("abort:image pendingCode changed"); return; }
      if (index >= coverUrls.length) {
        logDiag("stop:all candidates failed");
        bookCover.innerHTML = '<span aria-hidden="true">📚</span>';
        bookLoading.textContent = "表紙は見つかりませんでした。";
        bookLoading.classList.remove("hidden"); return;
      }
      const n = index + 1;
      const url = coverUrls[index++];
      logDiag(`candidate#${n}:img-start`, describeUrl(url));
      const image = document.createElement("img");
      image.alt = `${metadata.title || "本"}の表紙`;
      image.loading = "eager"; image.decoding = "async";
      image.onload = () => {
        if (pendingCode !== isbn) return;
        logDiag(`candidate#${n}:img-load`, `${describeUrl(url)} ${image.naturalWidth}x${image.naturalHeight}`);
        if (image.naturalWidth < 40 || image.naturalHeight < 50) {
          logDiag(`candidate#${n}:reject-small`); return tryNext();
        }
        bookCover.innerHTML = ""; bookCover.appendChild(image);
        bookLoading.classList.add("hidden");
        logDiag(`success:candidate#${n}`, describeUrl(url));
      };
      image.onerror = () => {
        logDiag(`candidate#${n}:img-error`, describeUrl(url));
        probeCandidate(url, n);
        tryNext();
      };
      image.src = url;
    };
    bookLoading.textContent = "表紙を探しています…";
    bookLoading.classList.remove("hidden");
    tryNext();
  };
})();

(() => {
  if (document.querySelector('script[data-owner-tutorial-v2]')) return;
  window.__ownerTutorialV2Pending = false;
  window.openTutorial = () => { window.__ownerTutorialV2Pending = true; };
  const script = document.createElement("script");
  script.src = "./owner-tutorial-v2.js";
  script.dataset.ownerTutorialV2 = "1";
  document.head.appendChild(script);
})();
