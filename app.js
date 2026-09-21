const SUPABASE_URL = "https://dnxllbdagnnjsnadlqly.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_YCQsOS8F6kME99vOsabvUg_R6pr5E54";

const ownedView = document.getElementById("ownedView");
const scanView = document.getElementById("scanView");
const scanNavBtn = document.getElementById("scanNavBtn");
const backBtn = document.getElementById("backBtn");
const ownedList = document.getElementById("ownedList");
const ownedLoading = document.getElementById("ownedLoading");
const ownedEmpty = document.getElementById("ownedEmpty");
const ownedError = document.getElementById("ownedError");
const ownedCount = document.getElementById("ownedCount");

const detailOverlay = document.getElementById("detailOverlay");
const detailCover = document.getElementById("detailCover");
const detailTitle = document.getElementById("detailTitle");
const detailAuthor = document.getElementById("detailAuthor");
const detailMeta = document.getElementById("detailMeta");
const detailCheckBtn = document.getElementById("detailCheckBtn");
const detailCloseBtn = document.getElementById("detailCloseBtn");

const startBtn = document.getElementById("startBtn");
const manualEntryForm = document.getElementById("manualEntryForm");
const manualEntryInput = document.getElementById("manualEntryInput");
const againBtn = document.getElementById("againBtn");
const reader = document.getElementById("reader");
const statusBox = document.getElementById("status");
const purchasePanel = document.getElementById("purchasePanel");
const purchaseBtn = document.getElementById("purchaseBtn");
const minusBtn = document.getElementById("minusBtn");
const plusBtn = document.getElementById("plusBtn");
const qtyValue = document.getElementById("qtyValue");
const ownedQty = document.getElementById("ownedQty");
const plannedQty = document.getElementById("plannedQty");

let scanner = null;
let scannerStarted = false;
let busy = false;
let currentBarcode = null;
let currentState = null;
let currentDetailItem = null;
let quantity = 1;

function getShareToken() {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return null;

  const params = new URLSearchParams(raw);
  if (params.has("token")) return params.get("token");

  return raw;
}

function getOrCreateBuyerKey() {
  const storageKey = "kore-motteru-buyer-key";
  let key = localStorage.getItem(storageKey);
  if (key) return key;

  key = self.crypto?.randomUUID?.() ||
    `buyer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(storageKey, key);
  return key;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(title, text, kind = "") {
  statusBox.className = `status ${kind}`.trim();
  statusBox.innerHTML = `
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(text)}</span>
  `;
}

function setBarcodeStatus(title, text, barcode, kind = "") {
  statusBox.className = `status ${kind}`.trim();
  statusBox.innerHTML = `
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(text)}</span>
    <div class="barcode">${escapeHtml(barcode)}</div>
  `;
}

async function callRpc(name, body) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase ${response.status}: ${detail}`);
  }

  return await response.json();
}

function getProductState(token, barcode) {
  return callRpc("get_household_product_state", {
    p_token: token,
    p_barcode: barcode,
  });
}

function getGuestLabel() {
  return window.KoreMotteruGuestIdentity?.getLabel?.() || "";
}

function addPurchasePlan(token, barcode, qty) {
  return callRpc("add_purchase_plan", {
    p_token: token,
    p_barcode: barcode,
    p_buyer_key: getOrCreateBuyerKey(),
    p_buyer_label: getGuestLabel() || null,
    p_quantity: qty,
    p_visibility: "GIFT_SECRET",
  });
}

function getOwnedItems(token) {
  return callRpc("get_household_owned_items", {
    p_token: token,
  });
}

function isIsbn13(barcode) {
  return /^97[89]\d{10}$/.test(String(barcode));
}

async function fetchOpenLibraryMetadata(isbns) {
  if (isbns.length === 0) return {};

  const keys = isbns.map((isbn) => `ISBN:${isbn}`).join(",");
  const url = `https://openlibrary.org/api/books?bibkeys=${encodeURIComponent(keys)}&jscmd=data&format=json`;

  try {
    const response = await fetch(url);
    if (!response.ok) return {};
    return (await response.json()) || {};
  } catch (error) {
    console.warn("Open Library metadata unavailable", error);
    return {};
  }
}

