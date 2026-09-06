// 日本語書籍向けメタデータ補助層
// app.js が Google Books を呼ぶ直前に openBD を優先して照会し、
// 取得できた場合は Google Books 互換のレスポンスへ変換する。
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

  async function fetchOpenBdAsGoogleBooks(isbn) {
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

      const cover = String(summary.cover || "").replace(/^http:/, "https:");
      const authors = summary.author ? [summary.author] : [];

      return new Response(
        JSON.stringify({
          totalItems: 1,
          items: [
            {
              volumeInfo: {
                title: summary.title || "",
                authors,
                publisher: summary.publisher || "",
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
    } catch (error) {
      console.warn("openBD metadata unavailable", isbn, error);
      return null;
    }
  }

  window.fetch = async function patchedFetch(input, init) {
    const isbn = extractIsbnFromGoogleBooksUrl(input);
    if (!isbn) return originalFetch(input, init);

    // 日本語書籍では openBD を先に試す。
    const openBdResponse = await fetchOpenBdAsGoogleBooks(isbn);
    if (openBdResponse) return openBdResponse;

    // openBD に無ければ従来どおり Google Books へ。
    return originalFetch(input, init);
  };
})();
