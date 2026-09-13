(() => {
  function detectMode() {
    const path = window.location.pathname.toLowerCase();
    return path.endsWith("/owner.html") || path.endsWith("owner.html")
      ? "owner"
      : "guest";
  }

  function installRoleUi() {
    if (document.getElementById("role-mode-banner")) return;

    const main = document.querySelector("main");
    if (!main) return;

    const mode = detectMode();
    const banner = document.createElement("div");
    banner.id = "role-mode-banner";
    banner.setAttribute("aria-label", mode === "owner" ? "オーナーモード" : "ゲストモード");
    banner.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:10px",
      "margin:0 0 14px",
      "padding:10px 12px",
      "border:1px solid rgba(127,127,127,.28)",
      "border-radius:14px",
      "background:rgba(127,127,127,.08)",
      "line-height:1.35"
    ].join(";");

    const label = document.createElement("strong");
    label.textContent = mode === "owner" ? "オーナーモード" : "ゲストモード";
    label.style.cssText = "flex:0 0 auto;font-size:14px;white-space:nowrap";

    const description = document.createElement("span");
    description.textContent = mode === "owner"
      ? "家にあるものを登録・追加します。"
      : "家にあるものを見たり、買う前に確認できます。";
    description.style.cssText = "font-size:13px;opacity:.72";

    banner.append(label, description);
    main.prepend(banner);

    if (mode === "guest") {
      const ownedLead = document.querySelector("#ownedView .sub");
      if (ownedLead) {
        ownedLead.textContent = "家にあるものを見たり、買う前に重複を確認できます。";
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installRoleUi, { once: true });
  } else {
    installRoleUi();
  }
})();
