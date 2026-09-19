(() => {
  const isOwner = /(^|\/)owner\.html$/i.test(window.location.pathname);
  const SUPABASE_RPC_BASE = typeof SUPABASE_URL === "string" ? SUPABASE_URL : "";
  const SUPABASE_KEY = typeof SUPABASE_PUBLISHABLE_KEY === "string" ? SUPABASE_PUBLISHABLE_KEY : "";

  function tokenFromHash() {
    if (typeof getShareToken === "function") return getShareToken();
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw) return null;
    const params = new URLSearchParams(raw);
    return params.has("token") ? params.get("token") : raw;
  }

  function tokenFingerprint(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function guestLabelStorageKey() {
    return `kore-motteru-guest-label:${tokenFingerprint(tokenFromHash())}`;
  }

  function normalizeGuestLabel(value) {
    return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 40);
  }

  function getGuestLabel() {
    if (isOwner) return "";
    try {
      return normalizeGuestLabel(localStorage.getItem(guestLabelStorageKey()) || "");
    } catch (_) {
      return "";
    }
  }

  function saveGuestLabel(value) {
    const label = normalizeGuestLabel(value);
    if (!label) return "";
    try {
      localStorage.setItem(guestLabelStorageKey(), label);
    } catch (_) {}
    return label;
  }

  async function rpc(name, body) {
    const response = await fetch(`${SUPABASE_RPC_BASE}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
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

  function installGuestIdentityCard() {
    if (isOwner || document.getElementById("guestIdentityCard")) return;

    const main = document.querySelector("main");
    if (!main) return;

    const style = document.createElement("style");
    style.textContent = `
      .guest-identity-card {
        margin:0 0 16px;
        padding:14px;
        border:1px solid rgba(127,127,127,.24);
        border-radius:16px;
        background:rgba(127,127,127,.07);
      }
      .guest-identity-title { margin:0 0 5px; font-size:16px; font-weight:800; }
      .guest-identity-copy { margin:0 0 10px; color:#666; font-size:13px; line-height:1.5; }
      .guest-identity-row { display:flex; gap:8px; }
      .guest-identity-row input {
        min-width:0; flex:1; border:1px solid #ccc; border-radius:12px; padding:12px;
        font:inherit; background:#fff; color:#111;
      }
      .guest-identity-row button { width:auto; flex:0 0 auto; padding:11px 14px; font-size:15px; border-radius:12px; }
      .guest-presets { display:flex; flex-wrap:wrap; gap:7px; margin-top:9px; }
      .guest-presets button {
        width:auto; padding:8px 11px; border-radius:999px; font-size:13px;
        background:#ececec; color:#111;
      }
      .guest-identity-saved { margin-top:8px; min-height:18px; color:#137333; font-size:13px; font-weight:700; }
      @media (prefers-color-scheme: dark) {
        .guest-identity-copy { color:#aaa; }
        .guest-identity-row input { background:#202020; color:#fff; border-color:#555; }
        .guest-presets button { background:#2d2d2d; color:#fff; }
        .guest-identity-saved { color:#81c995; }
      }
    `;
    document.head.appendChild(style);

    const card = document.createElement("section");
    card.id = "guestIdentityCard";
    card.className = "guest-identity-card";
    card.innerHTML = `
      <p class="guest-identity-title">この家では、なんて呼ばれていますか？</p>
      <p class="guest-identity-copy">買った本や贈った本に「誰から」が残ります。この端末だけに呼ばれ方を覚えます。</p>
      <div class="guest-identity-row">
        <input id="guestIdentityInput" type="text" maxlength="40" autocomplete="nickname" placeholder="例：じいじ" aria-label="この家での呼ばれ方" />
        <button id="guestIdentitySave" type="button">保存</button>
      </div>
      <div class="guest-presets" aria-label="呼ばれ方の例">
        <button type="button" data-label="じいじ">じいじ</button>
        <button type="button" data-label="ばあば">ばあば</button>
        <button type="button" data-label="おじちゃん">おじちゃん</button>
        <button type="button" data-label="おばちゃん">おばちゃん</button>
      </div>
      <div id="guestIdentitySaved" class="guest-identity-saved" aria-live="polite"></div>
    `;

    main.insertBefore(card, main.firstChild);

    const input = card.querySelector("#guestIdentityInput");
    const saveButton = card.querySelector("#guestIdentitySave");
    const saved = card.querySelector("#guestIdentitySaved");

    const existing = getGuestLabel();
    if (existing) {
      input.value = existing;
      saved.textContent = `「${existing}」として記録します。`;
    }

    function commit(value) {
      const label = saveGuestLabel(value);
      if (!label) {
        saved.textContent = "呼ばれ方を入力してください。";
        input.focus();
        return "";
      }
      input.value = label;
      saved.textContent = `「${label}」として記録します。`;
      return label;
    }

    saveButton.addEventListener("click", () => commit(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit(input.value);
      }
    });
    card.querySelectorAll("[data-label]").forEach((button) => {
      button.addEventListener("click", () => commit(button.dataset.label || ""));
    });

    window.KoreMotteruGuestIdentity = {
      getLabel: getGuestLabel,
      requestLabel() {
        saved.textContent = "先に、あなたの呼ばれ方を登録してください。";
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => input.focus(), 250);
        return false;
      },
    };
  }

  function installGuestHandoffButton() {
    const panel = document.getElementById("purchasePanel");
    const again = document.getElementById("againBtn");
    if (!panel || document.getElementById("handoffBtn")) return;

    const button = document.createElement("button");
    button.id = "handoffBtn";
    button.type = "button";
    button.className = "secondary";
    button.textContent = "渡した";

    const hint = document.createElement("p");
    hint.className = "handoff-hint";
    hint.textContent = "相手が「受け取った」を押したときに、家の在庫へ反映されます。";
    hint.style.cssText = "margin:10px 4px 0;color:#666;font-size:13px;line-height:1.55;text-align:center;";

    panel.append(button, hint);

    button.addEventListener("click", async () => {
      const token = tokenFromHash();
      const barcode = typeof currentBarcode !== "undefined" ? currentBarcode : null;
      const qty = typeof quantity !== "undefined"
        ? Number(quantity)
        : Number(document.getElementById("qtyValue")?.textContent || 1);
      const label = getGuestLabel();

      if (!token || !barcode) return;
      if (!label) {
        window.KoreMotteruGuestIdentity?.requestLabel();
        if (typeof setBarcodeStatus === "function") {
          setBarcodeStatus(
            "呼ばれ方を登録してください",
            "「じいじ」など、この家で呼ばれている名前を先に登録してください。",
            barcode,
            "warn"
          );
        }
        return;
      }

      button.disabled = true;
      const previousText = button.textContent;
      button.textContent = "知らせています…";

      try {
        const result = await rpc("create_handoff_request", {
          p_token: token,
          p_barcode: String(barcode),
          p_buyer_key: typeof getOrCreateBuyerKey === "function" ? getOrCreateBuyerKey() : null,
          p_sender_label: label,
          p_quantity: Math.max(1, qty || 1),
        });

        if (!result || result.valid_token !== true) {
          if (typeof setBarcodeStatus === "function") {
            setBarcodeStatus("共有リンクが無効です", "新しい共有リンクを開いてください。", barcode, "error");
          }
          return;
        }

        if (result.valid_barcode === false || result.valid_quantity === false) {
          if (typeof setBarcodeStatus === "function") {
            setBarcodeStatus("知らせることができませんでした", "商品をもう一度確認してください。", barcode, "error");
          }
          return;
        }

        if (typeof setBarcodeStatus === "function") {
          setBarcodeStatus(
            "「渡した」を知らせました",
            `${label}から・数量 ${Math.max(1, qty || 1)}。相手が「受け取った」を押すと在庫に入ります。`,
            barcode,
            "ok"
          );
        }

        if (typeof hidePurchasePanel === "function") hidePurchasePanel();
        if (again) {
          again.textContent = "別の商品を確認する";
          again.classList.remove("hidden");
        }
      } catch (error) {
        console.error(error);
        if (typeof setBarcodeStatus === "function") {
          setBarcodeStatus("知らせることができませんでした", "通信状態を確認して、もう一度お試しください。", barcode, "error");
        }
      } finally {
        button.disabled = false;
        button.textContent = previousText;
      }
    });
  }

  function installOwnerInbox() {
    const main = document.querySelector("main");
    const registrationCard = main?.querySelector(".card");
    if (!main || !registrationCard || document.getElementById("handoffInbox")) return;

    const style = document.createElement("style");
    style.textContent = `
      #handoffInbox { margin-bottom:16px; }
      .handoff-title-row { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; }
      .handoff-title-row h2 { margin:0; font-size:21px; }
      .handoff-count { min-width:30px; padding:4px 9px; border-radius:999px; background:#fff4d8; text-align:center; font-weight:800; }
      .handoff-empty { margin:0; color:#666; line-height:1.55; }
      .handoff-list { display:grid; gap:10px; }
      .handoff-item { padding:14px; border-radius:14px; background:#f7f7f7; }
      .handoff-item-head { display:flex; gap:12px; align-items:center; margin-bottom:12px; }
      .handoff-cover { width:54px; height:74px; flex:0 0 54px; border-radius:8px; overflow:hidden; display:grid; place-items:center; background:#e9e9e9; font-size:25px; }
      .handoff-cover img { width:100%; height:100%; object-fit:cover; display:block; }
      .handoff-name { min-width:0; font-weight:800; line-height:1.4; overflow-wrap:anywhere; }
      .handoff-meta { margin-top:4px; color:#666; font-size:13px; line-height:1.45; }
      .handoff-result { margin-top:10px; color:#137333; font-weight:700; text-align:center; }
      @media (prefers-color-scheme: dark) {
        .handoff-empty,.handoff-meta,.handoff-hint { color:#aaa !important; }
        .handoff-item { background:#262626; }
        .handoff-cover { background:#303030; }
        .handoff-count { background:#443712; }
        .handoff-result { color:#81c995; }
      }
    `;
    document.head.appendChild(style);

    const inbox = document.createElement("section");
    inbox.id = "handoffInbox";
    inbox.className = "card";
    inbox.innerHTML = `
      <div class="handoff-title-row">
        <h2>受け取り待ち</h2>
        <span id="handoffCount" class="handoff-count">0</span>
      </div>
      <p id="handoffEmpty" class="handoff-empty">いま受け取り待ちはありません。</p>
      <div id="handoffList" class="handoff-list hidden"></div>
    `;

    main.insertBefore(inbox, registrationCard);

    const list = inbox.querySelector("#handoffList");
    const empty = inbox.querySelector("#handoffEmpty");
    const count = inbox.querySelector("#handoffCount");

    async function bookInfo(barcode) {
      if (!/^97[89]\d{10}$/.test(String(barcode))) {
        return { title: "商品", author: "", coverUrl: "" };
      }
      try {
        if (typeof fetchBookMetadata === "function") {
          const metadata = await fetchBookMetadata(String(barcode));
          return metadata || { title: "", author: "", coverUrl: "" };
        }
      } catch (error) {
        console.warn("handoff metadata unavailable", error);
      }
      return { title: "", author: "", coverUrl: "" };
    }

    async function accept(item, button, resultBox) {
      const token = tokenFromHash();
      if (!token) return;

      button.disabled = true;
      button.textContent = "反映しています…";

      try {
        const result = await rpc("accept_handoff_request", {
          p_token: token,
          p_handoff_id: item.id,
        });

        if (!result || result.valid_token !== true) {
          resultBox.textContent = "家主リンクを確認してください。";
          return;
        }

        if (result.accepted === true) {
          const from = result.giver_label ? `${result.giver_label}から・` : "";
          resultBox.textContent = `${from}在庫 ×${result.quantity_before ?? 0} → ×${result.quantity ?? 0}`;
          button.classList.add("hidden");
          setTimeout(loadPending, 700);
          return;
        }

        resultBox.textContent = result.status === "RECEIVED"
          ? "すでに受け取り済みです。"
          : "受け取り状態を確認できませんでした。";
      } catch (error) {
        console.error(error);
        resultBox.textContent = "通信状態を確認して、もう一度お試しください。";
      } finally {
        button.disabled = false;
        if (!button.classList.contains("hidden")) button.textContent = "受け取った";
      }
    }

    async function renderItem(item) {
      const metadata = await bookInfo(item.barcode);
      const article = document.createElement("article");
      article.className = "handoff-item";

      const head = document.createElement("div");
      head.className = "handoff-item-head";

      const cover = document.createElement("div");
      cover.className = "handoff-cover";
      if (metadata.coverUrl) {
        const img = document.createElement("img");
        img.src = metadata.coverUrl;
        img.alt = "";
        img.onerror = () => {
          cover.innerHTML = '<span aria-hidden="true">📚</span>';
        };
        cover.appendChild(img);
      } else {
        cover.innerHTML = '<span aria-hidden="true">📚</span>';
      }

      const body = document.createElement("div");
      const name = document.createElement("div");
      name.className = "handoff-name";
      name.textContent = metadata.title || "本を受け取り待ちです";

      const meta = document.createElement("div");
      meta.className = "handoff-meta";
      const giver = item.sender_label && item.sender_label !== "ゲスト" ? item.sender_label : "";
      const purchaser = item.purchaser_label && item.purchaser_label !== "ゲスト" ? item.purchaser_label : "";
      const people = giver && purchaser && giver !== purchaser
        ? `贈り主 ${giver}・購入者 ${purchaser}・`
        : (giver || purchaser ? `${giver || purchaser}から・` : "");
      meta.textContent = `${people}数量 ×${item.quantity} ・ ${item.barcode}`;

      body.append(name);
      if (metadata.author) {
        const author = document.createElement("div");
        author.className = "handoff-meta";
        author.textContent = metadata.author;
        body.appendChild(author);
      }
      body.appendChild(meta);
      head.append(cover, body);

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "受け取った";

      const resultBox = document.createElement("div");
      resultBox.className = "handoff-result";

      button.addEventListener("click", () => accept(item, button, resultBox));
      article.append(head, button, resultBox);
      return article;
    }

    async function loadPending() {
      const token = tokenFromHash();
      if (!token) {
        count.textContent = "!";
        empty.textContent = "家主専用URLを開いてください。";
        list.classList.add("hidden");
        return;
      }

      try {
        const result = await rpc("get_pending_handoffs", { p_token: token });
        if (!result || result.valid_token !== true) {
          count.textContent = "!";
          empty.textContent = "家主リンクを確認してください。";
          list.classList.add("hidden");
          return;
        }

        const items = Array.isArray(result.items) ? result.items : [];
        count.textContent = String(items.length);
        list.innerHTML = "";

        if (items.length === 0) {
          empty.textContent = "いま受け取り待ちはありません。";
          empty.classList.remove("hidden");
          list.classList.add("hidden");
          return;
        }

        empty.classList.add("hidden");
        list.classList.remove("hidden");
        const nodes = await Promise.all(items.map(renderItem));
        nodes.forEach((node) => list.appendChild(node));
      } catch (error) {
        console.error(error);
        count.textContent = "!";
        empty.textContent = "受け取り待ちを読み込めませんでした。";
        empty.classList.remove("hidden");
        list.classList.add("hidden");
      }
    }

    loadPending();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") loadPending();
    });
  }

  function install() {
    if (!SUPABASE_RPC_BASE || !SUPABASE_KEY) return;
    if (isOwner) {
      installOwnerInbox();
      return;
    }
    installGuestIdentityCard();
    installGuestHandoffButton();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
