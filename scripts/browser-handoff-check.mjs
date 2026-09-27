// ローカル専用: 受け渡しイベント（Issue #38）の画面フローを Playwright で確認する。
// Supabase RPC と書誌APIはこのスクリプト内の模擬サーバーで置き換える。本番へは接続しない。
//
// 実行例:
//   PLAYWRIGHT_MODULE=$(npm root -g)/playwright node scripts/browser-handoff-check.mjs
// 画面キャプチャを残す場合は SCREENSHOT_DIR=/path/to/dir を指定する。
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
const ISBN_A = "9784834000825";
const GUEST_TOKEN = "kmtg_local_guest";
const OWNER_TOKEN = "local_owner";
const GUEST_KEY = "guest:local-jiji";
const OTHER_GUEST_TOKEN = "kmtg_local_other";
const OTHER_GUEST_KEY = "guest:local-baba";
const LEGACY_SHOP_TOKEN = "legacy_shared_link";

// ---- 模擬バックエンド（ページ再読込・別端末をまたいで状態を保持する） ----
const db = {
  clock: Date.parse("2026-09-27T04:20:00Z"), // 日本時間 13:20
  nextId: 1,
  handoffs: [],
  items: new Map(),
  plans: [],
  createCalls: 0,
  // true の間は get_guest_product_state が無いDB（018未適用）として 404 を返す。
  withoutGuestProductState: false,
};

function tick() {
  const at = new Date(db.clock).toISOString();
  db.clock += 15 * 60 * 1000;
  return at;
}

const NOT_FOUND = Symbol("not found");

// 018 と同じく、専用QRのトークンでは本人をトークンから決め、クライアントの p_buyer_key を使わない。
function effectiveKey(token, clientKey) {
  if (token === GUEST_TOKEN) return GUEST_KEY;
  if (token === OTHER_GUEST_TOKEN) return OTHER_GUEST_KEY;
  const key = String(clientKey || "").trim();
  return key && !key.startsWith("guest:") ? key : null;
}
const spoofAttempts = [];
function noteKey(b) {
  const key = effectiveKey(b.p_token, b.p_buyer_key);
  if (b.p_buyer_key && b.p_buyer_key !== key) spoofAttempts.push(b.p_buyer_key);
  return key;
}

function productState(barcode) {
  const owned = db.items.get(barcode) || 0;
  const planned = db.plans.filter((p) => p.barcode === barcode).reduce((sum, p) => sum + p.quantity, 0);
  return { valid_token: true, owned_quantity: owned, planned_quantity: planned, duplicate: owned + planned > 0 };
}

function pendingFor(key) {
  return db.handoffs
    .filter((h) => h.sender_key === key && h.status === "PENDING")
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
    .map(({ id, barcode, quantity, sender_label, status, created_at }) =>
      ({ id, barcode, quantity, sender_label, purchaser_label: sender_label, status, created_at }));
}

