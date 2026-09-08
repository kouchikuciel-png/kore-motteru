(() => {
  function isValidIsbn13Compat(value) {
    const isbn = String(value || "");
    if (!/^97[89]\d{10}$/.test(isbn)) return false;

    let sum = 0;
    for (let i = 0; i < 12; i += 1) {
      sum += Number(isbn[i]) * (i % 2 === 0 ? 1 : 3);
    }
    const check = (10 - (sum % 10)) % 10;
    return check === Number(isbn[12]);
  }

  function isValidIsbn10(value) {
    const isbn = String(value || "").toUpperCase();
    if (!/^\d{9}[\dX]$/.test(isbn)) return false;

    let sum = 0;
    for (let i = 0; i < 10; i += 1) {
      const digit = isbn[i] === "X" ? 10 : Number(isbn[i]);
      sum += digit * (10 - i);
    }
    return sum % 11 === 0;
  }

  function isbn10To13(value) {
    const isbn10 = String(value || "").toUpperCase();
    if (!isValidIsbn10(isbn10)) return null;

    const body = `978${isbn10.slice(0, 9)}`;
    let sum = 0;
    for (let i = 0; i < 12; i += 1) {
      sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
    }
    return `${body}${(10 - (sum % 10)) % 10}`;
  }

  function isbn13To10(value) {
    const isbn13 = String(value || "");
    if (!/^978\d{10}$/.test(isbn13)) return null;
    if (!isValidIsbn13Compat(isbn13)) return null;

    const body = isbn13.slice(3, 12);
    let sum = 0;
    for (let i = 0; i < 9; i += 1) {
      sum += Number(body[i]) * (10 - i);
    }
    const check = (11 - (sum % 11)) % 11;
    return `${body}${check === 10 ? "X" : check}`;
  }

  function findIsbn10(text) {
    const raw = String(text || "");
    const matches = raw.match(/ISBN(?:-10)?\s*:?[\s]*[0-9Xx\-\s]{10,28}/gi) || [];

    for (const match of matches) {
      const compact = match
        .replace(/^ISBN(?:-10)?\s*:?/i, "")
        .replace(/[^0-9Xx]/g, "")
        .toUpperCase();

      for (let i = 0; i <= compact.length - 10; i += 1) {
        const candidate = compact.slice(i, i + 10);
        if (isValidIsbn10(candidate)) return candidate;
      }
    }
    return null;
  }

  async function fetchOpenBdBook(isbn13) {
    const isbn = String(isbn13 || "");
    if (!isValidIsbn13Compat(isbn)) return null;

    const url = `https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(isbn)}`;

    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const data = await response.json();
      const record = Array.isArray(data) ? data[0] : null;
      const summary = record?.summary;
      if (!summary) return null;

      return {
        title: summary.title || "",
        author: summary.author || "",
        coverUrl: String(summary.cover || "").replace(/^http:/, "https:"),
      };
    } catch (error) {
      console.warn("openBD metadata unavailable", error);
      return null;
    }
  }

  async function fetchOpenLibrarySearchBook(isbn) {
    const url = `https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}&limit=1&fields=title,author_name,cover_i`;

    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const data = await response.json();
      const doc = data?.docs?.[0];
      if (!doc) return null;

      return {
        title: doc.title || "",
        author: Array.isArray(doc.author_name) ? doc.author_name.join(" / ") : "",
        coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : "",
      };
    } catch (error) {
      console.warn("Open Library search unavailable", error);
      return null;
    }
  }

  function mergeMetadata(current, next) {
    if (!next) return current;
    return {
      title: current?.title || next.title || "",
      author: current?.author || next.author || "",
      coverUrl: current?.coverUrl || next.coverUrl || "",
    };
  }

  const originalExtractValidIsbn = typeof extractValidIsbn === "function" ? extractValidIsbn : null;
  if (originalExtractValidIsbn) {
    window.extractValidIsbn = function patchedExtractValidIsbn(text) {
      const isbn13 = originalExtractValidIsbn(text);
      if (isbn13) return isbn13;

      const isbn10 = findIsbn10(text);
      return isbn10 ? isbn10To13(isbn10) : null;
    };
  }

  const originalGetOcrWorker = typeof getOcrWorker === "function" ? getOcrWorker : null;
  if (originalGetOcrWorker) {
    window.getOcrWorker = async function patchedGetOcrWorker() {
      const worker = await originalGetOcrWorker();
      await worker.setParameters({
        tessedit_char_whitelist: "ISBNisbnXx0123456789- ",
        tessedit_pageseg_mode: "6",
      });
      return worker;
    };
  }

  const originalFetchBookMetadata = typeof fetchBookMetadata === "function" ? fetchBookMetadata : null;
  if (originalFetchBookMetadata) {
    window.fetchBookMetadata = async function patchedFetchBookMetadata(isbn13) {
      const normalized = String(isbn13 || "");
      const candidates = [normalized];
      const legacy = isbn13To10(normalized);
      if (legacy) candidates.push(legacy);

      let best = null;

      // 日本の本はまずopenBDを確認する。タイトル・著者・書影の取得を最短経路にする。
      try {
        best = mergeMetadata(best, await fetchOpenBdBook(normalized));
        if (best?.title && best?.author && best?.coverUrl) return best;
      } catch (_) {}

      for (const candidate of candidates) {
        try {
          best = mergeMetadata(best, await fetchOpenLibraryBook(candidate));
          if (best?.title && best?.author && best?.coverUrl) return best;
        } catch (_) {}
      }

      for (const candidate of candidates) {
        try {
          best = mergeMetadata(best, await fetchOpenLibrarySearchBook(candidate));
          if (best?.title && best?.author && best?.coverUrl) return best;
        } catch (_) {}
      }

      for (const candidate of candidates) {
        try {
          best = mergeMetadata(best, await fetchGoogleBooksBook(candidate));
          if (best?.title && best?.author && best?.coverUrl) return best;
        } catch (_) {}
      }

      if (best && (best.title || best.author || best.coverUrl)) return best;

      return {
        title: "",
        author: "",
        coverUrl: `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(normalized)}-M.jpg?default=false`,
      };
    };
  }

  function installScanPriorityPatch() {
    if (typeof Html5Qrcode === "undefined") return;

    const prototype = Html5Qrcode.prototype;
    if (!prototype || prototype.__koreMotteruBookPriority) return;

    const originalStart = prototype.start;
    if (typeof originalStart !== "function") return;

    prototype.start = function prioritizedStart(
      cameraIdOrConfig,
      configuration,
      qrCodeSuccessCallback,
      qrCodeErrorCallback
    ) {
      const nextConfiguration = {
        ...(configuration || {}),
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          // 2本のバーコードが縦に並んでも同じ探索範囲に入りやすくする。
          const width = Math.max(180, Math.min(360, Math.floor(viewfinderWidth * 0.92)));
          const height = Math.max(120, Math.min(240, Math.floor(viewfinderHeight * 0.82)));
          return { width, height };
        },
      };

      const prioritizedSuccess = (decodedText, decodedResult) => {
        const barcode = String(decodedText || "").replace(/\D/g, "");

        // 本登録では978/979の有効なISBNバーコードだけを中核処理へ渡す。
        // 192...等は赤い案内だけ表示し、早すぎるOCR起動や処理競合を起こさない。
        if (/^\d{13}$/.test(barcode) && !isValidIsbn13Compat(barcode)) {
          return;
        }

        return qrCodeSuccessCallback(decodedText, decodedResult);
      };

      return originalStart.call(
        this,
        cameraIdOrConfig,
        nextConfiguration,
        prioritizedSuccess,
        qrCodeErrorCallback
      );
    };

    prototype.__koreMotteruBookPriority = true;
  }

  // owner-scan-feedback.js が先に赤表示用のラッパーを入れた後で外側から優先順位を適用する。
  // これにより「赤表示は出すが、誤バーコードは登録/OCR中核へ流さない」が両立する。
  setTimeout(installScanPriorityPatch, 0);

  window.koreMotteruIsbnCompat = {
    isValidIsbn10,
    isbn10To13,
    isbn13To10,
    fetchOpenBdBook,
  };
})();
