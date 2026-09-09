const SUPABASE_URL = "https://dnxllbdagnnjsnadlqly.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_YCQsOS8F6kME99vOsabvUg_R6pr5E54";

const startBtn = document.getElementById("startBtn");
const ocrBtn = document.getElementById("ocrBtn");
const ocrHelp = document.getElementById("ocrHelp");
const againBtn = document.getElementById("againBtn");
const reader = document.getElementById("reader");
const statusBox = document.getElementById("status");
const captureCanvas = document.getElementById("captureCanvas");
const quantityPanel = document.getElementById("quantityPanel");
const quantityLabel = document.getElementById("quantityLabel");
const minusBtn = document.getElementById("minusBtn");
const plusBtn = document.getElementById("plusBtn");
const qtyValue = document.getElementById("qtyValue");
const confirmBtn = document.getElementById("confirmBtn");
const bookPreview = document.getElementById("bookPreview");
const bookCover = document.getElementById("bookCover");
const bookTitle = document.getElementById("bookTitle");
const bookAuthor = document.getElementById("bookAuthor");
const bookLoading = document.getElementById("bookLoading");
const tutorialHelpBtn = document.getElementById("tutorialHelpBtn");
const tutorialOverlay = document.getElementById("tutorialOverlay");
const tutorialCloseBtn = document.getElementById("tutorialCloseBtn");
const tutorialDontShow = document.getElementById("tutorialDontShow");
const tutorialStartBtn = document.getElementById("tutorialStartBtn");

const TUTORIAL_STORAGE_KEY = "kore-motteru-owner-tutorial-dismissed-v1";
const MAX_AUTO_OCR_ATTEMPTS = 2;
const INVALID_BARCODE_OCR_DELAY_MS = 1100;

let scanner = null;
let scannerStarted = false;
let busy = false;
let autoOcrTimer = null;
let autoOcrAttempts = 0;
let invalidBarcodeSeenAt = 0;
let ocrWorkerPromise = null;
let pendingCode = null;
let pendingSourceLabel = "";
let pendingOwnedQuantity = 0;
let quantity = 1;
let tutorialResumeAfterClose = false;

function getShareToken() {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  return params.has("token") ? params.get("token") : raw;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(title, text, kind = "", code = "") {
  statusBox.className = `status ${kind}`.trim();
  statusBox.innerHTML = `
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(text)}</span>
    ${code ? `<div class="barcode">${escapeHtml(code)}</div>` : ""}
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

function getOwnerItemState(token, barcode) {
  return callRpc("get_owner_item_state", {
    p_token: token,
    p_barcode: barcode,
  });
}

function registerItem(token, barcode, qty) {
  return callRpc("register_household_item_quantity", {
    p_token: token,
    p_barcode: barcode,
    p_quantity: qty,
  });
}

function isValidIsbn13(isbn) {
  if (!/^97[89]\d{10}$/.test(isbn)) return false;
  const digits = isbn.split("").map(Number);
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += digits[i] * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return check === digits[12];
}

async function fetchOpenLibraryBook(isbn) {
  const key = `ISBN:${isbn}`;
  const url = `https://openlibrary.org/api/books?bibkeys=${encodeURIComponent(key)}&jscmd=data&format=json`;

  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    const book = data?.[key];
    if (!book) return null;

    return {
      title: book.title || "",
      author: Array.isArray(book.authors)
        ? book.authors.map((item) => item.name).filter(Boolean).join(" / ")
        : "",
      coverUrl: book.cover?.medium || book.cover?.small || "",
    };
  } catch (error) {
    console.warn("Open Library metadata unavailable", error);
    return null;
  }
}

async function fetchGoogleBooksBook(isbn) {
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
    console.warn("Google Books metadata unavailable", error);
    return null;
  }
}

async function fetchBookMetadata(isbn) {
  const primary = await fetchOpenLibraryBook(isbn);
  if (primary?.title && primary?.coverUrl && primary?.author) return primary;

  const fallback = await fetchGoogleBooksBook(isbn);
  if (!primary && !fallback) return null;

  return {
    title: primary?.title || fallback?.title || "",
    author: primary?.author || fallback?.author || "",
    coverUrl: primary?.coverUrl || fallback?.coverUrl || "",
  };
}

function resetBookPreview() {
  bookPreview.classList.add("hidden");
  bookCover.innerHTML = '<span aria-hidden="true">📚</span>';
  bookTitle.textContent = "本の情報を確認しています…";
  bookAuthor.textContent = "";
  bookAuthor.classList.add("hidden");
  bookLoading.textContent = "表紙や本の名前が見つかれば表示します。";
  bookLoading.classList.remove("hidden");
}

