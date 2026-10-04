(() => {
  const overlay = document.getElementById("tutorialOverlay");
  const helpBtn = document.getElementById("tutorialHelpBtn");
  if (!overlay || !helpBtn) return;

  const STORAGE_KEY = "kore-motteru-owner-tutorial-dismissed-v1";
  let resumeAfterClose = false;

  const style = document.createElement("style");
  style.textContent = `
    .tutorial-v2-sheet{position:relative;box-sizing:border-box;width:min(100%,560px);max-height:calc(100dvh - 36px);overflow:auto;border-radius:24px;padding:24px 20px 20px;background:#fff;box-shadow:0 18px 60px rgba(0,0,0,.28)}
    .tutorial-v2-sheet h2{margin:0 40px 10px 0;font-size:clamp(18px,5.6vw,26px);line-height:1.3;text-wrap:balance}
    .tutorial-v2-lead{margin:0 0 14px;color:#555;line-height:1.6;font-size:16px}
    .tutorial-v2-close{position:absolute;right:14px;top:14px;width:44px;height:44px;padding:0;border-radius:50%;background:#ececec;color:#111;font-size:24px}
    .tutorial-v2-actions{position:sticky;bottom:-20px;display:grid;gap:10px;margin:16px -4px 0;padding:10px 4px 0;background:inherit}
    .tutorial-v2-actions button{min-height:52px}
    .tutorial-v2-secondary{background:#ececec!important;color:#111!important}
    @media (prefers-color-scheme:dark){.tutorial-v2-sheet{background:#181818;color:#fff}.tutorial-v2-lead{color:#aaa}.tutorial-v2-close,.tutorial-v2-secondary{background:#2d2d2d!important;color:#fff!important}}
  `;
  document.head.appendChild(style);

  const onboarding = window.KoreMotteruOnboarding || null;
  onboarding?.injectStyle?.();

  // 一度最後まで見た（または閉じた）端末では、次回から自動表示しない。
  // 以前の「次回から表示しない」を選んだ端末も自動表示しない。
  function dismissed() {
    if (onboarding) return onboarding.ownerOnboardingDone(onboarding.localStorageOrNull());
    try { return localStorage.getItem(STORAGE_KEY) === "1"; } catch (_) { return false; }
  }

  function markDone() {
    if (onboarding) onboarding.markOwnerOnboardingDone(onboarding.localStorageOrNull());
    else {
      try { localStorage.setItem(STORAGE_KEY, "1"); } catch (_) {}
    }
  }

  function setOverlay(content) {
    overlay.innerHTML = `<div class="tutorial-v2-sheet">${content}</div>`;
    overlay.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    overlay.querySelector(".tutorial-v2-sheet").scrollTop = 0;
    overlay.querySelector("[data-tutorial-primary]")?.focus({ preventScroll: true });
  }

  async function hideOverlay({ resume = false } = {}) {
    overlay.classList.add("hidden");
    document.body.style.overflow = "";
    const shouldResume = resume && resumeAfterClose;
    resumeAfterClose = false;
    if (shouldResume && typeof startScanner === "function") await startScanner(false);
  }

  async function finish({ startCamera }) {
    markDone();
    await hideOverlay({ resume: !startCamera });
    // カメラはユーザーが「本を登録してみる」を選んだ時だけ起動する。
    if (startCamera && typeof startScanner === "function") await startScanner(true);
  }

  function bindClose() {
    document.getElementById("tutorialV2Close").onclick = () => finish({ startCamera: false });
    overlay.onkeydown = (event) => {
      if (event.key === "Escape") finish({ startCamera: false });
    };
  }

  // 1画面目: アプリ全体でできること3つ。
  function showOverview() {
    const copy = onboarding?.OWNER_COPY;
    setOverlay(`
      <button id="tutorialV2Close" class="tutorial-v2-close" type="button" aria-label="閉じる">×</button>
      <h2>${copy ? copy.title : "このページでできること"}</h2>
      ${copy ? onboarding.stepsHtml(copy.items) : ""}
      <div class="tutorial-v2-actions">
        <button id="tutorialV2Next" type="button" data-tutorial-primary>${copy ? copy.next : "次へ"}</button>
      </div>
    `);
    document.getElementById("tutorialV2Next").onclick = showHowTo;
    bindClose();
  }

  // 2画面目: 本の映し方（既存の二段バーコードのデモ）。
  function showHowTo() {
    const copy = onboarding?.OWNER_COPY;
    setOverlay(`
      <button id="tutorialV2Close" class="tutorial-v2-close" type="button" aria-label="閉じる">×</button>
      <h2>本の映し方</h2>
      <p class="tutorial-v2-lead">むずかしい番号を探す必要はありません。本のうらをカメラに見せるだけです。</p>
      <div class="tutorial-demo" aria-hidden="true">
        <div class="demo-phone">
          <div class="demo-book">
            <div class="demo-code one"><div class="demo-barcode"></div><div class="demo-number">9784088741710</div></div>
            <div class="demo-code two"><div class="demo-barcode"></div><div class="demo-number">1929979011430</div></div>
          </div>
          <div class="demo-scan"></div>
        </div>
      </div>
      <p class="tutorial-caption">本のうらを映してください。<span>バーコードが2つあっても、そのままで大丈夫です。読めないときは数字のあたりも自動で探します。</span></p>
      <div class="tutorial-v2-actions">
        <button id="tutorialV2Start" type="button" data-tutorial-primary>${copy ? copy.cta : "本を登録してみる"}</button>
        <button id="tutorialV2Back" class="tutorial-v2-secondary" type="button">もどる</button>
      </div>
    `);
    document.getElementById("tutorialV2Start").onclick = () => finish({ startCamera: true });
    document.getElementById("tutorialV2Back").onclick = showOverview;
    bindClose();
  }

  // 「使い方を見る」から開いた時は、カメラが動いていれば止め、閉じたら再開する。
  async function openFromHelp() {
    resumeAfterClose = typeof scannerStarted !== "undefined" && scannerStarted;
    if (resumeAfterClose && typeof stopScannerQuietly === "function") await stopScannerQuietly();
    showOverview();
  }

  window.openTutorial = showOverview;

  helpBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    openFromHelp();
  }, true);

  if (window.__ownerTutorialV2Pending && !dismissed()) {
    window.__ownerTutorialV2Pending = false;
    showOverview();
  }
})();
