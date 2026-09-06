const SUPABASE_URL = "https://dnxllbdagnnjsnadlqly.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_YCQsOS8F6kME99vOsabvUg_R6pr5E54";

const startBtn = document.getElementById("startBtn");
const againBtn = document.getElementById("againBtn");
const reader = document.getElementById("reader");
const statusBox = document.getElementById("status");

let scanner = null;
let scannerStarted = false;
let busy = false;

function getShareToken() {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return null;

  const params = new URLSearchParams(raw);
  if (params.has("token")) return params.get("token");

  // #<token> 形式も一応受け付ける
  return raw;
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function checkBarcode(token, barcode) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/check_household_barcode`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_token: token,
        p_barcode: barcode,
      }),
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase ${response.status}: ${detail}`);
  }

  return await response.json();
}

async function stopScannerQuietly() {
  if (!scanner || !scannerStarted) return;
  try {
    await scanner.stop();
  } catch (_) {
    // 画面遷移や停止競合では無視
  }
  scannerStarted = false;
}

async function startScanner() {
  const token = getShareToken();
  if (!token) {
    setStatus(
      "共有リンクが無効です",
      "このページは家庭から送られた共有リンクで開いてください。",
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
      async (decodedText) => {
        if (busy) return;
        busy = true;

        const barcode = String(decodedText).trim();
        await stopScannerQuietly();
        reader.classList.add("hidden");
        setBarcodeStatus("照合中…", "少しだけ待ってください。", barcode);

        try {
          const registered = await checkBarcode(token, barcode);

          if (registered === true) {
            setBarcodeStatus(
              "登録されています",
              "この商品はこの家庭に登録されています。",
              barcode,
              "ok"
            );
          } else {
            setBarcodeStatus(
              "登録されていません",
              "このバーコードはこの家庭に登録されていません。",
              barcode,
              "ng"
            );
          }
        } catch (error) {
          console.error(error);
          setBarcodeStatus(
            "照合できませんでした",
            "通信状態を確認して、もう一度お試しください。",
            barcode,
            "error"
          );
        } finally {
          againBtn.classList.remove("hidden");
        }
      },
      () => {
        // 読み取り途中のフレーム失敗は正常なので表示しない
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

startBtn.addEventListener("click", startScanner);
againBtn.addEventListener("click", startScanner);

window.addEventListener("pagehide", () => {
  stopScannerQuietly();
});

if (!getShareToken()) {
  setStatus(
    "共有リンクが必要です",
    "家庭から届いた専用リンクを開いてください。",
    "error"
  );
}