const rpcHandlers = {
  get_guest_identity: (b) => (b.p_token === LEGACY_SHOP_TOKEN
    ? { valid_token: true, managed_guest: false }
    : b.p_token === OTHER_GUEST_TOKEN
    ? { valid_token: true, managed_guest: true, guest_key: OTHER_GUEST_KEY, label: "ばあば" }
    : { valid_token: true, managed_guest: true, guest_key: GUEST_KEY, label: "じいじ" }),
  get_household_owned_items: () => ({
    valid_token: true,
    items: [...db.items.entries()].map(([barcode, quantity]) => ({ barcode, quantity, origins: [] })),
  }),
  get_household_product_state: (b) => productState(b.p_barcode),
  // 018: 在庫・購入予定・本人の受け取り待ち（他のゲストの分は返さない）
  get_guest_product_state: (b) => {
    if (db.withoutGuestProductState) return NOT_FOUND;
    const state = productState(b.p_barcode);
    const mine = pendingFor(noteKey(b))
      .filter((h) => h.barcode === b.p_barcode)
      .sort((a, c) => a.created_at.localeCompare(c.created_at))
      .map(({ id, barcode, quantity, status, created_at }) => ({ id, barcode, quantity, status, created_at }));
    return { ...state, my_pending_handoffs: mine, duplicate: state.duplicate || mine.length > 0 };
  },
  add_purchase_plan: (b) => {
    const key = noteKey(b);
    if (!key) return { valid_token: true, valid_buyer: false }; // 018: 本人が決まらなければ何も作らない
    db.plans.push({ barcode: b.p_barcode, quantity: b.p_quantity, buyer_key: key });
    return { valid_token: true, planned_quantity_after: productState(b.p_barcode).planned_quantity };
  },
  get_my_pending_handoffs: (b) => ({ valid_token: true, items: pendingFor(noteKey(b)) }),
  create_handoff_request: (b) => {
    const key = noteKey(b);
    if (!key) return { valid_token: true, valid_barcode: true, valid_quantity: true, valid_buyer: false };
    db.createCalls += 1;
    const event = {
      id: db.nextId++, barcode: b.p_barcode, quantity: b.p_quantity, sender_key: key,
      sender_label: b.p_sender_label, status: "PENDING", created_at: tick(), received_at: null, cancelled_at: null,
    };
    db.handoffs.push(event);
    return { valid_token: true, valid_barcode: true, valid_quantity: true, handoff_id: event.id, status: "PENDING" };
  },
  cancel_my_handoff_request: (b) => {
    const event = db.handoffs.find((h) => h.id === b.p_handoff_id && h.sender_key === noteKey(b));
    if (!event || event.status !== "PENDING") return { valid_token: true, cancelled: false, status: event?.status };
    event.status = "CANCELLED";
    event.cancelled_at = tick();
    return { valid_token: true, cancelled: true, status: "CANCELLED" };
  },
  get_pending_handoffs: () => ({
    valid_token: true,
    items: db.handoffs.filter((h) => h.status === "PENDING")
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((h) => ({ ...h, purchaser_label: h.sender_label, owned_quantity: db.items.get(h.barcode) || 0 })),
  }),
  accept_handoff_request: (b) => {
    const event = db.handoffs.find((h) => h.id === b.p_handoff_id);
    if (!event || event.status !== "PENDING") return { valid_token: true, accepted: false, status: event?.status };
    const before = db.items.get(event.barcode) || 0;
    db.items.set(event.barcode, before + event.quantity);
    event.status = "RECEIVED";
    event.received_at = tick();
    return { valid_token: true, accepted: true, quantity_before: before, quantity: before + event.quantity, giver_label: event.sender_label };
  },
  get_owner_household_settings: () => ({ valid_token: true, provenance_visibility_chosen: true, show_item_provenance: true }),
  list_owner_guest_invites: () => ({ valid_token: true, items: [] }),
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAATUlEQVR4nO3OQQ0AIAwAsQlDIsKQhQuOR5MK6Jy9vjL5QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkJBQPRASEhKqB0JCQo9dn27BDxUuMFkAAAAASUVORK5CYII=",
  "base64"
);

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

async function preparePage(context) {
  const page = await context.newPage();
  page.on("pageerror", (error) => { throw error; });
  await page.route(/unpkg\.com|jsdelivr\.net|googleapis\.com|openbd\.jp|hanmoto\.com|book-cover-proxy/, (route) =>
    route.fulfill({ status: 404, body: "" }));
  await page.route(/openlibrary\.org\/api\/books/, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      [`ISBN:${ISBN_A}`]: {
        title: "ぐりとぐら",
        authors: [{ name: "なかがわりえこ" }],
        cover: { medium: "https://covers.openlibrary.org/b/id/1-M.jpg" },
      },
    }),
  }));
  await page.route(/openlibrary\.org\/search\.json/, (route) =>
    route.fulfill({ contentType: "application/json", body: '{"docs":[]}' }));
  await page.route(/covers\.openlibrary\.org/, (route) => route.fulfill({ contentType: "image/png", body: PNG }));
  await page.route(/supabase\.co\/rest\/v1\/rpc\/(\w+)/, (route) => {
    const name = route.request().url().split("/rpc/")[1];
    const handler = rpcHandlers[name];
    const body = JSON.parse(route.request().postData() || "{}");
    const result = handler ? handler(body) : { valid_token: true };
    if (result === NOT_FOUND) {
      route.fulfill({ status: 404, contentType: "application/json", body: '{"code":"PGRST202"}' });
      return;
    }
    route.fulfill({ contentType: "application/json", body: JSON.stringify(result) });
  });
  return page;
}