function showBookPreviewLoading() {
  bookPreview.classList.remove("hidden");
  bookCover.innerHTML = '<span aria-hidden="true">📚</span>';
  bookTitle.textContent = "本の情報を確認しています…";
  bookAuthor.classList.add("hidden");
  bookLoading.classList.remove("hidden");
}

async function loadBookPreview(isbn) {
  showBookPreviewLoading();
  const metadata = await fetchBookMetadata(isbn);
  if (pendingCode !== isbn) return;

  if (!metadata || (!metadata.title && !metadata.coverUrl)) {
    bookPreview.classList.add("hidden");
    return;
  }

  bookTitle.textContent = metadata.title || "本を読み取りました";

  if (metadata.author) {
    bookAuthor.textContent = metadata.author;
    bookAuthor.classList.remove("hidden");
  } else {
    bookAuthor.classList.add("hidden");
  }

  if (metadata.coverUrl) {
    const image = document.createElement("img");
    image.src = metadata.coverUrl;
    image.alt = `${metadata.title || "本"}の表紙`;
    image.loading = "eager";
    image.onerror = () => {
      bookCover.innerHTML = '<span aria-hidden="true">📚</span>';
    };
    bookCover.innerHTML = "";
    bookCover.appendChild(image);
  }

  bookLoading.classList.add("hidden");
}

function clearAutoOcrTimer() {
  if (autoOcrTimer) {
    clearTimeout(autoOcrTimer);
    autoOcrTimer = null;
  }
}

function scheduleAutoOcr(delay = 3200) {
  clearAutoOcrTimer();
  if (autoOcrAttempts >= MAX_AUTO_OCR_ATTEMPTS) return;

  autoOcrTimer = setTimeout(() => {
    requestAutoOcr();
  }, delay);
}

function requestAutoOcr() {
  if (busy || !scannerStarted || autoOcrAttempts >= MAX_AUTO_OCR_ATTEMPTS) return;
  autoOcrAttempts += 1;
  invalidBarcodeSeenAt = 0;
  clearAutoOcrTimer();
  recognizeIsbnFromCamera(true);
}

function resetPendingRegistration() {
  pendingCode = null;
  pendingSourceLabel = "";
  pendingOwnedQuantity = 0;
  quantity = 1;
  qtyValue.textContent = "1";
  quantityPanel.classList.add("hidden");
  confirmBtn.disabled = false;
  plusBtn.disabled = false;
  minusBtn.disabled = true;
  resetBookPreview();
}

function updateQuantityControls() {
  qtyValue.textContent = String(quantity);
  minusBtn.disabled = quantity <= 1 || busy;
  plusBtn.disabled = busy;
  confirmBtn.disabled = busy;
}

async function stopScannerQuietly() {
  clearAutoOcrTimer();
  if (!scanner || !scannerStarted) return;
  try {
    await scanner.stop();
  } catch (_) {
    // camera stop races are harmless
  }
  scannerStarted = false;
}

function hideCameraControls() {
  reader.classList.add("hidden");
  ocrBtn.classList.add("hidden");
  ocrHelp.classList.add("hidden");
  startBtn.classList.add("hidden");
}

function showReadyToRepeat() {
  hideCameraControls();
  quantityPanel.classList.add("hidden");
  bookPreview.classList.add("hidden");
  againBtn.classList.remove("hidden");
  againBtn.textContent = "別のものを読み取る";
}

