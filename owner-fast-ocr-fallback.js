(() => {
  if (typeof Html5Qrcode === "undefined") return;

  const prototype = Html5Qrcode.prototype;
  if (!prototype || prototype.__koreMotteruFastOcrFallback) return;

  const originalStart = prototype.start;
  if (typeof originalStart !== "function") return;

  const INVALID_HITS_TO_TRIGGER = 2;
  const INVALID_STREAK_WINDOW_MS = 1200;
  const QUICK_OCR_COOLDOWN_MS = 2600;

  let lastInvalidBarcode = "";
  let invalidHitCount = 0;
  let invalidStreakStartedAt = 0;
  let quickOcrCooldownUntil = 0;
  let quickOcrRunning = false;

  function isValidIsbn13(value) {
    const isbn = String(value || "");
    if (!/^97[89]\d{10}$/.test(isbn)) return false;

    let sum = 0;
    for (let i = 0; i < 12; i += 1) {
      sum += Number(isbn[i]) * (i % 2 === 0 ? 1 : 3);
    }
    return ((10 - (sum % 10)) % 10) === Number(isbn[12]);
  }

  function resetInvalidStreak() {
    lastInvalidBarcode = "";
    invalidHitCount = 0;
    invalidStreakStartedAt = 0;
  }

  function captureUpperBookArea() {
    const video = reader?.querySelector("video");
    if (!video || !video.videoWidth || !video.videoHeight || !captureCanvas) return false;

    const sourceW = video.videoWidth;
    const sourceH = video.videoHeight;

    // 日本の2段バーコードでは本のISBN側が上段に来ることが多い。
    // 192...など下段を連続検出した時だけ、上側を広めに切り出して数字を探す。
    const sx = Math.floor(sourceW * 0.03);
    const sy = Math.floor(sourceH * 0.04);
    const cropW = Math.floor(sourceW * 0.94);
    const cropH = Math.floor(sourceH * 0.64);

    const maxWidth = 1500;
    const scale = Math.min(1, maxWidth / cropW);
    captureCanvas.width = Math.max(1, Math.floor(cropW * scale));
    captureCanvas.height = Math.max(1, Math.floor(cropH * scale));

    const ctx = captureCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(
      video,
      sx,
      sy,
      cropW,
      cropH,
      0,
      0,
      captureCanvas.width,
      captureCanvas.height
    );

    // OCR向けに軽くグレースケール＋コントラスト補正する。
    try {
      const image = ctx.getImageData(0, 0, captureCanvas.width, captureCanvas.height);
      const pixels = image.data;
      for (let i = 0; i < pixels.length; i += 4) {
        const gray = Math.round(pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114);
        const contrasted = Math.max(0, Math.min(255, Math.round((gray - 128) * 1.32 + 128)));
        pixels[i] = contrasted;
        pixels[i + 1] = contrasted;
        pixels[i + 2] = contrasted;
      }
      ctx.putImageData(image, 0, 0);
    } catch (_) {
      // 画像補正に失敗しても元フレームでOCRを続ける。
    }

    return true;
  }

  async function runQuickUpperOcr() {
    if (quickOcrRunning || busy || !scannerStarted) return;
    if (Date.now() < quickOcrCooldownUntil) return;

    quickOcrRunning = true;
    quickOcrCooldownUntil = Date.now() + QUICK_OCR_COOLDOWN_MS;
    resetInvalidStreak();
    busy = true;
    clearAutoOcrTimer();

    if (!captureUpperBookArea()) {
      busy = false;
      quickOcrRunning = false;
      return;
    }

    await stopScannerQuietly();
    hideCameraControls();
    setStatus(
      "本の番号を探しています…",
      "別のバーコードを読み取ったため、近くにある本の番号も確認しています。"
    );

    try {
      const worker = await getOcrWorker();
      await worker.setParameters({
        tessedit_char_whitelist: "ISBNisbnXx0123456789- ",
        tessedit_pageseg_mode: "11",
      });

      const { data } = await worker.recognize(captureCanvas);
      const isbn = extractValidIsbn(data?.text || "");

      // 通常OCRの設定へ戻す。
      await worker.setParameters({
        tessedit_char_whitelist: "ISBNisbnXx0123456789- ",
        tessedit_pageseg_mode: "6",
      });

      if (isbn) {
        await submitCode(isbn, "本の番号");
        return;
      }

      busy = false;
      await startScanner(false);
      setStatus(
        "読み取り中",
        "本のうらをそのまま映してください。もう1つのバーコードや数字を探します。"
      );
    } catch (error) {
      console.warn("quick upper OCR failed", error);
      busy = false;
      try {
        await startScanner(false);
      } catch (_) {}
    } finally {
      busy = false;
      quickOcrRunning = false;
      updateQuantityControls();
    }
  }

  function noteInvalidBarcode(barcode) {
    const now = Date.now();

    if (
      barcode !== lastInvalidBarcode ||
      !invalidStreakStartedAt ||
      now - invalidStreakStartedAt > INVALID_STREAK_WINDOW_MS
    ) {
      lastInvalidBarcode = barcode;
      invalidHitCount = 1;
      invalidStreakStartedAt = now;
      return;
    }

    invalidHitCount += 1;
    if (invalidHitCount >= INVALID_HITS_TO_TRIGGER) {
      setTimeout(runQuickUpperOcr, 0);
    }
  }

  prototype.start = function fastFallbackStart(
    cameraIdOrConfig,
    configuration,
    qrCodeSuccessCallback,
    qrCodeErrorCallback
  ) {
    const wrappedSuccess = (decodedText, decodedResult) => {
      const barcode = String(decodedText || "").replace(/\D/g, "");

      if (/^\d{13}$/.test(barcode) && !isValidIsbn13(barcode)) {
        noteInvalidBarcode(barcode);
      } else if (isValidIsbn13(barcode)) {
        resetInvalidStreak();
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

  prototype.__koreMotteruFastOcrFallback = true;
})();
