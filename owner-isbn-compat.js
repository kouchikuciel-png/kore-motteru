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
          const openLibrary = await fetchOpenLibraryBook(candidate);
          if (openLibrary) {
            best = {
              title: best?.title || openLibrary.title || "",
              author: best?.author || openLibrary.author || "",
              coverUrl: best?.coverUrl || openLibrary.coverUrl || "",
            };
            if (best.title && best.author && best.coverUrl) return best;
          }
        } catch (_) {}
      }

      for (const candidate of candidates) {
        try {
          const google = await fetchGoogleBooksBook(candidate);
          if (google) {
            best = {
              title: best?.title || google.title || "",
              author: best?.author || google.author || "",
              coverUrl: best?.coverUrl || google.coverUrl || "",
            };
            if (best.title && best.author && best.coverUrl) return best;
          }
        } catch (_) {}
      }

      if (best && (best.title || best.author || best.coverUrl)) return best;

      // Metadata services occasionally miss older Japanese books even when a cover exists.
      // Let the image element try Open Library's cover endpoint directly; failures fall back to the book icon.
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