async function fetchGoogleBooksMetadata(isbn) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`isbn:${isbn}`)}&maxResults=1&printType=books`;

  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    const volume = data?.items?.[0]?.volumeInfo;
    if (!volume) return null;

    const imageUrl = volume.imageLinks?.thumbnail || volume.imageLinks?.smallThumbnail || "";
    return {
      title: volume.title || "",
      author: Array.isArray(volume.authors) ? volume.authors.join(" / ") : "",
      coverUrl: imageUrl.replace(/^http:/, "https:"),
    };
  } catch (error) {
    console.warn("Google Books metadata unavailable", isbn, error);
    return null;
  }
}


function uniqueCoverUrls(values) {
  const seen = new Set();
  const urls = [];
  for (const value of values || []) {
    const url = String(value || "").trim().replace(/^http:/, "https:");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function coverProxyUrl(source) {
  return `${SUPABASE_URL}/functions/v1/book-cover-proxy?src=${encodeURIComponent(source)}`;
}

function expandGuestCoverCandidates(values) {
  const result = [];
  for (const source of uniqueCoverUrls(values)) {
    let googleHost = false;
    try {
      const host = new URL(source).hostname.toLowerCase();
      googleHost = host === "books.google.com" ||
        host === "books.google.co.jp" ||
        host.endsWith(".googleusercontent.com");
    } catch (_) {}
    if (googleHost) result.push(coverProxyUrl(source), source);
    else result.push(source, coverProxyUrl(source));
  }
  return uniqueCoverUrls(result);
}

function guestHanmotoCoverCandidates(isbn) {
  const normalized = String(isbn || "").replace(/\D/g, "");
  if (!/^9784\d{9}$/.test(normalized)) return [];
  return [`https://img.hanmoto.com/bd/img/${normalized}_600.jpg`];
}

