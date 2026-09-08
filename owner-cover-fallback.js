(() => {
  function normalizeText(value) {
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

  function googleContentCover(volumeId) {
    if (!volumeId) return "";
    return `https://books.google.com/books/content?id=${encodeURIComponent(volumeId)}&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api`;
  }

  function googleImageCandidates(item) {
    const volume = item?.volumeInfo || {};
    const links = volume.imageLinks || {};
    return uniqueUrls([
      googleContentCover(item?.id),
      links.extraLarge,
      links.large,
      links.medium,
      links.small,
      links.thumbnail,
      links.smallThumbnail,
    ]);
  }

  function candidateScore(targetTitle, targetAuthor, volume) {
    const title = normalizeText(targetTitle);
    const candidateTitle = normalizeText(volume?.title || "");
    if (!title || !candidateTitle) return 0;

    let score = 0;
    if (title === candidateTitle) score += 100;
    else if (title.includes(candidateTitle) || candidateTitle.includes(title)) score += 70;
    else {
      const shorter = title.length <= candidateTitle.length ? title : candidateTitle;
      const longer = title.length > candidateTitle.length ? title : candidateTitle;
      const probe = shorter.slice(0, Math.max(6, Math.floor(shorter.length * 0.72)));
      if (probe.length >= 6 && longer.includes(probe)) score += 45;
    }

    const author = normalizeText(targetAuthor);
    const candidateAuthor = normalizeText(
      Array.isArray(volume?.authors) ? volume.authors.join(" / ") : ""
    );
    if (author && candidateAuthor) {
      if (author === candidateAuthor) score += 35;
      else if (author.includes(candidateAuthor) || candidateAuthor.includes(author)) score += 25;
    }
    return score;
  }

  async function fetchGoogleItems(query, maxResults = 5) {
    try {
      const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=${maxResults}&printType=books`;
      const response = await fetch(url);
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data?.items) ? data.items : [];
    } catch (error) {
      console.warn("Google Books cover fallback unavailable", error);
      return [];
    }
  }

  async function findGoogleCoverCandidates(isbn, title, author) {
    const urls = [];

    // まずISBN完全一致。imageLinksが無いレコードでもvolume IDから表紙URLを組み立てる。
    const isbnItems = await fetchGoogleItems(`isbn:${isbn}`, 3);
    for (const item of isbnItems) {
      urls.push(...googleImageCandidates(item));
    }

    if (title) {
      const terms = [`intitle:${title}`];
      if (author) terms.push(`inauthor:${author}`);
      const titleItems = await fetchGoogleItems(terms.join(" "), 5);

      const ranked = titleItems
        .map((item) => ({ item, score: candidateScore(title, author, item?.volumeInfo) }))
        .filter(({ score }) => score >= 70)
        .sort((a, b) => b.score - a.score);

      for (const { item } of ranked) {
        urls.push(...googleImageCandidates(item));
      }
    }

    return uniqueUrls(urls);
  }

  const previousFetchBookMetadata = typeof fetchBookMetadata === "function" ? fetchBookMetadata : null;
  if (previousFetchBookMetadata) {
    window.fetchBookMetadata = async function fetchBookMetadataWithGoogleId(isbn) {
      const metadata = (await previousFetchBookMetadata(isbn)) || {
        title: "",
        author: "",
        coverUrl: "",
        coverUrls: [],
      };

      const googleCandidates = await findGoogleCoverCandidates(
        String(isbn || ""),
        metadata.title || "",
        metadata.author || ""
      );

      const coverUrls = uniqueUrls([
        ...googleCandidates,
        ...(metadata.coverUrls || []),
        metadata.coverUrl,
      ]);

      return {
        ...metadata,
        coverUrl: coverUrls[0] || metadata.coverUrl || "",
        coverUrls,
      };
    };
  }

  // 既存の表示処理を置き換え、候補画像が壊れていたら必ず次へ進む。
  // Google Booksのcontent URLはreferrerを消さず、そのままSafariに読ませる。
  if (typeof loadBookPreview === "function") {
    window.loadBookPreview = async function loadBookPreviewWithFallback(isbn) {
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
      const tryNext = () => {
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
        image.onload = () => {
          if (pendingCode !== isbn) return;
          // 明らかに壊れた極小画像は表紙として採用しない。
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
  }
})();
