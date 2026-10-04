// 初回案内（Issue #42）。
// - 家族（共有リンク・専用QR）向け: 「このページでできること」を初回だけ自動表示する
// - 家主向け: owner-tutorial-v2.js が表示済みかどうかの保存にこのモジュールを使う
// 保存先は端末の localStorage だけ（DB・権限・データには触れない）。
// 共有リンクのトークンそのものは保存せず、呼び名の端末保存（handoff-ui.js）と同じ
// FNV-1a の指紋で共有先ごとに分ける。
(() => {
  const GUEST_KEY_PREFIX = "kore-motteru-guest-onboarding-seen-v1:";
  const OWNER_DONE_KEY = "kore-motteru-owner-onboarding-done-v2";
  // 以前のチュートリアルで「次回から表示しない」を選んだ端末は、そのまま自動表示しない。
  const OWNER_LEGACY_DISMISSED_KEY = "kore-motteru-owner-tutorial-dismissed-v1";

  // handoff-ui.js の tokenFingerprint と同じ計算（共有先ごとの端末保存キーを揃える）。
  function tokenFingerprint(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function guestStorageKey(token) {
    return `${GUEST_KEY_PREFIX}${tokenFingerprint(token)}`;
  }

  function read(storage, key) {
    try { return storage?.getItem(key) ?? null; } catch (_) { return null; }
  }

  function write(storage, key) {
    try { storage?.setItem(key, "1"); return true; } catch (_) { return false; }
  }

  function guestOnboardingSeen(storage, token) {
    return read(storage, guestStorageKey(token)) === "1";
  }

  function markGuestOnboardingSeen(storage, token) {
    return write(storage, guestStorageKey(token));
  }

  function ownerOnboardingDone(storage) {
    return read(storage, OWNER_DONE_KEY) === "1" || read(storage, OWNER_LEGACY_DISMISSED_KEY) === "1";
  }

  function markOwnerOnboardingDone(storage) {
    return write(storage, OWNER_DONE_KEY);
  }

  // 家族向けの表示文（Issue #42 の文案）。
  const GUEST_COPY = {
    title: "このページでできること",
    lead: "この家に登録されている本を見たり、買う前に同じ本がないか確認できます。",
    items: [
      { title: "家にある本を見る", text: "登録されている本を表紙で確認できます。" },
      { title: "買う前に確認する", text: "本のうらをカメラに見せると、すでに持っているか確認できます。" },
      { title: "渡した本を記録する", text: "「渡した」を記録すると、家主が受け取った時に家の本へ反映されます。" },
    ],
    note: "インストールは不要です。この専用QR・リンクから開けます。",
    cta: "持ってるものを見る",
    help: "使い方を見る",
  };

  // 家主向けの最初の3項目（Issue #42 の文案）。
  const OWNER_COPY = {
    title: "このページでできること",
    items: [
      { title: "家の本を登録する", text: "「カメラで登録する」から、本のうらを見せるだけ。" },
      { title: "家族に専用QRを渡す", text: "じいじ・ばあばなど、その人専用のQR/リンクから家の本を確認できます。" },
      { title: "受け取った本を確認する", text: "家族が「渡した」と記録した本は「受け取り待ち」に出ます。実際に受け取ったら確認します。" },
    ],
    next: "次へ：本の映し方",
    cta: "本を登録してみる",
  };

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function stepsHtml(items) {
    return `<ol class="onboarding-steps">${items.map((item, index) => `
      <li><span class="onboarding-step-number" aria-hidden="true">${index + 1}</span>
        <span class="onboarding-step-body"><strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.text)}</span></span></li>`).join("")}</ol>`;
  }

  // 案内の見た目（家族・家主で共用）。文字は大きめ、ボタンは押しやすく、ダークモード対応。
  const STYLE = `
    .onboarding-overlay{position:fixed;inset:0;z-index:20500;display:flex;align-items:flex-end;justify-content:center;
      padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom));background:rgba(0,0,0,.55)}
    .onboarding-sheet{position:relative;box-sizing:border-box;width:min(100%,560px);max-height:calc(100dvh - 32px);overflow:auto;
      border-radius:24px;padding:24px 20px 20px;background:#fff;color:#111;box-shadow:0 18px 60px rgba(0,0,0,.28)}
    .onboarding-sheet h2{margin:0 40px 10px 0;font-size:clamp(18px,5.6vw,26px);line-height:1.3;text-wrap:balance}
    .onboarding-lead{margin:0 0 16px;color:#444;font-size:17px;line-height:1.6}
    .onboarding-close{position:absolute;right:14px;top:14px;width:44px;height:44px;padding:0;border-radius:50%;
      background:#ececec;color:#111;font-size:24px}
    .onboarding-steps{list-style:none;margin:0 0 14px;padding:0;display:grid;gap:10px}
    .onboarding-steps li{display:flex;gap:12px;align-items:flex-start;padding:12px;border-radius:16px;background:#f5f5f5}
    .onboarding-step-number{flex:0 0 32px;height:32px;border-radius:50%;display:grid;place-items:center;
      background:#111;color:#fff;font-weight:800;font-size:17px}
    .onboarding-step-body{min-width:0;display:grid;gap:3px;line-height:1.5;overflow-wrap:anywhere}
    .onboarding-step-body strong{font-size:18px}
    .onboarding-step-body span{color:#444;font-size:16px}
    .onboarding-note{margin:0 0 14px;color:#666;font-size:14px;line-height:1.5}
    .onboarding-actions{position:sticky;bottom:-20px;display:grid;gap:10px;margin:0 -4px;padding:10px 4px 0;background:inherit}
    .onboarding-actions button{min-height:52px}
    .onboarding-help{width:auto!important;display:block;margin:16px auto 0;padding:10px 12px!important;background:transparent!important;
      color:#555!important;font-size:16px!important;font-weight:700;text-decoration:underline;min-height:44px}
    @media (max-height:700px){
      .onboarding-sheet{padding:18px 16px 16px}
      .onboarding-lead{margin-bottom:12px;font-size:16px}
      .onboarding-steps{gap:8px;margin-bottom:10px}
      .onboarding-steps li{padding:10px}
      .onboarding-step-body strong{font-size:17px}
      .onboarding-step-body span{font-size:15px}
      .onboarding-note{margin-bottom:10px}
      .onboarding-actions{bottom:-16px}
    }
    @media (prefers-color-scheme:dark){
      .onboarding-sheet{background:#181818;color:#fff}
      .onboarding-lead,.onboarding-step-body span{color:#bbb}
      .onboarding-steps li{background:#262626}
      .onboarding-step-number{background:#fff;color:#111}
      .onboarding-note,.onboarding-help{color:#aaa!important}
      .onboarding-close{background:#2d2d2d;color:#fff}
    }
  `;

  function injectStyle() {
    if (document.getElementById("onboardingStyle")) return;
    const style = document.createElement("style");
    style.id = "onboardingStyle";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  function shareToken() {
    if (typeof getShareToken === "function") return getShareToken();
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw) return null;
    const params = new URLSearchParams(raw);
    return params.has("token") ? params.get("token") : raw;
  }

  // ---- 家族（共有リンク・専用QR）向け ----
  function installGuestOnboarding() {
    if (/(^|\/)owner\.html$/i.test(window.location.pathname)) return;
    const main = document.querySelector("main");
    if (!main || document.getElementById("guestOnboarding")) return;
    injectStyle();

    const help = document.createElement("button");
    help.id = "guestOnboardingHelpBtn";
    help.type = "button";
    help.className = "onboarding-help";
    help.textContent = GUEST_COPY.help;
    main.appendChild(help);

    const overlay = document.createElement("div");
    overlay.id = "guestOnboarding";
    overlay.className = "onboarding-overlay hidden";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "guestOnboardingTitle");
    overlay.innerHTML = `
      <div class="onboarding-sheet">
        <button id="guestOnboardingClose" class="onboarding-close" type="button" aria-label="閉じる">×</button>
        <h2 id="guestOnboardingTitle">${escapeHtml(GUEST_COPY.title)}</h2>
        <p class="onboarding-lead">${escapeHtml(GUEST_COPY.lead)}</p>
        ${stepsHtml(GUEST_COPY.items)}
        <p class="onboarding-note">${escapeHtml(GUEST_COPY.note)}</p>
        <div class="onboarding-actions">
          <button id="guestOnboardingStart" type="button">${escapeHtml(GUEST_COPY.cta)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const start = overlay.querySelector("#guestOnboardingStart");
    const close = overlay.querySelector("#guestOnboardingClose");
    let previousOverflow = "";

    function open() {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      overlay.classList.remove("hidden");
      const sheet = overlay.querySelector(".onboarding-sheet");
      sheet.scrollTop = 0;
      // 見出しから読めるよう、フォーカスで下までスクロールさせない。
      setTimeout(() => start.focus({ preventScroll: true }), 0);
    }

    // 閉じたら、この端末・この共有先では次回から自動表示しない。
    // カメラには触れない（カメラはユーザーが「バーコードで確認する」を選んだ時だけ）。
    function finish({ showOwned }) {
      markGuestOnboardingSeen(localStorageOrNull(), shareToken());
      overlay.classList.add("hidden");
      document.body.style.overflow = previousOverflow;
      const scanView = document.getElementById("scanView");
      if (showOwned && scanView && !scanView.classList.contains("hidden") && typeof showOwnedView === "function") {
        showOwnedView();
      }
      if (showOwned) window.scrollTo({ top: 0 });
    }

    start.addEventListener("click", () => finish({ showOwned: true }));
    close.addEventListener("click", () => finish({ showOwned: false }));
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") finish({ showOwned: false });
    });
    help.addEventListener("click", open);

    window.KoreMotteruGuestOnboarding = { open, isOpen: () => !overlay.classList.contains("hidden") };

    const token = shareToken();
    if (token && !guestOnboardingSeen(localStorageOrNull(), token)) open();
  }

  function localStorageOrNull() {
    try { return window.localStorage; } catch (_) { return null; }
  }

  const api = {
    GUEST_KEY_PREFIX,
    OWNER_DONE_KEY,
    OWNER_LEGACY_DISMISSED_KEY,
    GUEST_COPY,
    OWNER_COPY,
    tokenFingerprint,
    guestStorageKey,
    guestOnboardingSeen,
    markGuestOnboardingSeen,
    ownerOnboardingDone,
    markOwnerOnboardingDone,
    stepsHtml,
    injectStyle: () => (typeof document !== "undefined" ? injectStyle() : undefined),
    localStorageOrNull: () => (typeof window !== "undefined" ? localStorageOrNull() : null),
  };

  if (typeof window !== "undefined") {
    window.KoreMotteruOnboarding = api;
    if (typeof document !== "undefined") {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", installGuestOnboarding, { once: true });
      } else {
        installGuestOnboarding();
      }
    }
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
