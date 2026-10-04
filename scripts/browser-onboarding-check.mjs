// ローカル専用: Issue #42（初回案内）の画面フローを Playwright で確認する。
// Supabase RPC・書誌API・カメラ（html5-qrcode）はこのスクリプト内の模擬で置き換える。本番へは接続しない。
//
// 実行例:
//   PLAYWRIGHT_MODULE=$(npm root -g)/playwright node scripts/browser-onboarding-check.mjs
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || "";
const GUEST_TOKEN = "kmtg_onboarding_jiji";
const OTHER_GUEST_TOKEN = "kmtg_onboarding_baba";
const OWNER_TOKEN = "local_owner";
const ISBN_A = "9784834000825";

const VIEWPORTS = [
  { name: "iPhone SE", width: 320, height: 568 },
  { name: "iPhone", width: 390, height: 844 },
  { name: "Android", width: 412, height: 915 },
];

const rpcHandlers = {
  get_guest_identity: (b) => (b.p_token === GUEST_TOKEN
    ? { valid_token: true, managed_guest: true, guest_key: "guest:jiji", label: "じいじ" }
    : { valid_token: true, managed_guest: true, guest_key: "guest:baba", label: "ばあば" }),
  get_household_owned_items: () => ({ valid_token: true, items: [{ barcode: ISBN_A, quantity: 1, origins: [] }] }),
  get_my_pending_handoffs: () => ({ valid_token: true, items: [] }),
  get_guest_product_state: () => ({ valid_token: true, owned_quantity: 1, planned_quantity: 0, my_pending_handoffs: [], duplicate: true }),
  get_owner_household_settings: () => ({ valid_token: true, provenance_visibility_chosen: true, show_item_provenance: false }),
  list_owner_guest_invites: () => ({ valid_token: true, items: [] }),
  get_pending_handoffs: () => ({ valid_token: true, items: [] }),
};

// 模擬カメラ: start が呼ばれた回数を数える（＝カメラ権限を求めた回数）。
const FAKE_HTML5_QRCODE = `
window.Html5QrcodeSupportedFormats = { EAN_13: 9, EAN_8: 10 };
window.__cameraStarts = 0;
window.Html5Qrcode = class {
  async start() { window.__cameraStarts += 1; }
  async stop() {}
};`;

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://local").pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8" });
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, resolve));
const BASE = `http://localhost:${server.address().port}`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

async function newContext(options = {}) {
  const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 390, height: 844 }, ...options });
  // カメラ権限の要求も数える（実機の html5-qrcode は getUserMedia を呼ぶ）。
  await context.addInitScript(() => {
    window.__getUserMediaCalls = 0;
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = async () => {
        window.__getUserMediaCalls += 1;
        throw new Error("camera blocked in test");
      };
    }
  });
  return context;
}

async function openPage(context, url) {
  const page = await context.newPage();
  page.on("pageerror", (error) => { throw error; });
  await page.route(/unpkg\.com/, (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_HTML5_QRCODE }));
  await page.route(/jsdelivr\.net/, (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route(/openlibrary|googleapis|openbd|hanmoto|book-cover-proxy/, (route) => route.fulfill({ status: 404, body: "" }));
  await page.route(/supabase\.co\/rest\/v1\/rpc\/(\w+)/, (route) => {
    const name = route.request().url().split("/rpc/")[1];
    const body = JSON.parse(route.request().postData() || "{}");
    const handler = rpcHandlers[name];
    route.fulfill({ contentType: "application/json", body: JSON.stringify(handler ? handler(body) : { valid_token: true }) });
  });
  await page.goto(url);
  return page;
}

const guestUrl = (token) => `${BASE}/index.html#token=${token}`;
const ownerUrl = `${BASE}/owner.html#token=${OWNER_TOKEN}`;
const cameraRequests = (page) => page.evaluate(() => (window.__cameraStarts || 0) + (window.__getUserMediaCalls || 0));
const visible = (page, selector) => page.isVisible(selector);

async function stillHiddenAfter(page, selector, ms = 1200) {
  await page.waitForTimeout(ms);
  return !(await page.isVisible(selector));
}

// 横はみ出し・ボタン切れが無いこと。
async function assertFits(page, sheetSelector, label) {
  const result = await page.evaluate((selector) => {
    const sheet = document.querySelector(selector);
    const width = document.documentElement.clientWidth;
    const sheetRect = sheet.getBoundingClientRect();
    const buttons = [...sheet.querySelectorAll("button")].map((button) => {
      const rect = button.getBoundingClientRect();
      return { text: button.textContent.trim(), left: rect.left, right: rect.right, height: rect.height, width: rect.width,
        overflow: button.scrollWidth > button.clientWidth + 1 };
    });
    const title = sheet.querySelector("h2");
    const titleLines = Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight));
    return {
      width,
      titleLines,
      titleTop: title.getBoundingClientRect().top,
      height: window.innerHeight,
      primaryBottom: sheet.querySelector("#guestOnboardingStart, [data-tutorial-primary]").getBoundingClientRect().bottom,
      pageScrollWidth: document.documentElement.scrollWidth,
      sheetScrollWidth: sheet.scrollWidth,
      sheetClientWidth: sheet.clientWidth,
      sheetLeft: sheetRect.left,
      sheetRight: sheetRect.right,
      buttons,
    };
  }, sheetSelector);
  assert.ok(result.pageScrollWidth <= result.width, `${label}: ページの横はみ出しなし (${result.pageScrollWidth} > ${result.width})`);
  assert.ok(result.titleLines <= 1, `${label}: 見出しが途中で折り返さない（${result.titleLines}行）`);
  assert.ok(result.titleTop >= 0, `${label}: 開いた時に見出しが見えている`);
  assert.ok(result.primaryBottom <= result.height, `${label}: 最初の行動ボタンがスクロールせずに見えている`);
  assert.ok(result.sheetScrollWidth <= result.sheetClientWidth + 1, `${label}: 案内の中身の横はみ出しなし`);
  assert.ok(result.sheetLeft >= 0 && result.sheetRight <= result.width, `${label}: 案内が画面内`);
  for (const button of result.buttons) {
    assert.ok(button.left >= 0 && button.right <= result.width, `${label}: ボタン「${button.text}」が画面内`);
    assert.ok(button.height >= 44 && button.width >= 44, `${label}: ボタン「${button.text}」を押しやすい大きさ`);
    assert.equal(button.overflow, false, `${label}: ボタン「${button.text}」の文字が切れない`);
  }
}

