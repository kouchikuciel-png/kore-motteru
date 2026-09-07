const SUPABASE_URL = "https://dnxllbdagnnjsnadlqly.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_YCQsOS8F6kME99vOsabvUg_R6pr5E54";

const startBtn = document.getElementById("startBtn");
const ocrBtn = document.getElementById("ocrBtn");
const ocrHelp = document.getElementById("ocrHelp");
const againBtn = document.getElementById("againBtn");
const reader = document.getElementById("reader");
const statusBox = document.getElementById("status");
const captureCanvas = document.getElementById("captureCanvas");

let scanner = null;
let scannerStarted = false;
let busy = false;
let autoOcrTimer = null;
let autoOcrAttempted = false;
let ocrWorkerPromise = null;

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

function registerItem(token, barcode) {
  return callRpc("register_household_item", {
    p_token: token,
    p_barcode: barcode,
  });
}

function clearAutoOcrTimer() {
  if (autoOcrTimer) {
    clearTimeout(autoOcrTimer);
    autoOcrTimer = null;
  }
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

function showReadyToRepeat() {
  reader.classList.add("hidden");
  ocrBtn.classList.add("hidden");
  ocrHelp.classList.add("hidden");
  startBtn.classList.add("hidden");
  againBtn.classList.remove("hidden");
}

async function submitCode(code, sourceLabel) {
  const token = getShareToken();
  if (!token) {
    setStatus("家主リンクが必要です", "家主専用URLを開いてください。", "error");
    return;
  }

  const barcode = String(code || "").replace(/\D/g, "");
  if (!/^\d{8,14}$/.test(barcode)) {
    setStatus("番号を認識できませんでした", "もう一度カメラを向けてください。", "error");
    showReadyToRepeat();
    return;
  }

  setStatus("登録中…", `${sourceLabel}から番号を確認しました。`, "", barcode);

  try {
    const result = await registerItem(token, barcode);
    if (!result || result.valid_token !== true) {
      setStatus("家主リンクが無効です", "新しい家主専用URLを開いてください。", "error");
      showReadyToRepeat();
      return;
    }

    if (result.valid_barcode === false) {
      setStatus("登録できない番号です", "8〜14桁の商品コードを確認してください。", "error", barcode);
      showReadyToRepeat();
      return;
    }

    if (result.created === true) {
      setStatus("登録しました", "持ってるもの一覧に追加されました。", "ok", barcode);
    } else {
      setStatus("すでに登録されています", `現在の所有数量 ×${result.quantity ?? 1}`, "warn", barcode);
    }
    showReadyToRepeat();
  } catch (error) {
    console.error(error);
    setStatus("登録できませんでした", "通信状態を確認して、もう一度お試しください。", "error", barcode);
    showReadyToRepeat();
  }
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

function extractValidIsbn(text) {
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
  const cropW = Math.floor(sourceW * 0.92);
  const cropH = Math.floor(sourceH * 0.48);
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

async function getOcrWorker() {
  if (ocrWorkerPromise) return ocrWorkerPromise;
  if (typeof Tesseract === "undefined") throw new Error("Tesseract unavailable");

  ocrWorkerPromise = (async () => {
    const worker = await Tesseract.createWorker("eng", 1, {
      logger: (message) => {
        if (message.status === "recognizing text" && Number.isFinite(message.progress)) {
          setStatus("ISBNを読んでいます…", `${Math.round(message.progress * 100)}%`);
        }
      },
    });

    await worker.setParameters({
      tessedit_char_whitelist: "ISBNisbn0123456789- ",
      tessedit_pageseg_mode: "6",
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
      setStatus("読み取り中", "本を少し近づけて、ISBNの行を中央に向けてください。");
      return;
    }
    setStatus("画像を取得できませんでした", "カメラを起動し直してください。", "error");
    return;
  }

  await stopScannerQuietly();
  reader.classList.add("hidden");
  ocrBtn.classList.add("hidden");
  ocrHelp.classList.add("hidden");
  setStatus("ISBNを読んでいます…", "印刷されたISBN番号を自動認識しています。");

  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(captureCanvas);
    const isbn = extractValidIsbn(data?.text || "");

    if (!isbn) {
      if (autoMode) {
        busy = false;
        ocrBtn.disabled = false;
        await startScanner(false);
        setStatus("読み取り中", "バーコードかISBNの行を中央に向けてください。必要ならISBN再読取も使えます。");
        return;
      }

      setStatus("ISBNを見つけられませんでした", "ISBNの行を中央に大きく映して、もう一度試してください。", "error");
      showReadyToRepeat();
      return;
    }

    await submitCode(isbn, "ISBN文字");
  } catch (error) {
    console.error(error);
    if (autoMode) {
      busy = false;
      ocrBtn.disabled = false;
      await startScanner(false);
      setStatus("読み取り中", "バーコードを向けてください。ISBN文字は再読取ボタンでも試せます。");
      return;
    }

    setStatus("ISBNを読めませんでした", "もう一度試すか、バーコードがある本で確認してください。", "error");
    showReadyToRepeat();
  } finally {
    busy = false;
    ocrBtn.disabled = false;
  }
}

async function handleDecodedBarcode(decodedText) {
  if (busy) return;
  busy = true;
  clearAutoOcrTimer();
  const barcode = String(decodedText || "").replace(/\D/g, "");
  await stopScannerQuietly();
  await submitCode(barcode, "バーコード");
  busy = false;
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

  if (resetAuto) autoOcrAttempted = false;
  busy = false;
  startBtn.classList.add("hidden");
  againBtn.classList.add("hidden");
  reader.classList.remove("hidden");
  ocrBtn.classList.remove("hidden");
  ocrHelp.classList.remove("hidden");
  setStatus("読み取り中", "バーコードを探しています。見つからなければISBN文字も自動で読みます。");

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
      { fps: 10, qrbox: { width: 300, height: 130 }, aspectRatio: 1.777778 },
      handleDecodedBarcode,
      () => {}
    );
    scannerStarted = true;

    if (!autoOcrAttempted) {
      autoOcrTimer = setTimeout(() => {
        if (!busy && scannerStarted) {
          autoOcrAttempted = true;
          recognizeIsbnFromCamera(true);
        }
      }, 3200);
    }
  } catch (error) {
    console.error(error);
    reader.classList.add("hidden");
    ocrBtn.classList.add("hidden");
    ocrHelp.classList.add("hidden");
    startBtn.classList.remove("hidden");
    setStatus("カメラを起動できませんでした", "Safariのカメラ許可を確認してください。", "error");
  }
}

startBtn.addEventListener("click", () => startScanner(true));
againBtn.addEventListener("click", () => startScanner(true));
ocrBtn.addEventListener("click", () => recognizeIsbnFromCamera(false));
window.addEventListener("pagehide", async () => {
  await stopScannerQuietly();
  if (ocrWorkerPromise) {
    try {
      const worker = await ocrWorkerPromise;
      await worker.terminate();
    } catch (_) {}
  }
});
