(() => {
  const isOwner = /(^|\/)owner\.html$/i.test(window.location.pathname);
  if (!isOwner) return;

  const RPC_BASE = typeof SUPABASE_URL === "string" ? SUPABASE_URL : "";
  const RPC_KEY = typeof SUPABASE_PUBLISHABLE_KEY === "string" ? SUPABASE_PUBLISHABLE_KEY : "";

  function ownerToken() {
    if (typeof getShareToken === "function") return getShareToken();
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw) return "";
    const params = new URLSearchParams(raw);
    return params.get("token") || raw;
  }

  async function rpc(name, body) {
    const response = await fetch(`${RPC_BASE}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: RPC_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Supabase ${response.status}: ${detail}`);
    }
    return response.json();
  }

  function guestUrl(token) {
    const url = new URL("index.html", window.location.href);
    url.search = "";
    url.hash = new URLSearchParams({ token }).toString();
    return url.href;
  }

  function qrDataUrl(value) {
    if (typeof qrcode !== "function") throw new Error("QR generator unavailable");
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    return qr.createDataURL(6, 24);
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function install() {
    if (!RPC_BASE || !RPC_KEY || document.getElementById("guestInviteManager")) return;
    const main = document.querySelector("main");
    if (!main) return;

    const style = document.createElement("style");
    style.textContent = `
      .guest-manager {
        margin:0 0 16px; padding:16px; border:1px solid rgba(127,127,127,.25);
        border-radius:18px; background:rgba(127,127,127,.06);
      }
      .guest-manager h2 { margin:0; font-size:19px; }
      .guest-manager-copy { margin:6px 0 12px; font-size:13px; line-height:1.55; opacity:.72; }
      .guest-manager button { width:auto; }
      .guest-create-toggle { width:100% !important; padding:13px 16px; }
      .guest-create-form { margin-top:12px; padding-top:12px; border-top:1px solid rgba(127,127,127,.2); }
      .guest-create-form label { display:block; font-size:13px; font-weight:700; margin-bottom:6px; }
      .guest-create-row { display:flex; gap:8px; }
      .guest-create-row input {
        min-width:0; flex:1; border:1px solid #ccc; border-radius:12px; padding:12px;
        font:inherit; background:#fff; color:#111;
      }
      .guest-create-note { margin:7px 0 0; font-size:12px; line-height:1.5; opacity:.68; }
      .guest-list { display:grid; gap:9px; margin-top:14px; }
      .guest-person {
        display:flex; align-items:center; gap:8px; padding:11px 12px;
        border-radius:14px; background:rgba(127,127,127,.09);
      }
      .guest-person-name { min-width:0; flex:1; font-weight:800; }
      .guest-person-name small { display:block; margin-top:2px; font-size:11px; font-weight:500; opacity:.62; }
      .guest-person button { padding:8px 10px; font-size:13px; }
      .guest-empty { margin:12px 0 0; font-size:13px; opacity:.66; }
      .guest-qr-overlay {
        position:fixed; inset:0; z-index:10050; display:flex; align-items:center; justify-content:center;
        padding:20px; background:rgba(0,0,0,.72);
      }
      .guest-qr-sheet {
        width:min(420px,100%); max-height:90vh; overflow:auto; padding:20px;
        border-radius:22px; background:#fff; color:#111; text-align:center;
      }
      .guest-qr-sheet h2 { margin:0 0 5px; font-size:23px; }
      .guest-qr-sheet p { margin:5px 0 14px; font-size:13px; line-height:1.55; color:#555; }
      .guest-qr-image { display:block; width:min(310px,90%); height:auto; margin:8px auto 16px; image-rendering:pixelated; }
      .guest-qr-actions { display:grid; gap:9px; }
      .guest-qr-actions button { width:100%; padding:13px 16px; }
      .guest-qr-status { min-height:18px; margin-top:8px; font-size:12px; color:#137333; }
      @media (prefers-color-scheme: dark) {
        .guest-create-row input { background:#202020; color:#fff; border-color:#555; }
        .guest-qr-sheet { background:#181818; color:#fff; }
        .guest-qr-sheet p { color:#bbb; }
        .guest-qr-status { color:#81c995; }
      }
    `;
    document.head.appendChild(style);

    const section = document.createElement("section");
    section.id = "guestInviteManager";
    section.className = "guest-manager";
    section.innerHTML = `
      <h2>登録している人</h2>
      <p class="guest-manager-copy">じいじ・ばあばなど、人ごとの専用QRを作れます。QRから入れば呼び名をこの家から復元します。</p>
      <button id="guestCreateToggle" class="secondary guest-create-toggle" type="button">＋ 新しい人を登録</button>
      <div id="guestCreateForm" class="guest-create-form hidden">
        <label for="guestCreateLabel">この家での呼び名</label>
        <div class="guest-create-row">
          <input id="guestCreateLabel" type="text" maxlength="40" placeholder="例：じいじ（空欄でもOK）" />
          <button id="guestCreateButton" type="button">QRを作る</button>
        </div>
        <p class="guest-create-note">空欄なら、QRを読んだ本人が最初の1回だけ呼び名を登録します。</p>
      </div>
      <div id="guestInviteList" class="guest-list"></div>
      <p id="guestInviteEmpty" class="guest-empty">まだ登録している人はいません。</p>
    `;

    main.prepend(section);

    const overlay = document.createElement("div");
    overlay.id = "guestQrOverlay";
    overlay.className = "guest-qr-overlay hidden";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
      <div class="guest-qr-sheet">
        <h2 id="guestQrTitle">専用QR</h2>
        <p id="guestQrCopy">このQRを相手のスマホで読み取ってください。スクショして送っても使えます。</p>
        <img id="guestQrImage" class="guest-qr-image" alt="ゲスト専用QRコード" />
        <div class="guest-qr-actions">
          <button id="guestQrShare" type="button">リンクを共有</button>
          <button id="guestQrCopyLink" class="secondary" type="button">リンクをコピー</button>
          <button id="guestQrClose" class="secondary" type="button">閉じる</button>
        </div>
        <div id="guestQrStatus" class="guest-qr-status" aria-live="polite"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const toggle = section.querySelector("#guestCreateToggle");
    const form = section.querySelector("#guestCreateForm");
    const labelInput = section.querySelector("#guestCreateLabel");
    const createButton = section.querySelector("#guestCreateButton");
    const list = section.querySelector("#guestInviteList");
    const empty = section.querySelector("#guestInviteEmpty");
    const qrTitle = overlay.querySelector("#guestQrTitle");
    const qrCopy = overlay.querySelector("#guestQrCopy");
    const qrImage = overlay.querySelector("#guestQrImage");
    const qrShare = overlay.querySelector("#guestQrShare");
    const qrCopyLink = overlay.querySelector("#guestQrCopyLink");
    const qrClose = overlay.querySelector("#guestQrClose");
    const qrStatus = overlay.querySelector("#guestQrStatus");

    let currentLink = "";
    let currentShareTitle = "";

    function showQr(item) {
      currentLink = guestUrl(item.guest_token);
      const name = item.label || "呼び名未登録";
      currentShareTitle = `${name} 専用リンク`;
      qrTitle.textContent = item.label ? `${item.label} 専用QR` : "新しい人の登録QR";
      qrCopy.textContent = item.label
        ? "このQRを相手のスマホで読み取ってください。スクショして送っても、同じ呼び名で入れます。"
        : "対面でこのQRを読み取ってもらってください。最初の1回だけ、本人に呼び名を入力してもらいます。";
      qrImage.src = qrDataUrl(currentLink);
      qrStatus.textContent = "";
      overlay.classList.remove("hidden");
    }

    function closeQr() {
      overlay.classList.add("hidden");
      currentLink = "";
      qrImage.removeAttribute("src");
    }

    async function loadGuests() {
      const token = ownerToken();
      if (!token) return;
      try {
        const result = await rpc("list_owner_guest_invites", { p_token: token });
        if (!result || result.valid_token !== true) return;
        const items = Array.isArray(result.items) ? result.items : [];
        list.innerHTML = "";
        empty.classList.toggle("hidden", items.length > 0);

        items.forEach((item) => {
          const row = document.createElement("div");
          row.className = "guest-person";

          const name = document.createElement("div");
          name.className = "guest-person-name";
          name.textContent = item.label || "呼び名未登録";
          const sub = document.createElement("small");
          sub.textContent = item.label ? "専用QRあり" : "本人の初回入力待ち";
          name.appendChild(sub);

          const qrButton = document.createElement("button");
          qrButton.type = "button";
          qrButton.className = "secondary";
          qrButton.textContent = "QR";
          qrButton.addEventListener("click", () => showQr(item));

          const moreButton = document.createElement("button");
          moreButton.type = "button";
          moreButton.className = "secondary";
          moreButton.textContent = "⋯";
          moreButton.setAttribute("aria-label", `${item.label || "登録者"}の設定`);
          moreButton.addEventListener("click", async () => {
            const action = window.prompt("「名前変更」または「無効」を入力してください。", "名前変更");
            if (action === "名前変更") {
              const next = window.prompt("この家での呼び名", item.label || "");
              if (!next?.trim()) return;
              await rpc("rename_owner_guest", {
                p_token: ownerToken(),
                p_guest_id: item.guest_id,
                p_label: next.trim(),
              });
              await loadGuests();
            } else if (action === "無効") {
              if (!window.confirm(`${item.label || "この登録者"}の専用QRを使えなくしますか？`)) return;
              await rpc("revoke_owner_guest", {
                p_token: ownerToken(),
                p_guest_id: item.guest_id,
              });
              await loadGuests();
            }
          });

          row.append(name, qrButton, moreButton);
          list.appendChild(row);
        });
      } catch (error) {
        console.error(error);
        empty.textContent = "登録している人を読み込めませんでした。";
        empty.classList.remove("hidden");
      }
    }

    toggle.addEventListener("click", () => {
      form.classList.toggle("hidden");
      if (!form.classList.contains("hidden")) setTimeout(() => labelInput.focus(), 50);
    });

    createButton.addEventListener("click", async () => {
      const token = ownerToken();
      if (!token) return;
      createButton.disabled = true;
      const previous = createButton.textContent;
      createButton.textContent = "作成中…";
      try {
        const result = await rpc("create_owner_guest_invite", {
          p_token: token,
          p_label: labelInput.value.trim() || null,
        });
        if (!result || result.valid_token !== true || !result.guest_token) {
          throw new Error("invite creation failed");
        }
        labelInput.value = "";
        form.classList.add("hidden");
        showQr(result);
        await loadGuests();
      } catch (error) {
        console.error(error);
        window.alert("専用QRを作れませんでした。通信状態を確認してください。");
      } finally {
        createButton.disabled = false;
        createButton.textContent = previous;
      }
    });

    qrShare.addEventListener("click", async () => {
      if (!currentLink) return;
      try {
        if (navigator.share) {
          await navigator.share({
            title: currentShareTitle,
            text: "このリンクから開いてください。",
            url: currentLink,
          });
        } else {
          await copyText(currentLink);
          qrStatus.textContent = "リンクをコピーしました。";
        }
      } catch (error) {
        if (error?.name !== "AbortError") {
          console.error(error);
          qrStatus.textContent = "共有できませんでした。";
        }
      }
    });

    qrCopyLink.addEventListener("click", async () => {
      if (!currentLink) return;
      try {
        await copyText(currentLink);
        qrStatus.textContent = "リンクをコピーしました。";
      } catch (error) {
        console.error(error);
        qrStatus.textContent = "コピーできませんでした。";
      }
    });

    qrClose.addEventListener("click", closeQr);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeQr();
    });

    loadGuests();
    document.addEventListener("kore-motteru:guest-invites-updated", loadGuests);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