async function shot(page, name) {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true });
}

async function openGuest(context, token = GUEST_TOKEN) {
  const page = await preparePage(context);
  await page.goto(`${BASE}/index.html#token=${token}`);
  await page.waitForSelector("#guestIdentityInput[disabled]");
  return page;
}

async function checkIsbn(page, isbn) {
  if (await page.isVisible("#scanNavBtn")) await page.click("#scanNavBtn");
  await page.evaluate(() => { document.getElementById("manualEntry").open = true; });
  await page.fill("#manualEntryInput", isbn);
  await page.click("#manualEntryForm button[type=submit]");
  await page.waitForSelector("#purchasePanel:not(.hidden)");
}

async function pendingCards(page) {
  // 書誌と表紙は後から差し込まれるので、読み込みが終わるまで待つ。
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#guestPendingHandoffList .guest-pending-item")].every((item) =>
      !item.querySelector(".guest-pending-title")?.textContent.includes("読み込み中") &&
      item.querySelector(".guest-pending-cover img")));
  return page.$$eval("#guestPendingHandoffList .guest-pending-item", (items) => items.map((item) => ({
    id: Number(item.dataset.handoffId),
    title: item.querySelector(".guest-pending-title")?.textContent,
    author: item.querySelector(".guest-pending-author")?.textContent,
    people: item.querySelector(".guest-pending-human-meta")?.textContent,
    when: item.querySelector(".guest-pending-when")?.textContent,
    status: item.querySelector(".guest-pending-status")?.textContent,
    isbn: item.querySelector(".guest-pending-isbn")?.textContent,
    hasCover: Boolean(item.querySelector(".guest-pending-cover img")),
  })));
}

const log = (message) => console.log(`ok - ${message}`);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