async function fetchGuestCoverFallback(isbn, title, author) {
  const urls = [];
  const queries = [
    `isbn:${isbn}`,
    title && author ? `intitle:${title} inauthor:${author}` : "",
    title ? `intitle:${title}` : "",
  ].filter(Boolean);

  for (const query of queries) {
    try {
      const response = await fetch(
        `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5&printType=books`
      );
      if (!response.ok) continue;
      const data = await response.json();
      for (const item of data?.items || []) {
        const links = item?.volumeInfo?.imageLinks || {};
        if (item?.id) {
          urls.push(`https://books.google.com/books/content?id=${encodeURIComponent(item.id)}&printsec=frontcover&img=1&zoom=2&source=gbs_api`);
        }
        urls.push(links.large, links.medium, links.small, links.thumbnail, links.smallThumbnail);
      }
    } catch (error) {
      console.warn("Google Books cover fallback unavailable", isbn, error);
    }
  }

  if (title) {
    try {
      const params = new URLSearchParams({ title, limit: "5" });
      if (author) params.set("author", author);
      const response = await fetch(`https://openlibrary.org/search.json?${params.toString()}`);
      if (response.ok) {
        const data = await response.json();
        for (const doc of data?.docs || []) {
          if (!doc?.cover_i) continue;
          urls.push(
            `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`,
            `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
          );
        }
      }
    } catch (error) {
      console.warn("Open Library cover fallback unavailable", isbn, error);
    }
  }

  return uniqueCoverUrls(urls);
}

function authorNeedsCleanup(author) {
  const value = String(author || "");
  return /,/.test(value) || /\b\d{4}(?:-\d{0,4})?\b/.test(value);
}

async function fetchBookMetadata(items) {
  const isbns = [...new Set(
    items.map((item) => String(item.barcode)).filter(isIsbn13)
  )];
  if (isbns.length === 0) return {};

  const openLibrary = await fetchOpenLibraryMetadata(isbns);
  const result = {};
  const enrichTargets = [];

  for (const isbn of isbns) {
    const book = openLibrary[`ISBN:${isbn}`];

    if (book) {
      const author = Array.isArray(book.authors)
        ? book.authors.map((authorItem) => authorItem.name).filter(Boolean).join(" / ")
        : "";
      const coverUrl = book.cover?.medium || book.cover?.small || "";

      result[isbn] = {
        title: book.title || "",
        author,
        coverUrl,
      };

      // 「見つかった」だけで終了しない。
      // 表紙が無い、または著者表記が図書館向けなら補助データを取りに行く。
      if (!coverUrl || !author || authorNeedsCleanup(author)) {
        enrichTargets.push(isbn);
      }
    } else {
      enrichTargets.push(isbn);
    }
  }

  // openBD / Google Books補助層を通す。
  // 初号機なので一度に最大12冊まで。
  const fallbackTargets = [...new Set(enrichTargets)].slice(0, 12);
  const fallbackResults = await Promise.all(
    fallbackTargets.map(async (isbn) => [isbn, await fetchGoogleBooksMetadata(isbn)])
  );

  for (const [isbn, metadata] of fallbackResults) {
    if (!metadata) continue;

    const current = result[isbn] || {
      title: "",
      author: "",
      coverUrl: "",
    };

    result[isbn] = {
      title: current.title || metadata.title || "",
      // 補助層のopenBD側で人間向け表記へ整えているので優先する。
      author: metadata.author || current.author || "",
      coverUrl: current.coverUrl || metadata.coverUrl || "",
    };
  }

  const coverTargets = Object.entries(result)
    .filter(([, metadata]) => Boolean(metadata))
    .slice(0, 12);

  const coverFallbacks = await Promise.all(
    coverTargets.map(async ([isbn, metadata]) => [
      isbn,
      await fetchGuestCoverFallback(isbn, metadata.title || "", metadata.author || ""),
    ])
  );

  for (const [isbn, fallbackUrls] of coverFallbacks) {
    if (!result[isbn]) continue;
    const coverUrls = uniqueCoverUrls([
      ...fallbackUrls,
      ...(result[isbn].coverUrls || []),
      result[isbn].coverUrl || "",
    ]);
    result[isbn].coverUrls = coverUrls;
    result[isbn].coverUrl = coverUrls[0] || result[isbn].coverUrl || "";
  }

  return result;
}

function closeOwnedDetail() {
  currentDetailItem = null;
  detailOverlay.classList.add("hidden");
}

function provenanceSummary(origins) {
  const rows = Array.isArray(origins) ? origins : [];
  const labels = [];
  for (const row of rows) {
    const label = String(row?.giver_label || row?.purchaser_label || "").trim();
    if (label && label !== "ゲスト" && !labels.includes(label)) labels.push(label);
  }
  if (labels.length === 0) return "";
  if (labels.length <= 3) return `${labels.join("・")}から`;
  return `${labels.slice(0, 3).join("・")}ほかから`;
}

function openOwnedDetail(item) {
  currentDetailItem = item;
  detailTitle.textContent = item.title;
  detailAuthor.textContent = item.author || "";
  detailAuthor.classList.toggle("hidden", !item.author);
  const provenance = provenanceSummary(item.origins);
  detailMeta.textContent = [
    `${isIsbn13(item.barcode) ? "ISBN" : "コード"} ${item.barcode}`,
    `所有 ×${item.quantity}`,
    provenance,
  ].filter(Boolean).join(" ・ ");
  const detailCoverUrls = Array.isArray(item.coverUrls) && item.coverUrls.length
    ? item.coverUrls
    : (item.coverUrl ? [item.coverUrl] : []);
  detailCover.innerHTML = detailCoverUrls.length
    ? `<img src="${escapeHtml(detailCoverUrls[0])}" alt="${escapeHtml(item.title)}の表紙" />`
    : `<span aria-hidden="true">${isIsbn13(item.barcode) ? "📚" : "📦"}</span>`;
  const detailImage = detailCover.querySelector("img");
  if (detailImage && detailCoverUrls.length > 1) {
    let coverIndex = 1;
    detailImage.addEventListener("error", () => {
      if (coverIndex >= detailCoverUrls.length) {
        detailCover.innerHTML = '<span aria-hidden="true">📚</span>';
        return;
      }
      detailImage.src = detailCoverUrls[coverIndex++];
    });
  }
  detailOverlay.classList.remove("hidden");
}

function renderOwnedItems(items, bookMetadata = {}) {
  ownedLoading.classList.add("hidden");
  ownedError.classList.add("hidden");
  ownedEmpty.classList.toggle("hidden", items.length !== 0);
  ownedList.classList.toggle("hidden", items.length === 0);
  ownedList.innerHTML = "";

  const totalQuantity = items.reduce(
    (sum, item) => sum + Number(item.quantity || 0),
    0
  );
  ownedCount.textContent = items.length
    ? `${items.length}種類・合計${totalQuantity}個`
    : "";

  for (const item of items) {
    const barcode = String(item.barcode);
    const book = bookMetadata[barcode] || null;
    const title = book?.title || (isIsbn13(barcode) ? "絵本・書籍" : "商品");
    const author = book?.author || "";
    const coverUrls = expandGuestCoverCandidates([
      ...(book?.coverUrls || []),
      book?.coverUrl || "",
    ]);
    const coverUrl = coverUrls[0] || "";
    const detailItem = {
      barcode,
      title,
      author,
      coverUrl,
      coverUrls,
      quantity: Number(item.quantity || 1),
      origins: Array.isArray(item.origins) ? item.origins : [],
    };

    const article = document.createElement("article");
    article.className = "owned-item";
    article.tabIndex = 0;
    article.setAttribute("role", "button");
    article.setAttribute("aria-label", `${title}の詳細を開く`);
    article.innerHTML = `
      <div class="owned-cover">
        ${coverUrl
          ? `<img src="${escapeHtml(coverUrl)}" alt="${escapeHtml(title)}の表紙" loading="lazy" />`
          : `<span aria-hidden="true">${isIsbn13(barcode) ? "📚" : "📦"}</span>`}
      </div>
      <div class="owned-body">
        <div class="owned-title">${escapeHtml(title)}</div>
        ${author ? `<div class="owned-author">${escapeHtml(author)}</div>` : ""}
        <div class="owned-meta">${escapeHtml(barcode)} ・ ×${escapeHtml(item.quantity ?? 1)}</div>
        ${provenanceSummary(detailItem.origins)
          ? `<div class="owned-meta">${escapeHtml(provenanceSummary(detailItem.origins))}</div>`
          : ""}
      </div>
    `;

    article.addEventListener("click", () => openOwnedDetail(detailItem));
    article.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openOwnedDetail(detailItem);
      }
    });

    const coverImage = article.querySelector(".owned-cover img");
    if (coverImage && coverUrls.length > 1) {
      let coverIndex = 1;
      coverImage.addEventListener("error", () => {
        if (coverIndex >= coverUrls.length) {
          coverImage.parentElement.innerHTML = '<span aria-hidden="true">📚</span>';
          return;
        }
        coverImage.src = coverUrls[coverIndex++];
      });
    }

    ownedList.appendChild(article);
  }
}

async function loadOwnedItems() {
  const token = getShareToken();

  ownedList.classList.add("hidden");
  ownedEmpty.classList.add("hidden");
  ownedError.classList.add("hidden");
  ownedLoading.classList.remove("hidden");
  ownedCount.textContent = "";

  if (!token) {
    ownedLoading.classList.add("hidden");
    ownedError.classList.remove("hidden");
    return;
  }

  try {
    const result = await getOwnedItems(token);
    if (!result || result.valid_token !== true) {
      ownedLoading.classList.add("hidden");
      ownedError.classList.remove("hidden");
      return;
    }

    const items = Array.isArray(result.items) ? result.items : [];
    const metadata = await fetchBookMetadata(items);
    renderOwnedItems(items, metadata);
  } catch (error) {
    console.error(error);
    ownedLoading.classList.add("hidden");
    ownedError.classList.remove("hidden");
  }
}

async function stopScannerQuietly() {
  if (!scanner || !scannerStarted) return;
  try {
    await scanner.stop();
  } catch (_) {
    // 停止競合は無視
  }
  scannerStarted = false;
}

function hidePurchasePanel() {
  purchasePanel.classList.add("hidden");
}

function showOwnedView() {
  stopScannerQuietly();
  closeOwnedDetail();
  reader.classList.add("hidden");
  scanView.classList.add("hidden");
  ownedView.classList.remove("hidden");
  loadOwnedItems();
}

function showScanView() {
  closeOwnedDetail();
  ownedView.classList.add("hidden");
  scanView.classList.remove("hidden");
  busy = false;
  currentBarcode = null;
  currentState = null;
  quantity = 1;
  qtyValue.textContent = "1";
  hidePurchasePanel();
  againBtn.classList.add("hidden");
  startBtn.classList.remove("hidden");
  reader.classList.add("hidden");
  setStatus("準備OK", "ボタンを押してカメラを起動してください。");
}

function renderProductState(barcode, state) {
  currentBarcode = barcode;
  currentState = state;
  quantity = 1;
  qtyValue.textContent = String(quantity);
  ownedQty.textContent = String(state.owned_quantity ?? 0);
  plannedQty.textContent = String(state.planned_quantity ?? 0);

  const duplicate = Boolean(state.duplicate);

  if (duplicate) {
    setBarcodeStatus(
      "重複しています",
      "すでに所有、または購入予定があります。それでも購入できます。",
      barcode,
      "warn"
    );
    purchaseBtn.textContent = "それでも購入予定に入れる";
  } else {
    setBarcodeStatus(
      "重複はありません",
      "現在、この商品は所有・購入予定ともにありません。",
      barcode,
      "ok"
    );
    purchaseBtn.textContent = "購入予定に入れる";
  }

  purchasePanel.classList.remove("hidden");
  againBtn.textContent = duplicate ? "やめる・別の商品を確認する" : "別の商品を確認する";
  againBtn.classList.remove("hidden");
}

async function checkBarcodeDirectly(barcode) {
  const token = getShareToken();
  showScanView();
  startBtn.classList.add("hidden");
  setBarcodeStatus("確認中…", "家に登録されている本の情報を確認しています。", barcode);

  try {
    const state = await getProductState(token, barcode);
    if (!state || state.valid_token !== true) {
      setBarcodeStatus(
        "共有リンクが無効です",
        "新しい共有リンクを開いて、もう一度お試しください。",
        barcode,
        "error"
      );
      return;
    }
    renderProductState(barcode, state);
  } catch (error) {
    console.error(error);
    setBarcodeStatus(
      "確認できませんでした",
      "通信状態を確認して、もう一度お試しください。",
      barcode,
      "error"
    );
    againBtn.classList.remove("hidden");
  }
}

async function handleDecodedBarcode(decodedText) {
  if (busy) return;
  busy = true;

  const token = getShareToken();
  const barcode = String(decodedText).trim();

  await stopScannerQuietly();
  reader.classList.add("hidden");
  hidePurchasePanel();
  setBarcodeStatus("確認中…", "家に登録されている本の情報を確認しています。", barcode);

  try {
    const state = await getProductState(token, barcode);

    if (!state || state.valid_token !== true) {
      setBarcodeStatus(
        "共有リンクが無効です",
        "新しい共有リンクを開いて、もう一度お試しください。",
        barcode,
        "error"
      );
      againBtn.classList.add("hidden");
      return;
    }

    renderProductState(barcode, state);
  } catch (error) {
    console.error(error);
    setBarcodeStatus(
      "確認できませんでした",
      "通信状態を確認して、もう一度お試しください。",
      barcode,
      "error"
    );
    againBtn.classList.remove("hidden");
  }
}

async function startScanner() {
  const token = getShareToken();
  if (!token) {
    setStatus(
      "共有リンクが必要です",
      "家庭から届いた専用リンクを開いてください。",
      "error"
    );
    return;
  }

  if (typeof Html5Qrcode === "undefined") {
    setStatus(
      "読み取り機能を起動できません",
      "通信状態を確認して、ページを再読み込みしてください。",
      "error"
    );
    return;
  }

  busy = false;
  currentBarcode = null;
  currentState = null;
  hidePurchasePanel();
  againBtn.classList.add("hidden");
  startBtn.classList.add("hidden");
  reader.classList.remove("hidden");
  setStatus("読み取り中", "商品のバーコードをカメラに向けてください。");

  if (!scanner) {
    scanner = new Html5Qrcode("reader", {
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
      ],
      verbose: false,
    });
  }

  try {
    await scanner.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: { width: 300, height: 130 },
        aspectRatio: 1.777778,
      },
      handleDecodedBarcode,
      () => {
        // 読み取り途中の失敗フレームは正常
      }
    );
    scannerStarted = true;
  } catch (error) {
    console.error(error);
    reader.classList.add("hidden");
    startBtn.classList.remove("hidden");
    setStatus(
      "カメラを起動できませんでした",
      "Safariのカメラ許可を確認して、もう一度お試しください。",
      "error"
    );
  }
}

minusBtn.addEventListener("click", () => {
  quantity = Math.max(1, quantity - 1);
  qtyValue.textContent = String(quantity);
});

plusBtn.addEventListener("click", () => {
  quantity += 1;
  qtyValue.textContent = String(quantity);
});

purchaseBtn.addEventListener("click", async () => {
  const token = getShareToken();
  if (!token || !currentBarcode) return;

  const label = getGuestLabel();
  if (!label) {
    window.KoreMotteruGuestIdentity?.requestLabel?.();
    setBarcodeStatus(
      "呼ばれ方を登録してください",
      "購入した人として残すため、「じいじ」などこの家で呼ばれている名前を先に登録してください。",
      currentBarcode,
      "warn"
    );
    return;
  }

  purchaseBtn.disabled = true;
  purchaseBtn.textContent = "追加中…";

  try {
    const result = await addPurchasePlan(token, currentBarcode, quantity);

    if (!result || result.valid_token !== true) {
      hidePurchasePanel();
      setBarcodeStatus(
        "共有リンクが無効です",
        "新しい共有リンクを開いて、もう一度お試しください。",
        currentBarcode,
        "error"
      );
      return;
    }

    plannedQty.textContent = String(result.planned_quantity_after ?? 0);
    setBarcodeStatus(
      "購入予定に追加しました",
      `${label}の購入予定として、数量 ${quantity} を登録しました。`,
      currentBarcode,
      "ok"
    );
    hidePurchasePanel();
    againBtn.textContent = "別の商品を確認する";
    againBtn.classList.remove("hidden");
  } catch (error) {
    console.error(error);
    setBarcodeStatus(
      "追加できませんでした",
      "通信状態を確認して、もう一度お試しください。",
      currentBarcode,
      "error"
    );
  } finally {
    purchaseBtn.disabled = false;
  }
});

manualEntryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const barcode = String(manualEntryInput.value || "").replace(/\D/g, "");

  if (!/^\d{8,14}$/.test(barcode)) {
    setStatus(
      "番号を確認してください",
      "バーコードの下にある8〜14桁の数字を入力してください。",
      "error"
    );
    manualEntryInput.focus();
    return;
  }

  await stopScannerQuietly();
  await checkBarcodeDirectly(barcode);
});

scanNavBtn.addEventListener("click", showScanView);
backBtn.addEventListener("click", showOwnedView);
startBtn.addEventListener("click", startScanner);
againBtn.addEventListener("click", startScanner);
detailCloseBtn.addEventListener("click", closeOwnedDetail);
detailCheckBtn.addEventListener("click", () => {
  if (currentDetailItem) checkBarcodeDirectly(currentDetailItem.barcode);
});
detailOverlay.addEventListener("click", (event) => {
  if (event.target === detailOverlay) closeOwnedDetail();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !detailOverlay.classList.contains("hidden")) {
    closeOwnedDetail();
  }
});

window.addEventListener("pagehide", () => {
  stopScannerQuietly();
});

showOwnedView();