async function shot(page, name) {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: false });
}

const log = (message) => console.log(`ok - ${message}`);

try {
  // ===== 家族（共有リンク・専用QR）=====
  const guestContext = await newContext();
  let guest = await openPage(guestContext, guestUrl(GUEST_TOKEN));

  // 1. 初回は案内が出る（文言は Issue #42 の文案）
  await guest.waitForSelector("#guestOnboarding:not(.hidden)");
  const guestText = await guest.innerText("#guestOnboarding");
  for (const expected of [
    "このページでできること",
    "この家に登録されている本を見たり、買う前に同じ本がないか確認できます。",
    "家にある本を見る", "登録されている本を表紙で確認できます。",
    "買う前に確認する", "本のうらをカメラに見せると、すでに持っているか確認できます。",
    "渡した本を記録する", "「渡した」を記録すると、家主が受け取った時に家の本へ反映されます。",
    "インストールは不要です。この専用QR・リンクから開けます。",
    "持ってるものを見る",
  ]) assert.ok(guestText.includes(expected), `案内に「${expected}」`);
  assert.equal(await guest.evaluate(() => document.activeElement?.id), "guestOnboardingStart", "最初の行動ボタンにフォーカス");
  await shot(guest, "guest-onboarding");
  log("家族: 初回は「このページでできること」が出る");

  // 7. 案内を開いただけではカメラ権限を求めない
  assert.equal(await cameraRequests(guest), 0);
  log("家族: 案内を開いただけではカメラ権限を求めない");

  // 2. CTA で通常の「持ってるもの」へ
  await guest.click("#guestOnboardingStart");
  await guest.waitForSelector("#guestOnboarding.hidden", { state: "attached" });
  assert.equal(await visible(guest, "#ownedView"), true);
  await guest.waitForSelector("#ownedList .owned-item");
  assert.equal(await visible(guest, "#scanNavBtn"), true, "主要ボタンがすぐ見える");
  log("家族: 「持ってるものを見る」で通常の画面へ");

  // 6. 専用QRの呼び名表示を壊さない
  await guest.waitForFunction(() => document.getElementById("guestIdentityTitle")?.textContent.includes("じいじ"));
  assert.equal(await guest.isDisabled("#guestIdentityInput"), true);
  log("家族: 専用QRの呼び名（じいじ）の表示はそのまま");

  // 3. 同じ共有先を再読み込み → 自動では出ない（無限表示しない）
  await guest.reload();
  await guest.waitForSelector("#ownedList .owned-item");
  assert.ok(await stillHiddenAfter(guest, "#guestOnboarding:not(.hidden)"));
  await guest.goBack().catch(() => {});
  await guest.goto(guestUrl(GUEST_TOKEN));
  assert.ok(await stillHiddenAfter(guest, "#guestOnboarding:not(.hidden)"), "戻る・開き直しでも出ない");
  log("家族: 同じ共有先は再読み込み・開き直しで自動表示しない");

  // 4. 「使い方を見る」でいつでも再表示（バーコード確認の画面からも）
  await guest.click("#guestOnboardingHelpBtn");
  await guest.waitForSelector("#guestOnboarding:not(.hidden)");
  await guest.click("#guestOnboardingClose");
  await guest.waitForSelector("#guestOnboarding.hidden", { state: "attached" });
  await guest.click("#scanNavBtn");
  await guest.click("#guestOnboardingHelpBtn");
  await guest.waitForSelector("#guestOnboarding:not(.hidden)");
  await guest.click("#guestOnboardingStart");
  await guest.waitForFunction(() => !document.getElementById("ownedView").classList.contains("hidden"));
  assert.equal(await cameraRequests(guest), 0, "再表示でもカメラ権限を求めない");
  log("家族: 「使い方を見る」から何度でも再表示でき、閉じると持ってるものへ戻る");

  // カメラはユーザーが選んだ時だけ（従来どおり）
  await guest.click("#scanNavBtn");
  await guest.click("#startBtn");
  await guest.waitForFunction(() => window.__cameraStarts === 1);
  log("家族: カメラは「バーコードを確認する」を押した時だけ起動");

  // 5. 別の共有先では初回として出る
  const other = await openPage(guestContext, guestUrl(OTHER_GUEST_TOKEN));
  await other.waitForSelector("#guestOnboarding:not(.hidden)");
  await other.click("#guestOnboardingStart");
  await other.waitForFunction(() => document.getElementById("guestIdentityTitle")?.textContent.includes("ばあば"));
  const storedKeys = await other.evaluate(() => Object.keys(localStorage).filter((key) => key.includes("onboarding")));
  assert.equal(storedKeys.length, 2, "共有先ごとに1つずつ");
  assert.ok(storedKeys.every((key) => !key.includes(GUEST_TOKEN) && !key.includes(OTHER_GUEST_TOKEN)), "トークンそのものは保存しない");
  log("家族: 別の共有先では初回案内が出る（トークンそのものは保存しない）");
  await guestContext.close();

  // ===== 家主 =====
  const ownerContext = await newContext();
  let owner = await openPage(ownerContext, ownerUrl);

  // 8. 初回は案内が出る
  await owner.waitForSelector("#tutorialOverlay:not(.hidden) #tutorialV2Next");
  const ownerText = await owner.innerText("#tutorialOverlay");
  for (const expected of [
    "このページでできること",
    "家の本を登録する", "「カメラで登録する」から、本のうらを見せるだけ。",
    "家族に専用QRを渡す", "じいじ・ばあばなど、その人専用のQR/リンクから家の本を確認できます。",
    "受け取った本を確認する", "家族が「渡した」と記録した本は「受け取り待ち」に出ます。実際に受け取ったら確認します。",
  ]) assert.ok(ownerText.includes(expected), `家主の案内に「${expected}」`);
  assert.equal(await owner.isVisible("#tutorialV2DontShow"), false, "「次回から表示しない」は不要");
  assert.equal(await cameraRequests(owner), 0, "案内を開いただけではカメラ権限を求めない");
  await shot(owner, "owner-onboarding-overview");
  log("家主: 初回は「できること3つ」が出る（カメラは起動しない）");

  // 12. 既存の二段バーコードの説明が残る
  await owner.click("#tutorialV2Next");
  await owner.waitForSelector("#tutorialV2Start");
  const howTo = await owner.innerText("#tutorialOverlay");
  assert.ok(howTo.includes("バーコードが2つあっても、そのままで大丈夫です。"));
  assert.deepEqual(await owner.$$eval("#tutorialOverlay .demo-number", (nodes) => nodes.map((node) => node.textContent)),
    ["9784088741710", "1929979011430"]);
  assert.ok(howTo.includes("本を登録してみる"));
  await shot(owner, "owner-onboarding-howto");
  log("家主: 2画面目に既存の二段バーコードのデモと「そのままで大丈夫です」が残る");

  // 9. CTA でカメラ登録へ進む
  await owner.click("#tutorialV2Start");
  await owner.waitForSelector("#tutorialOverlay.hidden", { state: "attached" });
  await owner.waitForFunction(() => window.__cameraStarts === 1);
  assert.equal(await owner.$eval("#reader", (node) => node.classList.contains("hidden")), false, "カメラの読み取り枠が開く");
  log("家主: 「本を登録してみる」でカメラ登録へ進む");

  // 10. 再読み込みでは自動表示しない
  await owner.reload();
  assert.ok(await stillHiddenAfter(owner, "#tutorialOverlay:not(.hidden)"));
  assert.equal(await cameraRequests(owner), 0);
  log("家主: 再読み込みでは自動表示しない");

  // 11. 「使い方を見る」でいつでも再表示
  await owner.click("#tutorialHelpBtn");
  await owner.waitForSelector("#tutorialOverlay:not(.hidden) #tutorialV2Next");
  await owner.click("#tutorialV2Next");
  await owner.click("#tutorialV2Back");
  await owner.waitForSelector("#tutorialV2Next");
  await owner.click("#tutorialV2Close");
  await owner.waitForSelector("#tutorialOverlay.hidden", { state: "attached" });
  assert.equal(await cameraRequests(owner), 0, "閉じただけではカメラを起動しない");
  log("家主: 「使い方を見る」から何度でも再表示でき、もどる・閉じるも使える");
  await ownerContext.close();

  // ×で閉じた場合も、次回から自動表示しない（使い方はいつでも見られる）
  const closedContext = await newContext();
  owner = await openPage(closedContext, ownerUrl);
  await owner.waitForSelector("#tutorialOverlay:not(.hidden) #tutorialV2Next");
  await owner.click("#tutorialV2Close");
  await owner.reload();
  assert.ok(await stillHiddenAfter(owner, "#tutorialOverlay:not(.hidden)"));
  await closedContext.close();
  log("家主: ×で閉じた場合も次回から自動表示しない");

  // 以前「次回から表示しない」を選んだ端末は、新しい案内も自動表示しない
  const legacyContext = await newContext();
  await legacyContext.addInitScript(() => localStorage.setItem("kore-motteru-owner-tutorial-dismissed-v1", "1"));
  owner = await openPage(legacyContext, ownerUrl);
  assert.ok(await stillHiddenAfter(owner, "#tutorialOverlay:not(.hidden)"));
  await legacyContext.close();
  log("家主: 以前「次回から表示しない」を選んだ端末では自動表示しない");

  // 13. iPhone / Android 幅で横はみ出し・ボタン切れが無い（ダークモード・動きを減らす設定も）
  for (const viewport of VIEWPORTS) {
    for (const colorScheme of ["light", "dark"]) {
      const context = await newContext({ viewport, colorScheme, reducedMotion: "reduce" });
      const guestPage = await openPage(context, guestUrl(GUEST_TOKEN));
      await guestPage.waitForSelector("#guestOnboarding:not(.hidden)");
      await assertFits(guestPage, "#guestOnboarding .onboarding-sheet", `${viewport.name}/${colorScheme} 家族`);

      const ownerPage = await openPage(context, ownerUrl);
      await ownerPage.waitForSelector("#tutorialOverlay:not(.hidden) #tutorialV2Next");
      await assertFits(ownerPage, "#tutorialOverlay .tutorial-v2-sheet", `${viewport.name}/${colorScheme} 家主1画面目`);
      await ownerPage.click("#tutorialV2Next");
      await ownerPage.waitForSelector("#tutorialV2Start");
      await assertFits(ownerPage, "#tutorialOverlay .tutorial-v2-sheet", `${viewport.name}/${colorScheme} 家主2画面目`);
      const scanAnimation = await ownerPage.$eval("#tutorialOverlay .demo-scan", (node) => getComputedStyle(node).animationName);
      assert.equal(scanAnimation, "none", "動きを減らす設定ではアニメーションしない");

      if (colorScheme === "dark") {
        const colors = await guestPage.$eval("#guestOnboarding .onboarding-sheet", (sheet) => ({
          background: getComputedStyle(sheet).backgroundColor,
          text: getComputedStyle(sheet.querySelector("h2")).color,
          step: getComputedStyle(sheet.querySelector(".onboarding-step-body span")).color,
        }));
        assert.equal(colors.background, "rgb(24, 24, 24)");
        assert.equal(colors.text, "rgb(255, 255, 255)");
        assert.notEqual(colors.step, "rgb(68, 68, 68)", "ダークモードで説明文が暗すぎない");
        const ownerColors = await ownerPage.$eval("#tutorialOverlay .tutorial-v2-sheet", (sheet) => ({
          background: getComputedStyle(sheet).backgroundColor,
          text: getComputedStyle(sheet.querySelector("h2")).color,
        }));
        assert.equal(ownerColors.background, "rgb(24, 24, 24)");
        assert.equal(ownerColors.text, "rgb(255, 255, 255)");
        if (viewport.name === "iPhone") {
          await shot(guestPage, "guest-onboarding-dark");
          await shot(ownerPage, "owner-onboarding-howto-dark");
        }
      }
      if (viewport.name === "iPhone SE" && colorScheme === "light") await shot(guestPage, "guest-onboarding-se");
      await context.close();
    }
  }
  log("iPhone SE / iPhone / Android 幅で横はみ出し・ボタン切れなし（ライト・ダーク、動きを減らす設定）");
} finally {
  await browser.close();
  server.close();
}
