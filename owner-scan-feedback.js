(() => {
  if (typeof Html5Qrcode === "undefined") return;

  const prototype = Html5Qrcode.prototype;
  if (!prototype || prototype.__koreMotteruInvalidIsbnFeedback) return;

  const originalStart = prototype.start;
  if (typeof originalStart !== "function") return;

  const reader = document.getElementById("reader");
  const statusBox = document.getElementById("status");
  let rejectedResetTimer = null;
  let lastRejectedBarcode = "";

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

  function setRejectedStatus(barcode) {
    if (!reader || !statusBox) return;

    // 内部ではISBNかどうかを判定するが、利用者には専門用語を出さない。
    // 本のうらを見せてもらい、違う方を読んだ時だけもう一方へ誘導する。
    if (typeof window.clearAutoOcrTimer === "function") {
      window.clearAutoOcrTimer();
    }

    reader.classList.add("scan-rejected");

    if (lastRejectedBarcode !== barcode) {
      statusBox.className = "status error";
      statusBox.innerHTML = `
        <strong>別のバーコードです</strong>
        <span>本のうらにバーコードが2つある場合は、近くにあるもう1つのバーコードを映してください。</span>
      `;
      lastRejectedBarcode = barcode;
    }

    clearTimeout(rejectedResetTimer);
    rejectedResetTimer = setTimeout(() => {
      reader.classList.remove("scan-rejected");
      lastRejectedBarcode = "";

      if (!reader.classList.contains("hidden") && statusBox.classList.contains("error")) {
        statusBox.className = "status";
        statusBox.innerHTML = `
          <strong>読み取り中</strong>
          <span>本のうらにある、もう1つのバーコードを枠の中に入れてください。</span>
        `;
      }
    }, 900);
  }

  function clearRejectedStatus() {
    clearTimeout(rejectedResetTimer);
    rejectedResetTimer = null;
    lastRejectedBarcode = "";
    reader?.classList.remove("scan-rejected");
  }

  prototype.start = function patchedStart(
    cameraIdOrConfig,
    configuration,
    qrCodeSuccessCallback,
    qrCodeErrorCallback
  ) {
    const wrappedSuccess = (decodedText, decodedResult) => {
      const barcode = String(decodedText || "").replace(/\D/g, "");

      if (/^\d{13}$/.test(barcode) && !isValidIsbn13(barcode)) {
        setRejectedStatus(barcode);
      } else {
        clearRejectedStatus();
      }

      return qrCodeSuccessCallback(decodedText, decodedResult);
    };

    return originalStart.call(
      this,
      cameraIdOrConfig,
      configuration,
      wrappedSuccess,
      qrCodeErrorCallback
    );
  };

  prototype.__koreMotteruInvalidIsbnFeedback = true;
})();
