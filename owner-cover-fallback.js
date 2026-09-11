(() => {
  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s\u3000・:：,，.。!！?？\-―ー_（）()［］\[\]「」『』【】]/g, "");
  }

  function cleanAuthorName(value) {
    let text = String(value || "").normalize("NFKC").trim();
    if (!text) return "";
    text = text.replace(/\s*[（(]?\s*\d{4}\s*[-–—]\s*\d{0,4}\s*[）)]?\s*$/u, "");
    text = text.replace(/\s*,\s*(?=\d{4}\b).*$/u, "");
    text = text.replace(/\s*,\s*/g, " ").replace(/\s+/g, " ").trim();
    return text;
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

  function googleContentCover(volumeId, zoom = 1) {
    if (!volumeId) return "";
    return `https://books.google.com/books/content?id=${encodeURIComponent(volumeId)}&printsec=frontcover&img=1&zoom=${zoom}&source=gbs_api`;
  }

  function googleImageCandidates(item) {
    const volume = item?.volumeInfo || {};
    const links = volume.imageLinks || {};
    return uniqueUrls([
      googleContentCover(item?.id, 2),
      googleContentCover(item?.id, 1),
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

    const author = normalizeText(cleanAuthorName(targetAuthor));
    const candidateAuthor = normalizeText(
      Array.isArray(volume?.authors) ? volume.authors.map(cleanAuthorName).join(" / ") : ""
    );
    if (author && candidateAuthor) {
      if (author === candidateAuthor) score += 35;
      else if (author.includes(candidateAuthor) || candidateAuthor.includes(author)) score += 25;
    }
    return score;
  }

  async function fetchGoogleItems(query, maxResults = 8) {
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

  async function fetchOpenLibraryCoverCandidates(title, author) {
    if (!title) return [];
    try {
      const params = new URLSearchParams({ title, limit: "8" });
      if (author) params.set("author", cleanAuthorName(author));
      const response = await fetch(`https://openlibrary.org/search.json?${params.toString()}`);
      if (!response.ok) return [];
      const data = await response.json();
      const docs = Array.isArray(data?.docs) ? data.docs : [];
      const targetTitle = normalizeText(title);
      const targetAuthor = normalizeText(cleanAuthorName(author));
      const ranked = docs.map((doc) => {
        const docTitle = normalizeText(doc?.title || "");
        const docAuthors = normalizeText((doc?.author_name || []).map(cleanAuthorName).join(" / "));
        let score = docTitle === targetTitle ? 100 : (docTitle.includes(targetTitle) || targetTitle.includes(docTitle) ? 70 : 0);
        if (targetAuthor && docAuthors && (docAuthors.includes(targetAuthor) || targetAuthor.includes(docAuthors))) score += 25;
        return { doc, score };
      }).filter(({ doc, score }) => score >= 70 && doc?.cover_i).sort((a, b) => b.score - a.score);
      return uniqueUrls(ranked.flatMap(({ doc }) => [
        `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`,
        `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`,
      ]));
    } catch (error) {
      console.warn("Open Library title cover fallback unavailable", error);
      return [];
    }
  }

  async function findGoogleCoverCandidates(isbn, title, author) {
    const urls = [];
    const cleanedAuthor = cleanAuthorName(author);

    const isbnItems = await fetchGoogleItems(`isbn:${isbn}`, 5);
    for (const item of isbnItems) urls.push(...googleImageCandidates(item));

    if (title) {
      const queries = [
        cleanedAuthor ? `intitle:${title} inauthor:${cleanedAuthor}` : `intitle:${title}`,
        `intitle:${title}`,
        cleanedAuthor ? `${title} ${cleanedAuthor}` : title,
      ];
      for (const query of queries) {
        const titleItems = await fetchGoogleItems(query, 8);
        const ranked = titleItems
          .map((item) => ({ item, score: candidateScore(title, cleanedAuthor, item?.volumeInfo) }))
          .filter(({ score }) => score >= 70)
          .sort((a, b) => b.score - a.score);
        for (const { item } of ranked) urls.push(...googleImageCandidates(item));
      }
    }
    return uniqueUrls(urls);
  }

  const previousFetchBookMetadata = typeof fetchBookMetadata === "function" ? fetchBookMetadata : null;
  if (previousFetchBookMetadata) {
    window.fetchBookMetadata = async function fetchBookMetadataWithDedicatedCoverSearch(isbn) {
      const metadata = (await previousFetchBookMetadata(isbn)) || { title: "", author: "", coverUrl: "", coverUrls: [] };
      const author = cleanAuthorName(metadata.author || "");

      // 書誌情報が取れた時点で、表紙だけを別経路で探す。登録操作はこの結果を待つ必要はない。
      const [googleCandidates, openLibraryCandidates] = await Promise.all([
        findGoogleCoverCandidates(String(isbn || ""), metadata.title || "", author),
        fetchOpenLibraryCoverCandidates(metadata.title || "", author),
      ]);

      const coverUrls = uniqueUrls([
        ...googleCandidates,
        ...openLibraryCandidates,
        ...(metadata.coverUrls || []),
        metadata.coverUrl,
      ]);

      return { ...metadata, author, coverUrl: coverUrls[0] || metadata.coverUrl || "", coverUrls };
    };
  }

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
      const author = cleanAuthorName(metadata.author || "");
      if (author) { bookAuthor.textContent = author; bookAuthor.classList.remove("hidden"); }
      else bookAuthor.classList.add("hidden");

      const coverUrls = uniqueUrls([...(metadata.coverUrls || []), metadata.coverUrl]);
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
        const image = document.createElement("img");
        image.alt = `${metadata.title || "本"}の表紙`;
        image.loading = "eager";
        image.onload = () => {
          if (pendingCode !== isbn) return;
          if (image.naturalWidth < 40 || image.naturalHeight < 50) return tryNext();
          bookCover.innerHTML = "";
          bookCover.appendChild(image);
          bookLoading.classList.add("hidden");
        };
        image.onerror = tryNext;
        image.src = coverUrls[index++];
      };
      bookLoading.textContent = "表紙を探しています…";
      bookLoading.classList.remove("hidden");
      tryNext();
    };
  }
})();