function isTutorialDismissed() {
  try {
    return localStorage.getItem(TUTORIAL_STORAGE_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function saveTutorialPreference() {
  try {
    if (tutorialDontShow.checked) {
      localStorage.setItem(TUTORIAL_STORAGE_KEY, "1");
    } else {
      localStorage.removeItem(TUTORIAL_STORAGE_KEY);
    }
  } catch (_) {
    // localStorageが使えなくてもチュートリアル自体は動かす
  }
}

async function openTutorial() {
  tutorialResumeAfterClose = scannerStarted;
  if (scannerStarted) await stopScannerQuietly();
  tutorialDontShow.checked = isTutorialDismissed();
  tutorialOverlay.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

async function closeTutorial({ resume = true } = {}) {
  saveTutorialPreference();
  tutorialOverlay.classList.add("hidden");
  document.body.style.overflow = "";

  const shouldResume = resume && tutorialResumeAfterClose;
  tutorialResumeAfterClose = false;
  if (shouldResume) await startScanner(false);
}

async function submitCode(code, sourceLabel) {
  const token = getShareToken();
  if (!token) {
    setStatus("家主リンクが必要です", "家主専用URLを開いてください。", "error");
    return;
  }

  const barcode = String(code || "").replace(/\D/g, "");
  if (!isValidIsbn13(barcode)) {
    setStatus(
      "本の番号を読み取れませんでした",
      "本のうらをカメラに向けて、バーコードや数字が書かれているあたりを映してください。",
      "error"
    );
    resetPendingRegistration();
    showReadyToRepeat();
    return;
  }

  hideCameraControls();
  quantityPanel.classList.add("hidden");
  againBtn.classList.add("hidden");
  setStatus("確認中…", `${sourceLabel}を確認しました。`, "", barcode);

  try {
    const result = await getOwnerItemState(token, barcode);
    if (!result || result.valid_token !== true) {
      setStatus("家主リンクが無効です", "新しい家主専用URLを開いてください。", "error");
      resetPendingRegistration();
      showReadyToRepeat();
      return;
    }

    if (result.valid_barcode === false) {
      setStatus(
        "登録できない番号です",
        "本のうらをもう一度カメラに向けてください。",
        "error",
        barcode
      );
      resetPendingRegistration();
      showReadyToRepeat();
      return;
    }

    pendingCode = barcode;
    pendingSourceLabel = sourceLabel;
    pendingOwnedQuantity = Number(result.quantity || 0);
    quantity = 1;
    updateQuantityControls();
    loadBookPreview(barcode);

    if (result.exists === true) {
      setStatus(
        "同じものを登録しますか？",
        `現在の所有数量 ×${pendingOwnedQuantity}`,
        "warn",
        barcode
      );
      quantityLabel.textContent = "追加する数量";
      confirmBtn.textContent = "追加する";
    } else {
      setStatus(
        "読み取りました",
        `${sourceLabel}を読み取りました。登録する数量を選んでください。`,
        "ok",
        barcode
      );
      quantityLabel.textContent = "登録する数量";
      confirmBtn.textContent = "登録する";
    }

    quantityPanel.classList.remove("hidden");
    againBtn.classList.remove("hidden");
    againBtn.textContent = "別のものを読み取る";
  } catch (error) {
    console.error(error);
    setStatus("確認できませんでした", "通信状態を確認して、もう一度お試しください。", "error", barcode);
    resetPendingRegistration();
    showReadyToRepeat();
  }
}

async function confirmRegistration() {
  if (busy || !pendingCode) return;

  const token = getShareToken();
  if (!token) {
    setStatus("家主リンクが必要です", "家主専用URLを開いてください。", "error");
    return;
  }

  busy = true;
  updateQuantityControls();
  againBtn.disabled = true;

  const barcode = pendingCode;
  const qty = quantity;
  const wasDuplicate = pendingOwnedQuantity > 0;
  setStatus(
    "登録中…",
    wasDuplicate ? `同じものを${qty}個追加しています。` : `${qty}個登録しています。`,
    "",
    barcode
  );

  try {
    const result = await registerItem(token, barcode, qty);
    if (!result || result.valid_token !== true) {
      setStatus("家主リンクが無効です", "新しい家主専用URLを開いてください。", "error");
      resetPendingRegistration();
      showReadyToRepeat();
      return;
    }

    if (result.valid_barcode === false || result.valid_quantity === false) {
      setStatus("登録できませんでした", "本の番号と数量を確認してください。", "error", barcode);
      resetPendingRegistration();
      showReadyToRepeat();
      return;
    }

    const before = Number(result.quantity_before || 0);
    const after = Number(result.quantity || before + qty);
    setStatus(
      "登録しました",
      before > 0 ? `所有数量 ×${before} → ×${after}` : `所有数量 ×${after}`,
      "ok",
      barcode
    );

    resetPendingRegistration();
    showReadyToRepeat();
  } catch (error) {
    console.error(error);
    setStatus("登録できませんでした", "通信状態を確認して、もう一度お試しください。", "error", barcode);
    quantityPanel.classList.remove("hidden");
    if (pendingCode) bookPreview.classList.remove("hidden");
  } finally {
    busy = false;
    againBtn.disabled = false;
    updateQuantityControls();
  }
}

function extractValidIsbn(text) {
  if (window.KoreMotteruOcr?.extractValidIsbn) {
    return window.KoreMotteruOcr.extractValidIsbn(text);
  }

  const raw = String(text || "");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const candidates = [...lines, raw];

  for (const line of candidates) {
    const matches = line.match(/97[89][0-9\s-]{10,28}/g) || [];
    for (const match of matches) {
      const digits = match.replace(/\D/g, "");
      for (let i = 0; i <= digits.length - 13; i += 1) {
        const isbn = digits.slice(i, i + 13);
        if (isValidIsbn13(isbn)) return isbn;
      }
    }
  }
  return null;
}

function captureCenteredFrame() {
  const video = reader.querySelector("video");
  if (!video || !video.videoWidth || !video.videoHeight) return false;

  const sourceW = video.videoWidth;
  const sourceH = video.videoHeight;
  const cropW = Math.floor(sourceW * 0.94);
  const cropH = Math.floor(sourceH * 0.68);
  const sx = Math.floor((sourceW - cropW) / 2);
  const sy = Math.floor((sourceH - cropH) / 2);

  const maxWidth = 1400;
  const scale = Math.min(1, maxWidth / cropW);
  captureCanvas.width = Math.floor(cropW * scale);
  captureCanvas.height = Math.floor(cropH * scale);

  const ctx = captureCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, captureCanvas.width, captureCanvas.height);
  return true;
}

function createHighContrastNumberBand(sourceCanvas) {
  const canvas = document.createElement("canvas");
  const cropY = Math.floor(sourceCanvas.height * 0.16);
  const cropHeight = Math.max(1, Math.floor(sourceCanvas.height * 0.68));
  const scale = Math.max(1, Math.min(1.6, 1800 / sourceCanvas.width));

  canvas.width = Math.max(1, Math.floor(sourceCanvas.width * scale));
  canvas.height = Math.max(1, Math.floor(cropHeight * scale));

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(
    sourceCanvas,
    0,
    cropY,
    sourceCanvas.width,
    cropHeight,
    0,
    0,
    canvas.width,
    canvas.height
  );

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = image.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const gray = Math.round(pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114);
    const contrasted = Math.max(0, Math.min(255, Math.round((gray - 128) * 1.65 + 128)));
    pixels[i] = contrasted;
    pixels[i + 1] = contrasted;
    pixels[i + 2] = contrasted;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

async function recognizeValidIsbn(worker) {
  const passes = [
    { image: captureCanvas, pageSegMode: "11" },
    { image: createHighContrastNumberBand(captureCanvas), pageSegMode: "7" },
  ];

  for (const pass of passes) {
    await worker.setParameters({
      tessedit_char_whitelist: "ISBNisbnOQDILZSGB0123456789- ",
      tessedit_pageseg_mode: pass.pageSegMode,
    });
    const { data } = await worker.recognize(pass.image);
    const isbn = extractValidIsbn(data?.text || "");
    if (isbn) return isbn;
  }
  return null;
}

async function getOcrWorker() {
  if (ocrWorkerPromise) return ocrWorkerPromise;
  if (typeof Tesseract === "undefined") throw new Error("Tesseract unavailable");

  ocrWorkerPromise = (async () => {
    const worker = await Tesseract.createWorker("eng", 1, {
      logger: (message) => {
        if (message.status === "recognizing text" && Number.isFinite(message.progress)) {
          setStatus("本の番号を探しています…", `${Math.round(message.progress * 100)}%`);
        }
      },
    });

    await worker.setParameters({
      tessedit_char_whitelist: "ISBNisbnOQDILZSGB0123456789- ",
      tessedit_pageseg_mode: "11",
    });
    return worker;
  })();

  try {
    return await ocrWorkerPromise;
  } catch (error) {
    ocrWorkerPromise = null;
    throw error;
  }
}

async function recognizeIsbnFromCamera(autoMode = false) {
  if (busy) return;
  busy = true;
  clearAutoOcrTimer();
  ocrBtn.disabled = true;

  const captured = captureCenteredFrame();
  if (!captured) {
    busy = false;
    ocrBtn.disabled = false;
    if (autoMode) {
      setStatus(
        "読み取り中",
        "本のうらを少し近づけて、数字が書かれているあたりを中央に向けてください。"
      );
      scheduleAutoOcr(1800);
      return;
    }
    setStatus("画像を取得できませんでした", "カメラを起動し直してください。", "error");
    return;
  }

  await stopScannerQuietly();
  hideCameraControls();
  setStatus("本の番号を探しています…", "そのまま本のうらをカメラに向けてください。");

  try {
    const worker = await getOcrWorker();
    const isbn = await recognizeValidIsbn(worker);

    if (!isbn) {
      if (autoMode) {
        busy = false;
        ocrBtn.disabled = false;
        await startScanner(false);
        setStatus(
          "読み取り中",
          "本のうらをそのまま映してください。バーコードや数字から登録できる番号を探します。"
        );
        return;
      }

      setStatus(
        "番号を見つけられませんでした",
        "本のうらの、数字が書かれているあたりを大きく映して、もう一度試してください。",
        "error"
      );
      showReadyToRepeat();
      return;
    }

    await submitCode(isbn, "本の番号");
  } catch (error) {
    console.error(error);
    if (autoMode) {
      busy = false;
      ocrBtn.disabled = false;
      await startScanner(false);
      setStatus(
        "読み取り中",
        "本のうらをそのまま映してください。バーコードが2つあっても大丈夫です。"
      );
      return;
    }

    setStatus(
      "本の番号を読めませんでした",
      "もう一度、本のうらをカメラに向けてください。",
      "error"
    );
    showReadyToRepeat();
  } finally {
    busy = false;
    ocrBtn.disabled = false;
    updateQuantityControls();
  }
}

async function handleDecodedBarcode(decodedText) {
  const barcode = String(decodedText || "").replace(/\D/g, "");

  if (!isValidIsbn13(barcode)) {
    if (!invalidBarcodeSeenAt) invalidBarcodeSeenAt = Date.now();

    if (
      Date.now() - invalidBarcodeSeenAt >= INVALID_BARCODE_OCR_DELAY_MS &&
      autoOcrAttempts < MAX_AUTO_OCR_ATTEMPTS
    ) {
      requestAutoOcr();
    }
    return;
  }

  invalidBarcodeSeenAt = 0;
  if (busy) return;

  busy = true;
  clearAutoOcrTimer();
  await stopScannerQuietly();
  await submitCode(barcode, "バーコード");
  busy = false;
  updateQuantityControls();
}

async function startScanner(resetAuto = true) {
  const token = getShareToken();
  if (!token) {
    setStatus("家主リンクが必要です", "家主専用URLを開いてください。", "error");
    return;
  }
  if (typeof Html5Qrcode === "undefined") {
    setStatus("読み取り機能を起動できません", "ページを再読み込みしてください。", "error");
    return;
  }

  if (resetAuto) {
    autoOcrAttempts = 0;
    invalidBarcodeSeenAt = 0;
  }

  busy = false;
  resetPendingRegistration();
  reader.classList.remove("scan-rejected");
  startBtn.classList.add("hidden");
  againBtn.classList.add("hidden");
  reader.classList.remove("hidden");
  ocrBtn.classList.remove("hidden");
  ocrHelp.classList.remove("hidden");
  setStatus(
    "読み取り中",
    "本のうらをカメラに向けてください。バーコードが2つあっても、そのままで大丈夫です。"
  );

  if (!scanner) {
    scanner = new Html5Qrcode("reader", {
      formatsToSupport: [Html5QrcodeSupportedFormats.EAN_13],
      verbose: false,
    });
  }

  try {
    await scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 300, height: 150 }, aspectRatio: 1.777778 },
      handleDecodedBarcode,
      () => {}
    );
    scannerStarted = true;
    scheduleAutoOcr(3200);
  } catch (error) {
    console.error(error);
    hideCameraControls();
    startBtn.classList.remove("hidden");
    setStatus("カメラを起動できませんでした", "Safariのカメラ許可を確認してください。", "error");
  }
}

minusBtn.addEventListener("click", () => {
  quantity = Math.max(1, quantity - 1);
  updateQuantityControls();
});

plusBtn.addEventListener("click", () => {
  quantity += 1;
  updateQuantityControls();
});

confirmBtn.addEventListener("click", confirmRegistration);
startBtn.addEventListener("click", () => startScanner(true));
againBtn.addEventListener("click", () => startScanner(true));
ocrBtn.addEventListener("click", () => recognizeIsbnFromCamera(false));
tutorialHelpBtn.addEventListener("click", openTutorial);
tutorialCloseBtn.addEventListener("click", () => closeTutorial({ resume: true }));
tutorialStartBtn.addEventListener("click", async () => {
  await closeTutorial({ resume: false });
  await startScanner(true);
});

window.addEventListener("pagehide", async () => {
  await stopScannerQuietly();
  if (ocrWorkerPromise) {
    try {
      const worker = await ocrWorkerPromise;
      await worker.terminate();
    } catch (_) {}
  }
});

updateQuantityControls();
resetBookPreview();

if (!isTutorialDismissed()) {
  setTimeout(() => {
    openTutorial();
  }, 0);
}
