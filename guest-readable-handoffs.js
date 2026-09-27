(() => {
  const isOwner = /(^|\/)owner\.html$/i.test(window.location.pathname);
  if (isOwner) return;

  const style = document.createElement("style");
  style.textContent = `
    .guest-identity-card { padding:18px !important; }
    .guest-identity-title {
      font-size:18px !important;
      line-height:1.5 !important;
      margin-bottom:8px !important;
    }
    .guest-identity-title .guest-identity-prefix,
    .guest-identity-title .guest-identity-suffix {
      display:block;
      font-size:15px;
      font-weight:700;
      color:#666;
    }
    .guest-identity-title .guest-identity-name {
      display:block;
      margin:4px 0;
      font-size:28px;
      line-height:1.25;
      font-weight:900;
      letter-spacing:.01em;
      color:#111;
    }
    .guest-pending-item { padding:14px !important; }
    .guest-pending-book {
      display:grid;
      grid-template-columns:72px minmax(0,1fr);
      gap:12px;
      align-items:start;
      margin-bottom:12px;
    }
    .guest-pending-cover {
      width:72px;
      aspect-ratio:3/4;
      border-radius:9px;
      overflow:hidden;
      display:grid;
      place-items:center;
      background:#e9e9e9;
      font-size:30px;
    }
    .guest-pending-cover img {
      width:100%;
      height:100%;
      object-fit:cover;
      display:block;
    }
    .guest-pending-book-body { min-width:0; }
    .guest-pending-title {
      font-size:17px;
      line-height:1.4;
      font-weight:850;
      overflow-wrap:anywhere;
    }
    .guest-pending-author {
      margin-top:4px;
      color:#666;
      font-size:13px;
      line-height:1.45;
      overflow-wrap:anywhere;
    }
    .guest-pending-human-meta {
      margin-top:8px;
      font-size:14px;
      line-height:1.45;
      font-weight:750;
    }
    .guest-pending-isbn {
      margin-top:4px;
      color:#888;
      font-size:11px;
      line-height:1.4;
      overflow-wrap:anywhere;
    }
    @media (prefers-color-scheme: dark) {
      .guest-identity-title .guest-identity-prefix,
      .guest-identity-title .guest-identity-suffix,
      .guest-pending-author { color:#aaa; }
      .guest-identity-title .guest-identity-name { color:#fff; }
      .guest-pending-cover { background:#303030; }
      .guest-pending-isbn { color:#888; }
    }
  `;
  document.head.appendChild(style);

  function enhanceIdentityTitle() {
    const title = document.getElementById("guestIdentityTitle");
    if (!title || title.dataset.readableIdentity === "1") return;

    const text = title.textContent.trim();
    const match = text.match(/^この家では[「\"](.+?)[」\"]として登録されています$/);
    if (!match) return;

    title.dataset.readableIdentity = "1";
    title.textContent = "";

    const prefix = document.createElement("span");
    prefix.className = "guest-identity-prefix";
    prefix.textContent = "この家では";

    const name = document.createElement("span");
    name.className = "guest-identity-name";
    name.textContent = `「${match[1]}」`;

    const suffix = document.createElement("span");
    suffix.className = "guest-identity-suffix";
    suffix.textContent = "として登録されています";

    title.append(prefix, name, suffix);
  }

  function parsePendingMeta(text) {
    const barcode = text.match(/97[89]\d{10}/)?.[0] || "";
    const quantity = Number(text.match(/数量\s*×\s*(\d+)/)?.[1] || 1);
    const sender = text.match(/^(.+?)から[・\s]/)?.[1]?.trim() || "";
    return { barcode, quantity: Math.max(1, quantity || 1), sender };
  }

  async function enhancePendingItem(article) {
    if (!article || article.dataset.readableHandoff === "1") return;
    const originalMeta = article.querySelector(".guest-pending-meta");
    if (!originalMeta) return;

    const { barcode, quantity, sender } = parsePendingMeta(originalMeta.textContent || "");
    if (!barcode) return;

    article.dataset.readableHandoff = "1";

    const book = document.createElement("div");
    book.className = "guest-pending-book";

    const cover = document.createElement("div");
    cover.className = "guest-pending-cover";
    cover.innerHTML = '<span aria-hidden="true">📚</span>';

    const body = document.createElement("div");
    body.className = "guest-pending-book-body";

    const title = document.createElement("div");
    title.className = "guest-pending-title";
    title.textContent = "本の情報を読み込み中…";

    const author = document.createElement("div");
    author.className = "guest-pending-author";
    author.hidden = true;

    const humanMeta = document.createElement("div");
    humanMeta.className = "guest-pending-human-meta";
    humanMeta.textContent = `${sender ? `${sender}から ・ ` : ""}×${quantity}冊`;

    const isbn = document.createElement("div");
    isbn.className = "guest-pending-isbn";
    isbn.textContent = `ISBN ${barcode}`;

    body.append(title, author, humanMeta, isbn);
    book.append(cover, body);
    article.insertBefore(book, originalMeta);
    originalMeta.hidden = true;

    if (typeof fetchBookMetadata !== "function") {
      title.textContent = "本";
      return;
    }

    try {
      const metadata = await fetchBookMetadata(barcode);
      title.textContent = metadata?.title || "本";

      if (metadata?.author) {
        author.textContent = metadata.author;
        author.hidden = false;
      }

      if (metadata?.coverUrl) {
        const img = document.createElement("img");
        img.src = metadata.coverUrl;
        img.alt = metadata?.title ? `${metadata.title}の表紙` : "本の表紙";
        img.onload = () => cover.replaceChildren(img);
        img.onerror = () => {};
      }
    } catch (error) {
      console.warn("pending handoff metadata unavailable", error);
      title.textContent = "本";
    }
  }

  function scan() {
    enhanceIdentityTitle();
    document.querySelectorAll(".guest-pending-item").forEach((item) => {
      enhancePendingItem(item);
    });
  }

  const observer = new MutationObserver(() => scan());

  function start() {
    scan();
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();