try {
  const phone = await browser.newContext({ locale: "ja-JP", timezoneId: "America/Los_Angeles" });
  let guest = await openGuest(phone);

  // 1. 初回「渡した」→ 1イベント
  await checkIsbn(guest, ISBN_A);
  await guest.click("#handoffBtn");
  await guest.waitForFunction(() => document.getElementById("status").textContent.includes("「渡した」を知らせました"));
  assert.equal(db.createCalls, 1);
  let cards = await pendingCards(guest);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0], {
    id: 1, title: "ぐりとぐら", author: "なかがわりえこ", people: "じいじから ・ ×1冊",
    when: "9月27日 13:20 に渡した", status: "受け取り待ち", isbn: `ISBN ${ISBN_A}`, hasCover: true,
  });
  log("初回の「渡した」で1イベント。端末のタイムゾーンに関係なく日本時間で表示");

  // 2. 同じISBNをもう一度 → 警告
  await checkIsbn(guest, ISBN_A);
  await guest.click("#handoffBtn");
  await guest.waitForSelector("#handoffDuplicateWarning:not(.hidden)");
  const warning = await guest.textContent("#handoffDuplicateWarning");
  assert.match(warning, /同じ本が受け取り待ちです/);
  assert.match(warning, /9月27日 13:20 に「渡した」と記録されています。数量：1冊/);
  assert.equal(db.createCalls, 1, "警告の時点では登録しない");
  await shot(guest, "01-duplicate-warning");
  log("同じISBNの再「渡した」で警告（既存日時・数量を表示）");

  // 3. やめる → 新規イベントなし
  await guest.click("#handoffDuplicateCancel");
  await guest.waitForSelector("#handoffDuplicateWarning.hidden", { state: "attached" });
  assert.equal(db.createCalls, 1);
  assert.equal(db.handoffs.length, 1);
  log("「やめる」で何も記録しない");

  // 4. それでも渡した → 既存を変えずに2件目
  const firstBefore = { ...db.handoffs[0] };
  await guest.click("#handoffBtn");
  await guest.waitForSelector("#handoffDuplicateWarning:not(.hidden)");
  await guest.click("#handoffDuplicateConfirm");
  await guest.waitForFunction(() => document.getElementById("status").textContent.includes("「渡した」を知らせました"));
  assert.equal(db.handoffs.length, 2);
  assert.deepEqual(db.handoffs[0], firstBefore, "1件目は変更しない");
  log("「それでも『渡した』にする」で2件目を別イベントとして作成");

  // 5. 1回で数量2 → quantity=2 の1イベント（既存2件を警告に並べる）
  await checkIsbn(guest, ISBN_A);
  await guest.click("#plusBtn");
  await guest.click("#handoffBtn");
  await guest.waitForSelector("#handoffDuplicateWarning:not(.hidden)");
  const items = await guest.$$eval("#handoffDuplicateList li", (nodes) => nodes.map((node) => node.textContent));
  assert.deepEqual(items, [
    "9月27日 13:20 に「渡した」と記録されています。数量：1冊",
    "9月27日 13:35 に「渡した」と記録されています。数量：1冊",
  ]);
  assert.match(await guest.textContent("#handoffDuplicateNote"), /今回：2冊/);
  await guest.click("#handoffDuplicateConfirm");
  await guest.waitForFunction(() => document.getElementById("status").textContent.includes("数量 2"));
  assert.deepEqual(db.handoffs.map((h) => h.quantity), [1, 1, 2]);
  log("1回の操作で2冊 → quantity=2 の1イベント");

  // 6. 同ISBNの複数イベントを別々に表示
  await guest.click("#backBtn");
  cards = await pendingCards(guest);
  assert.deepEqual(cards.map((c) => [c.id, c.when, c.people]), [
    [3, "9月27日 13:50 に渡した", "じいじから ・ ×2冊"],
    [2, "9月27日 13:35 に渡した", "じいじから ・ ×1冊"],
    [1, "9月27日 13:20 に渡した", "じいじから ・ ×1冊"],
  ]);
  await shot(guest, "02-pending-events");
  log("「あなたが渡したもの」で同じISBNの3イベントを日時・数量つきで個別表示");

  // 10. リロード・別端末でも維持
  await guest.reload();
  await guest.waitForSelector("#guestIdentityInput[disabled]");
  assert.deepEqual((await pendingCards(guest)).map((c) => c.id), [3, 2, 1]);
  const tablet = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  const other = await openGuest(tablet);
  assert.deepEqual((await pendingCards(other)).map((c) => [c.id, c.when]), cards.map((c) => [c.id, c.when]));
  log("再読込・別端末（別ブラウザ）でもイベントの時系列を維持");

  // 7. 1イベントを取り消しても他は残る
  guest.once("dialog", (dialog) => {
    assert.match(dialog.message(), /9月27日 13:35 の「渡した」（1冊）を取り消しますか？/);
    dialog.accept();
  });
  await guest.click('#guestPendingHandoffList [data-handoff-id="2"] button');
  await guest.waitForFunction(() => document.querySelectorAll("#guestPendingHandoffList .guest-pending-item").length === 2);
  assert.deepEqual((await pendingCards(guest)).map((c) => c.id), [3, 1]);
  assert.equal(db.handoffs[1].status, "CANCELLED");
  log("1イベントの取消で、他のイベントは受け取り待ちのまま");

  // 11. 本人が同じ本を再確認 →「受け取り待ちがあります」とイベントごとの日時・数量。拒否せず続行できる
  async function expectMyPendingStatus(page) {
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("受け取り待ちがあります"));
    const lines = await page.$$eval("#status .my-pending-list li", (nodes) => nodes.map((node) => [
      node.querySelector(".my-pending-when")?.textContent,
      node.querySelector(".my-pending-quantity")?.textContent,
    ]));
    assert.deepEqual(lines, [
      ["9月27日 13:20に「渡した」と記録されています", "数量：1冊"],
      ["9月27日 13:50に「渡した」と記録されています", "数量：2冊"],
    ], "同じISBNの受け取り待ちを合算せず、古い順に1件ずつ");
    assert.equal(await page.textContent("#purchaseBtn"), "それでも購入予定に入れる");
    assert.equal(await page.isEnabled("#purchaseBtn"), true);
    assert.equal(await page.isVisible("#handoffBtn"), true);
  }
  await checkIsbn(guest, ISBN_A);
  await expectMyPendingStatus(guest);
  await shot(guest, "04-my-pending-on-check");
  await guest.click("#purchaseBtn");
  await guest.waitForFunction(() => document.getElementById("status").textContent.includes("購入予定に追加しました"));
  assert.equal(db.plans.length, 1, "受け取り待ちがあっても購入予定へ続行できる");
  log("本人が同じ本を再確認すると「受け取り待ちがあります」と各イベントの日時・数量を示し、続行もできる");

  // 12. 他のゲストには本人の受け取り待ちを示唆しない
  db.plans.length = 0;
  const grandmaContext = await browser.newContext({ locale: "ja-JP" });
  const grandma = await openGuest(grandmaContext, OTHER_GUEST_TOKEN);
  await checkIsbn(grandma, ISBN_A);
  await grandma.waitForFunction(() => document.getElementById("status").textContent.includes("重複はありません"));
  const grandmaText = await grandma.innerText("body"); // 画面に見えている文字だけ
  assert.equal(grandmaText.includes("受け取り待ち"), false);
  assert.equal(grandmaText.includes("13:20"), false);
  const grandmaDom = await grandma.textContent("body"); // 非表示要素も含めて、他人の記録が入っていない
  assert.equal(grandmaDom.includes("13:20"), false);
  assert.equal(grandmaDom.includes("じいじから"), false);
  assert.equal(grandmaDom.includes("13:50"), false);
  assert.equal(await grandma.isVisible("#guestPendingHandoffs"), false);
  assert.equal(await grandma.textContent("#plannedQty"), "0");
  log("別のゲストには、じいじの受け取り待ちの存在・日時・数量を一切出さない");

  // 12b. 画面側の識別子を別人（ばあば）のものに書き換えても、本人の分しか見えない（サーバーが本人を決める）
  await guest.evaluate((key) => { window.getOrCreateBuyerKey = () => key; }, OTHER_GUEST_KEY);
  await checkIsbn(guest, ISBN_A);
  await expectMyPendingStatus(guest);
  assert.ok(spoofAttempts.includes(OTHER_GUEST_KEY), "改ざんしたキーが実際に送られている");
  await guest.reload();
  await guest.waitForSelector("#guestIdentityInput[disabled]");
  log("クライアントが別人の識別子を送っても、表示されるのは本人の受け取り待ちだけ");

  // 12c. 従来の共有リンクで予約済みの guest: キーを送ると、サーバーは何も記録せず、画面も成功扱いしない
  const legacyContext = await browser.newContext({ locale: "ja-JP" });
  await legacyContext.addInitScript(() => {
    for (const key of Object.keys(localStorage)) localStorage.removeItem(key);
  });
  const legacy = await preparePage(legacyContext);
  await legacy.goto(`${BASE}/index.html#token=${LEGACY_SHOP_TOKEN}`);
  await legacy.fill("#guestIdentityInput", "おじちゃん");
  await legacy.click("#guestIdentitySave");
  await legacy.waitForFunction(() => document.getElementById("guestIdentitySaved").textContent.includes("おじちゃん"));
  await legacy.evaluate((key) => { window.getOrCreateBuyerKey = () => key; }, OTHER_GUEST_KEY);
  const beforeSpoof = { handoffs: db.handoffs.length, plans: db.plans.length };
  await checkIsbn(legacy, ISBN_A);
  await legacy.click("#purchaseBtn");
  await legacy.waitForFunction(() => document.getElementById("status").textContent.includes("追加できませんでした"));
  await checkIsbn(legacy, ISBN_A);
  await legacy.click("#handoffBtn");
  await legacy.waitForFunction(() => document.getElementById("status").textContent.includes("知らせることができませんでした"));
  assert.deepEqual({ handoffs: db.handoffs.length, plans: db.plans.length }, beforeSpoof, "行が増えない");
  log("従来リンク＋予約済み guest: キーでは購入予定・渡したを記録せず、画面も失敗として表示");

  // 12d. 従来リンクの通常の端末キーでは、これまでどおり記録できる
  await legacy.evaluate(() => { window.getOrCreateBuyerKey = () => "device-legacy-1"; });
  await checkIsbn(legacy, ISBN_A);
  await legacy.click("#purchaseBtn");
  await legacy.waitForFunction(() => document.getElementById("status").textContent.includes("購入予定に追加しました"));
  assert.equal(db.plans.length, beforeSpoof.plans + 1);
  assert.equal(db.plans.at(-1).buyer_key, "device-legacy-1");
  db.plans.pop();
  log("従来リンクの通常の端末キーでは購入予定を記録できる");

  // 13. 018 未適用のDB（新RPCが404）でも、既存RPCの組み合わせで同じ表示になる
  db.withoutGuestProductState = true;
  await checkIsbn(guest, ISBN_A);
  await expectMyPendingStatus(guest);
  await checkIsbn(grandma, ISBN_A);
  await grandma.waitForFunction(() => document.getElementById("status").textContent.includes("重複はありません"));
  db.withoutGuestProductState = false;
  log("018 未適用のDBでもフォールバックで同じ判定（他ゲストへの非表示も同じ）");

  // 8. オーナーが1イベントを受け取っても、他は受け取り待ちのまま
  const ownerContext = await browser.newContext({ locale: "ja-JP" });
  await ownerContext.addInitScript(() => localStorage.setItem("kore-motteru-owner-tutorial-dismissed-v1", "1"));
  const owner = await preparePage(ownerContext);
  await owner.goto(`${BASE}/owner.html#token=${OWNER_TOKEN}`);
  await owner.waitForSelector("#handoffList .handoff-item");
  const whens = await owner.$$eval("#handoffList .handoff-when", (nodes) => nodes.map((node) => node.textContent));
  assert.deepEqual(whens, ["9月27日 13:20 に「渡した」", "9月27日 13:50 に「渡した」"]);
  await shot(owner, "03-owner-inbox");
  await owner.locator("#handoffList .handoff-item").first().locator("button", { hasText: "受け取った" }).click();
  await owner.waitForFunction(() => document.querySelectorAll("#handoffList .handoff-item").length === 1);
  assert.equal(db.handoffs[0].status, "RECEIVED");
  assert.equal(db.handoffs[2].status, "PENDING");
  await guest.reload();
  await guest.waitForSelector("#guestIdentityInput[disabled]");
  assert.deepEqual((await pendingCards(guest)).map((c) => c.id), [3]);
  log("オーナー画面でイベントごとの日時を表示し、1件だけ受け取り");

  // 9. 受取後の在庫集約
  await owner.locator("#handoffList .handoff-item button", { hasText: "受け取った" }).click();
  await owner.waitForFunction(() => document.getElementById("handoffEmpty").textContent.includes("いま受け取り待ちはありません"));
  await guest.reload();
  await guest.waitForSelector("#ownedList .owned-item");
  assert.match(await guest.textContent("#ownedList"), new RegExp(`${ISBN_A} ・ ×3`));
  assert.equal(await guest.isVisible("#guestPendingHandoffs"), false);
  log("受取完了後の在庫は同一ISBNで ×3 に集約（履歴は3イベントのまま）");
} finally {
  await browser.close();
  server.close();
}
