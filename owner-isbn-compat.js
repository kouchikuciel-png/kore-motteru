(() => {
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
    if (typeof isValidIsbn13 === "function" && !isValidIsbn13(isbn13)) return null;

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
      const compact = match.replace(/^ISBN(?:-10)?\s*:?/i, "").replace(/[^0-9Xx]/g, "").toUpperCase();
      for (let i = 0; i <= compact.length - 10; i += 1) {
        const candidate = compact.slice(i, i + 10);
        if (isValidIsbn10(candidate)) return candidate;
      }
    }
    return null;
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
      const candidates = [String(isbn13 || "")];
      const legacy = isbn13To10(isbn13);
      if (legacy) candidates.push(legacy);

      let best = null;

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

      // Metadata services occasionally miss older Japanese books even when a cover exists.
      // Let the image element try Open Library's direct cover endpoint; 404 falls back to the book icon.
      return {
        title: "",
        author: "",
        coverUrl: `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn13)}-M.jpg?default=false`,
      };
    };
  }

  window.koreMotteruIsbnCompat = {
    isValidIsbn10,
    isbn10To13,
    isbn13To10,
  };
})();
