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

  function normalizeLookupText(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s\u3000・:：,，.。!！?？\-―ー_（）()［］\[\]「」『』【】]/g, "");
  }

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

  function googleImageUrls(volume) {
    const links = volume?.imageLinks || {};
    return uniqueUrls([
      links.extraLarge,
      links.large,
      links.medium,
      links.small,
      links.thumbnail,
      links.smallThumbnail,
    ]);
  }

  function metadataScore(targetTitle, targetAuthor, candidateTitle, candidateAuthors, hasCover) {
    const title = normalizeLookupText(targetTitle);
    const candidate = normalizeLookupText(candidateTitle);
    if (!title || !candidate) return 0;

    let score = 0;
    if (title === candidate) score += 100;
    else if (title.includes(candidate) || candidate.includes(title)) score += 70;
    else {
      const short = title.length <= candidate.length ? title : candidate;
      const long = title.length > candidate.length ? title : candidate;
      if (short.length >= 6 && long.includes(short.slice(0, Math.max(6, Math.floor(short.length * 0.75))))) {
        score += 45;
      }
    }

    const author = normalizeLookupText(targetAuthor);
    const authors = normalizeLookupText(candidateAuthors);
    if (author && authors) {
      if (author === authors) score += 35;
      else if (author.includes(authors) || authors.includes(author)) score += 25;
    }

    if (hasCover) score += 10;
    return score;
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

      const coverUrl = String(summary.cover || "").replace(/^http:/, "https:");
      return {
        title: summary.title || "",
        author: summary.author || "",
        coverUrl,
        coverUrls: uniqueUrls([coverUrl]),
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

      const coverUrl = doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : "";
      return {
        title: doc.title || "",
        author: Array.isArray(doc.author_name) ? doc.author_name.join(" / ") : "",
        coverUrl,
        coverUrls: uniqueUrls([coverUrl]),
      };
    } catch (error) {
      console.warn("Open Library search unavailable", error);
      return null;
    }
  }

  async function fetchGoogleBooksByTitleAuthor(title, author) {
    if (!title) return null;

    const terms = [`intitle:${title}`];
    if (author) terms.push(`inauthor:${author}`);
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(terms.join(" "))}&maxResults=5&printType=books`;

    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const data = await response.json();
      const items = Array.isArray(data?.items) ? data.items : [];
      let best = null;

      for (const item of items) {
        const volume = item?.volumeInfo;
        if (!volume) continue;
        const authors = Array.isArray(volume.authors) ? volume.authors.join(" / ") : "";
        const coverUrls = googleImageUrls(volume);
        if (coverUrls.length === 0) continue;

        const score = metadataScore(title, author, volume.title || "", authors, true);
        if (score < 70) continue;
        if (!best || score > best.score) {
          best = {
            score,
            title: volume.title || "",
            author: authors,
            coverUrl: coverUrls[0],
            coverUrls,
          };
        }
      }

      return best;
    } catch (error) {
      console.warn("Google Books title cover search unavailable", error);
      return null;
    }
  }

  async function fetchOpenLibraryByTitleAuthor(title, author) {
    if (!title) return null;

    const params = new URLSearchParams({
      title,
      limit: "5",
      fields: "title,author_name,cover_i",
    });
    if (author) params.set("author", author);

    try {
      const response = await fetch(`https://openlibrary.org/search.json?${params.toString()}`);
      if (!response.ok) return null;
      const data = await response.json();
      const docs = Array.isArray(data?.docs) ? data.docs : [];
      let best = null;

      for (const doc of docs) {
        const authors = Array.isArray(doc.author_name) ? doc.author_name.join(" / ") : "";
        const coverUrl = doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : "";
        if (!coverUrl) continue;

        const score = metadataScore(title, author, doc.title || "", authors, true);
        if (score < 70) continue;
        if (!best || score > best.score) {
          best = {
            score,
            title: doc.title || "",
            author: authors,
            coverUrl,
            coverUrls: [coverUrl],
          };
        }
      }

      return best;
    } catch (error) {
      console.warn("Open Library title cover search unavailable", error);
      return null;
    }
  }

  function mergeMetadata(current, next) {
    if (!next) return current;

    const coverUrls = uniqueUrls([
      ...(current?.coverUrls || []),
      current?.coverUrl,
      ...(next.coverUrls || []),
      next.coverUrl,
    ]);

    return {
      title: current?.title || next.title || "",
      author: current?.author || next.author || "",
      coverUrl: coverUrls[0] || "",
      coverUrls,
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

      // 日本の本はまずopenBDを確認する。
      try {
        best = mergeMetadata(best, await fetchOpenBdBook(normalized));
        if (best?.title && best?.author && best?.coverUrls?.length >= 2) return best;
      } catch (_) {}

      for (const candidate of candidates) {
        try {
          const result = await fetchOpenLibraryBook(candidate);
          if (result) {
            result.coverUrls = uniqueUrls([result.coverUrl]);
            best = mergeMetadata(best, result);
          }
        } catch (_) {}
      }

      for (const candidate of candidates) {
        try {
          best = mergeMetadata(best, await fetchOpenLibrarySearchBook(candidate));
        } catch (_) {}
      }

      for (const candidate of candidates) {
        try {
          const result = await fetchGoogleBooksBook(candidate);
          if (result) {
            result.coverUrls = uniqueUrls([result.coverUrl]);
            best = mergeMetadata(best, result);
          }
        } catch (_) {}
      }

      // ISBN検索でタイトルは分かったのに表紙が無い、または候補が1枚しかない場合だけ、
      // タイトル＋著者でもう一度探す。登録UI自体はこの通信を待たない。
      if (best?.title && (best.coverUrls?.length || 0) < 2) {
        const [googleByName, openLibraryByName] = await Promise.all([
          fetchGoogleBooksByTitleAuthor(best.title, best.author),
          fetchOpenLibraryByTitleAuthor(best.title, best.author),
        ]);
        best = mergeMetadata(best, googleByName);
        best = mergeMetadata(best, openLibraryByName);
      }

      // 最後の保険。画像が404なら表示側が次の候補へ進み、全滅なら本アイコンへ戻す。
      const directCover = `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(normalized)}-M.jpg?default=false`;
      best = mergeMetadata(best, {
        title: "",
        author: "",
        coverUrl: directCover,
        coverUrls: [directCover],
      });

      return best && (best.title || best.author || best.coverUrls?.length) ? best : null;
    };
  }

  const originalLoadBookPreview = typeof loadBookPreview === "function" ? loadBookPreview : null;
  if (originalLoadBookPreview) {
    window.loadBookPreview = async function patchedLoadBookPreview(isbn) {
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

      const coverUrls = uniqueUrls([
        ...(metadata.coverUrls || []),
        metadata.coverUrl,
      ]);

      if (coverUrls.length === 0) {
        bookCover.innerHTML = '<span aria-hidden="true">📚</span>';
        bookLoading.classList.add("hidden");
        return;
      }

      let index = 0;
      const tryNextCover = () => {
        if (pendingCode !== isbn) return;

        if (index >= coverUrls.length) {
          bookCover.innerHTML = '<span aria-hidden="true">📚</span>';
          bookLoading.classList.add("hidden");
          return;
        }

        const url = coverUrls[index++];
        const image = document.createElement("img");
        image.alt = `${metadata.title || "本"}の表紙`;
        image.loading = "eager";
        image.referrerPolicy = "no-referrer";
        image.onload = () => {
          if (pendingCode !== isbn) return;
          bookCover.innerHTML = "";
          bookCover.appendChild(image);
          bookLoading.classList.add("hidden");
        };
        image.onerror = tryNextCover;
        image.src = url;
      };

      bookLoading.textContent = "表紙を探しています…";
      bookLoading.classList.remove("hidden");
      tryNextCover();
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
          const width = Math.max(180, Math.min(360, Math.floor(viewfinderWidth * 0.92)));
          const height = Math.max(120, Math.min(240, Math.floor(viewfinderHeight * 0.82)));
          return { width, height };
        },
      };

      const prioritizedSuccess = (decodedText, decodedResult) => {
        const barcode = String(decodedText || "").replace(/\D/g, "");

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

  setTimeout(installScanPriorityPatch, 0);

  window.koreMotteruIsbnCompat = {
    isValidIsbn10,
    isbn10To13,
    isbn13To10,
    fetchOpenBdBook,
    fetchGoogleBooksByTitleAuthor,
    fetchOpenLibraryByTitleAuthor,
  };
})();
