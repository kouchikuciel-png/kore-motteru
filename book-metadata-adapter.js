// 日本語書籍向けメタデータ補助層
// app.js が Google Books を呼ぶ直前に openBD を優先して照会し、
// openBD の書誌情報と Google Books の表紙を必要に応じて合成する。
(() => {
  const originalFetch = window.fetch.bind(window);

  function extractIsbnFromGoogleBooksUrl(input) {
    try {
      const rawUrl = typeof input === "string" ? input : input?.url;
      if (!rawUrl) return null;
      const url = new URL(rawUrl, window.location.href);
      if (url.hostname !== "www.googleapis.com") return null;
      if (!url.pathname.includes("/books/v1/volumes")) return null;

      const q = url.searchParams.get("q") || "";
      const match = q.match(/^isbn:(97[89]\d{10})$/i);
      return match ? match[1] : null;
    } catch (_) {
      return null;
    }
  }

  function normalizeJapaneseAuthor(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";

    const parts = value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !/^\d{4}(?:-\d{0,4})?$/.test(part));

    if (parts.length >= 2) {
      return `${parts[0]} ${parts[1]}`.trim();
    }

    return value
      .replace(/,?\s*\d{4}(?:-\d{0,4})?\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function fetchOpenBd(isbn) {
    try {
      const response = await originalFetch(
        `https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(isbn)}`,
        { method: "GET" }
      );
      if (!response.ok) return null;

      const data = await response.json();
      const record = Array.isArray(data) ? data[0] : null;
      const summary = record?.summary;
      if (!summary?.title) return null;

      return {
        title: summary.title || "",
        author: normalizeJapaneseAuthor(summary.author),
        publisher: summary.publisher || "",
        coverUrl: String(summary.cover || "").replace(/^http:/, "https:"),
      };
    } catch (error) {
      console.warn("openBD metadata unavailable", isbn, error);
      return null;
    }
  }

  async function fetchGoogleBooksVolume(input, init) {
    try {
      const response = await originalFetch(input, init);
      if (!response.ok) return null;
      const data = await response.clone().json();
      const volume = data?.items?.[0]?.volumeInfo;
      if (!volume) return null;

      const coverUrl = String(
        volume.imageLinks?.thumbnail ||
        volume.imageLinks?.smallThumbnail ||
        ""
      ).replace(/^http:/, "https:");

      return {
        title: volume.title || "",
        author: Array.isArray(volume.authors) ? volume.authors.join(" / ") : "",
        publisher: volume.publisher || "",
        coverUrl,
      };
    } catch (error) {
      console.warn("Google Books metadata unavailable", error);
      return null;
    }
  }

  function toGoogleBooksResponse(metadata) {
    const cover = metadata.coverUrl || "";
    return new Response(
      JSON.stringify({
        totalItems: 1,
        items: [
          {
            volumeInfo: {
              title: metadata.title || "",
              authors: metadata.author ? [metadata.author] : [],
              publisher: metadata.publisher || "",
              imageLinks: cover
                ? { thumbnail: cover, smallThumbnail: cover }
                : undefined,
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  window.fetch = async function patchedFetch(input, init) {
    const isbn = extractIsbnFromGoogleBooksUrl(input);
    if (!isbn) return originalFetch(input, init);

    const openBd = await fetchOpenBd(isbn);
    if (!openBd) {
      return originalFetch(input, init);
    }

    // openBDに表紙がなければ、Google Booksから画像だけ補完する。
    if (!openBd.coverUrl) {
      const google = await fetchGoogleBooksVolume(input, init);
      if (google?.coverUrl) openBd.coverUrl = google.coverUrl;
      if (!openBd.author && google?.author) openBd.author = google.author;
    }

    return toGoogleBooksResponse(openBd);
  };
})();