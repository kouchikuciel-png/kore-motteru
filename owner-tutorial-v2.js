(() => {
  const overlay = document.getElementById("tutorialOverlay");
  const helpBtn = document.getElementById("tutorialHelpBtn");
  if (!overlay || !helpBtn) return;

  const STORAGE_KEY = "kore-motteru-owner-tutorial-dismissed-v1";
  let resumeAfterClose = false;

  const style = document.createElement("style");
  style.textContent = `
    .tutorial-v2-sheet{position:relative;width:min(100%,560px);max-height:calc(100dvh - 36px);overflow:auto;border-radius:24px;padding:24px 20px 20px;background:#fff;box-shadow:0 18px 60px rgba(0,0,0,.28)}
    .tutorial-v2-sheet h2{margin:0 44px 10px 0;font-size:28px;line-height:1.25}
    .tutorial-v2-lead{margin:0 0 18px;color:#555;line-height:1.6;font-size:16px}
    .tutorial-v2-close{position:absolute;right:14px;top:14px;width:42px;height:42px;padding:0;border-radius:50%;background:#ececec;color:#111;font-size:24px}
    .tutorial-v2-actions{display:grid;gap:10px;margin-top:16px}
    .tutorial-v2-secondary{background:#ececec!important;color:#111!important}
    .tutorial-v2-check{display:flex;align-items:center;gap:10px;margin:14px 0 4px;font-size:16px;line-height:1.4}
    .tutorial-v2-check input{width:22px;height:22px;flex:0 0 auto}
    .camera-demo{position:relative;height:330px;margin:10px 0 16px;border-radius:22px;overflow:hidden;background:linear-gradient(180deg,#555,#292929)}
    .camera-demo::before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 20% 15%,rgba(255,255,255,.12),transparent 28%),linear-gradient(135deg,rgba(255,255,255,.06),transparent 55%)}
    .camera-ui{position:absolute;inset:0;border:3px solid rgba(255,255,255,.18);border-radius:22px}
    .camera-label{position:absolute;left:50%;top:14px;transform:translateX(-50%);padding:6px 10px;border-radius:999px;background:rgba(0,0,0,.45);color:#fff;font-size:13px;white-space:nowrap}
    .camera-focus{position:absolute;left:50%;top:50%;width:236px;height:166px;transform:translate(-50%,-50%);border:4px solid rgba(255,255,255,.72);border-radius:16px;animation:tutorialFocus 7.2s ease-in-out infinite}
    .tutorial-book{position:absolute;left:50%;top:53%;width:180px;height:240px;transform-style:preserve-3d;transform:translate(-50%,-50%) rotateY(0deg) scale(.78);animation:tutorialBook 7.2s ease-in-out infinite}
    .tutorial-book-face{position:absolute;inset:0;border-radius:8px;backface-visibility:hidden;box-shadow:0 16px 35px rgba(0,0,0,.35);overflow:hidden}
    .tutorial-book-front{display:grid;place-items:center;background:linear-gradient(145deg,#d8b77a,#8b5f2d);color:#fff;text-align:center;font-weight:800;font-size:22px;line-height:1.25;padding:18px}
    .tutorial-book-front::after{content:"BOOK";display:block;margin-top:12px;font-size:11px;letter-spacing:.24em;opacity:.78}
    .tutorial-book-back{transform:rotateY(180deg);background:#f5f0e5}
    .tutorial-book-back::before{content:"";position:absolute;left:18px;right:18px;top:18px;height:62px;background:linear-gradient(#d5d0c5,#d5d0c5) left top/72% 7px no-repeat,linear-gradient(#d5d0c5,#d5d0c5) left 18px/88% 7px no-repeat,linear-gradient(#d5d0c5,#d5d0c5) left 36px/60% 7px no-repeat}
    .tutorial-barcode-wrap{position:absolute;left:20px;right:20px;bottom:34px;height:80px;animation:tutorialBarcode 7.2s ease-in-out infinite}
    .tutorial-barcode{height:44px;background:repeating-linear-gradient(90deg,#111 0 2px,transparent 2px 5px,#111 5px 8px,transparent 8px 11px,#111 11px 12px,transparent 12px 15px)}
    .tutorial-barcode-num{text-align:center;color:#222;font:700 13px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:1px;margin-top:5px}
    .tutorial-scan-line{position:absolute;left:50%;top:58%;width:210px;height:72px;transform:translate(-50%,-50%);border:5px solid #58d33c;border-radius:12px;opacity:0;animation:tutorialScan 7.2s ease-in-out infinite}
    .tutorial-scan-line::after{content:"";position:absolute;left:10px;right:10px;top:50%;height:2px;background:#58d33c}
    .tutorial-step{min-height:54px;text-align:center;font-size:20px;font-weight:800;line-height:1.45;margin:4px 0 0}
    .tutorial-step::after{display:block;margin-top:5px;color:#777;font-size:14px;font-weight:500;content:"本をカメラに見せるだけ";animation:tutorialText 7.2s step-end infinite}
    @keyframes tutorialBook{0%,20%{transform:translate(-50%,-50%) rotateY(0deg) scale(.78)}30%,49%{transform:translate(-50%,-50%) rotateY(180deg) scale(.78)}58%,88%{transform:translate(-50%,-50%) rotateY(180deg) scale(1.18) translateY(12px)}100%{transform:translate(-50%,-50%) rotateY(0deg) scale(.78)}}
    @keyframes tutorialFocus{0%,50%{width:236px;height:166px;top:50%}58%,88%{width:245px;height:112px;top:65%}100%{width:236px;height:166px;top:50%}}
    @keyframes tutorialBarcode{0%,50%{transform:scale(1)}58%,88%{transform:scale(1.18)}100%{transform:scale(1)}}
    @keyframes tutorialScan{0%,55%{opacity:0}62%,88%{opacity:1}100%{opacity:0}}
    @keyframes tutorialText{0%,29%{content:"まず本をカメラに見せます"}30%,57%{content:"本をうら返します"}58%,92%{content:"バーコードのあたりを少し大きく映します"}100%{content:"本をカメラに見せるだけ"}}
    @media (prefers-color-scheme:dark){.tutorial-v2-sheet{background:#181818}.tutorial-v2-lead,.tutorial-step::after{color:#aaa}.tutorial-v2-close,.tutorial-v2-secondary{background:#2d2d2d!important;color:#fff!important}}
    @media (prefers-reduced-motion:reduce){.tutorial-book,.camera-focus,.tutorial-barcode-wrap,.tutorial-scan-line,.tutorial-step::after{animation:none!important}.tutorial-book{transform:translate(-50%,-50%) rotateY(180deg) scale(1.05)}.tutorial-scan-line{opacity:1}}
  `;
  document.head.appendChild(style);

  function dismissed() {
    try { return localStorage.getItem(STORAGE_KEY) === "1"; } catch (_) { return false; }
  }

  function savePreference(checked) {
    try {
      if (checked) localStorage.setItem(STORAGE_KEY, "1");
      else localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  function setOverlay(content) {
    overlay.innerHTML = `<div class="tutorial-v2-sheet">${content}</div>`;
    overlay.classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }

  async function hideOverlay({ resume = false } = {}) {
    overlay.classList.add("hidden");
    document.body.style.overflow = "";
    const shouldResume = resume && resumeAfterClose;
    resumeAfterClose = false;
    if (shouldResume && typeof startScanner === "function") await startScanner(false);
  }

  function commonCheck() {
    return `<label class="tutorial-v2-check"><input id="tutorialV2DontShow" type="checkbox" ${dismissed() ? "checked" : ""}><span>次回から表示しない</span></label>`;
  }

  async function showPrompt() {
    resumeAfterClose = false;
    setOverlay(`
      <button id="tutorialV2Close" class="tutorial-v2-close" type="button" aria-label="閉じる">×</button>
      <h2>使い方を見ますか？</h2>
      <p class="tutorial-v2-lead">はじめてなら、10秒くらいの動きを見るとすぐ分かります。</p>
      ${commonCheck()}
      <div class="tutorial-v2-actions">
        <button id="tutorialV2Watch" type="button">使い方を見る</button>
        <button id="tutorialV2Skip" class="tutorial-v2-secondary" type="button">見ないで始める</button>
      </div>
    `);

    const checkbox = document.getElementById("tutorialV2DontShow");
    const persist = () => savePreference(checkbox?.checked);
    document.getElementById("tutorialV2Watch").onclick = () => { persist(); showAnimation(); };
    document.getElementById("tutorialV2Skip").onclick = async () => { persist(); await hideOverlay({ resume: false }); if (typeof startScanner === "function") await startScanner(true); };
    document.getElementById("tutorialV2Close").onclick = async () => { persist(); await hideOverlay({ resume: false }); };
  }

  function showAnimation() {
    setOverlay(`
      <button id="tutorialV2Close" class="tutorial-v2-close" type="button" aria-label="閉じる">×</button>
      <h2>こんな感じで映します</h2>
      <p class="tutorial-v2-lead">本をうら返して、バーコードのあたりをカメラに見せます。</p>
      <div class="camera-demo" aria-label="本を裏返してバーコード周辺をカメラに映すアニメーション">
        <div class="camera-ui"></div>
        <div class="camera-label">カメラの画面</div>
        <div class="camera-focus"></div>
        <div class="tutorial-book">
          <div class="tutorial-book-face tutorial-book-front">本の表紙</div>
          <div class="tutorial-book-face tutorial-book-back">
            <div class="tutorial-barcode-wrap"><div class="tutorial-barcode"></div><div class="tutorial-barcode-num">978 4 08 874171 0</div></div>
          </div>
        </div>
        <div class="tutorial-scan-line"></div>
      </div>
      <p class="tutorial-step">本をカメラに向ける → うら返す → バーコード付近を映す</p>
      ${commonCheck()}
      <div class="tutorial-v2-actions">
        <button id="tutorialV2Start" type="button">カメラで登録する</button>
      </div>
    `);

    const checkbox = document.getElementById("tutorialV2DontShow");
    const persist = () => savePreference(checkbox?.checked);
    document.getElementById("tutorialV2Start").onclick = async () => { persist(); await hideOverlay({ resume: false }); if (typeof startScanner === "function") await startScanner(true); };
    document.getElementById("tutorialV2Close").onclick = async () => { persist(); await hideOverlay({ resume: false }); };
  }

  window.openTutorial = showPrompt;

  helpBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    showAnimation();
  }, true);

  // 旧チュートリアルのsetTimeoutが先に発火していた場合、その要求をここで引き継ぐ。
  if (window.__ownerTutorialV2Pending && !dismissed()) {
    window.__ownerTutorialV2Pending = false;
    showPrompt();
  }
})();
