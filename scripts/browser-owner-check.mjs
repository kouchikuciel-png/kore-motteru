// ローカル専用: Issue #40（オーナー側3不具合）の画面フローを Playwright で確認する。
// Supabase RPC・書誌API・カメラ（html5-qrcode）・OCR（Tesseract）はこのスクリプト内の模擬で置き換える。
// 本番へは接続しない。
//
// 実行例:
//   PLAYWRIGHT_MODULE=$(npm root -g)/playwright node scripts/browser-owner-check.mjs
// 一部だけ: ONLY_SECTION=count|scanner|cover
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
const OWNER_TOKEN = "local_owner";
const GUEST_TOKEN = "kmtg_local_guest";
const ISBN_A = "9784834000825";
const ISBN_B = "9784033030203";
const ISBN_BASHO = "9784044001070"; // 実機で表紙が出なかった例（芭蕉全句集）
const PRICE_CODE = "1920037017002";
const PRICE_CODE_ISBN10_TRAP = "1920037005405"; // 一部が有効な ISBN-10 の並びになる下段コード

const ONLY_SECTION = process.env.ONLY_SECTION || "";
const runSection = (name) => !ONLY_SECTION || ONLY_SECTION === name;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAATUlEQVR4nO3OQQ0AIAwAsQlDIsKQhQuOR5MK6Jy9vjL5QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkJBQPRASEhKqB0JCQo9dn27BDxUuMFkAAAAASUVORK5CYII=",
  "base64"
);

// ---- 模擬バックエンド ----
const db = { clock: Date.parse("2026-09-23T03:00:00Z"), nextId: 1, handoffs: [], items: new Map(), ownerStateCalls: [] };
function addHandoff(barcode, quantity, label = "ばあば") {
  const event = { id: db.nextId++, barcode, quantity, sender_label: label, purchaser_label: label,
    status: "PENDING", created_at: new Date(db.clock).toISOString() };
  db.clock += 4 * 24 * 60 * 60 * 1000;
  db.handoffs.push(event);
  return event;
}
const pending = () => db.handoffs.filter((h) => h.status === "PENDING")
  .sort((a, b) => a.created_at.localeCompare(b.created_at));

const rpcHandlers = {
  get_owner_household_settings: () => ({ valid_token: true, provenance_visibility_chosen: true, show_item_provenance: false }),
  list_owner_guest_invites: () => ({ valid_token: true, items: [] }),
  get_pending_handoffs: () => ({
    valid_token: true,
    items: pending().map((h) => ({ ...h, owned_quantity: db.items.get(h.barcode) || 0 })),
  }),
  accept_handoff_request: (b) => {
    const h = db.handoffs.find((x) => x.id === b.p_handoff_id);
    if (!h || h.status !== "PENDING") return { valid_token: true, accepted: false, status: h?.status };
    const before = db.items.get(h.barcode) || 0;
    db.items.set(h.barcode, before + h.quantity);
    h.status = "RECEIVED";
    return { valid_token: true, accepted: true, quantity_before: before, quantity: before + h.quantity, giver_label: h.sender_label };
  },
  cancel_owner_handoff_request: (b) => {
    const h = db.handoffs.find((x) => x.id === b.p_handoff_id);
    if (!h || h.status !== "PENDING") return { valid_token: true, cancelled: false, status: h?.status };
    h.status = "CANCELLED";
    return { valid_token: true, cancelled: true };
  },
  get_owner_item_state: (b) => {
    db.ownerStateCalls.push(b.p_barcode);
    return { valid_token: true, valid_barcode: true, exists: false, quantity: 0, pending_handoff_quantity: 0, pending_handoffs: [] };
  },
  get_guest_identity: () => ({ valid_token: true, managed_guest: true, guest_key: "guest:local", label: "じいじ" }),
  get_household_owned_items: () => ({
    valid_token: true, items: [...db.items.entries()].map(([barcode, quantity]) => ({ barcode, quantity, origins: [] })),
  }),
  get_my_pending_handoffs: () => ({ valid_token: true, items: [] }),
  get_guest_product_state: (b) => {
    db.ownerStateCalls.push(`guest:${b.p_barcode}`);
    const owned = db.items.get(b.p_barcode) || 0;
    return { valid_token: true, owned_quantity: owned, planned_quantity: 0, my_pending_handoffs: [], duplicate: owned > 0 };
  },
};

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

// 模擬カメラ: start で読み取りコールバックを保持し、テストから decode を流し込む。
// OCR 用に、videoWidth/videoHeight を持つ <video> を #reader に置く。
const FAKE_HTML5_QRCODE = `
window.Html5QrcodeSupportedFormats = { EAN_13: 9, EAN_8: 10 };
window.__scanLog = [];
window.Html5Qrcode = class {
  constructor(id) { this.id = id; }
  async start(camera, config, onSuccess) {
    const reader = document.getElementById(this.id);
    let video = reader.querySelector("video");
    if (!video) {
      video = document.createElement("video");
      Object.defineProperty(video, "videoWidth", { value: 640 });
      Object.defineProperty(video, "videoHeight", { value: 480 });
      reader.appendChild(video);
    }
    window.__emit = (text) => onSuccess(text, {});
    window.__scanLog.push("start");
  }
  async stop() { window.__emit = null; window.__scanLog.push("stop"); }
};`;

// 模擬OCR: window.__ocrText を window.__ocrDelay ミリ秒後に返す。
const FAKE_TESSERACT = `
window.__ocrCalls = 0;
window.Tesseract = {
  createWorker: async () => ({
    setParameters: async () => {},
    recognize: async () => {
      window.__ocrCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, window.__ocrDelay || 0));
      return { data: { text: window.__ocrText || "" } };
    },
    terminate: async () => {},
  }),
};`;

const coverRequests = [];
async function preparePage(context, { metadataDelay = 0 } = {}) {
  const page = await context.newPage();
  page.on("pageerror", (error) => { throw error; });
  await page.route(/unpkg\.com/, (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_HTML5_QRCODE }));
  await page.route(/jsdelivr\.net/, (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_TESSERACT }));
  await page.route(/api\.openbd\.jp/, (route) => route.fulfill({ contentType: "application/json", body: "[null]" }));
  await page.route(/openlibrary\.org\/(api|search)/, async (route) => {
    if (metadataDelay) await new Promise((resolve) => setTimeout(resolve, metadataDelay));
    const url = route.request().url();
    if (url.includes("/search.json")) return route.fulfill({ contentType: "application/json", body: '{"docs":[]}' });
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(url.includes(ISBN_A) ? {
        [`ISBN:${ISBN_A}`]: { title: "ぐりとぐら", authors: [{ name: "なかがわりえこ" }] },
      } : {}),
    });
  });
  // 芭蕉全句集は Google Books にだけ書誌・表紙がある想定。直接の Google 画像は端末から読めず、中継だと読める。
  await page.route(/www\.googleapis\.com\/books/, (route) => {
    const url = decodeURIComponent(route.request().url());
    const hit = url.includes(ISBN_BASHO) || url.includes("芭蕉全句集");
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(hit ? {
        items: [{
          id: "BASHO",
          volumeInfo: {
            title: "芭蕉全句集 : 現代語訳付き",
            authors: ["松尾芭蕉"],
            imageLinks: { thumbnail: "http://books.google.com/books/content?id=BASHO&printsec=frontcover&img=1&zoom=1&source=gbs_api" },
          },
        }],
      } : { items: [] }),
    });
  });
  await page.route(/books\.google\.com|covers\.openlibrary\.org|img\.hanmoto\.com/, (route) => {
    coverRequests.push(route.request().url());
    route.fulfill({ status: 404, body: "" });
  });
  await page.route(/book-cover-proxy/, (route) => {
    coverRequests.push(route.request().url());
    const src = new URL(route.request().url()).searchParams.get("src") || "";
    if (!page.__proxyDown && src.includes("books.google.com/books/content?id=BASHO")) {
      route.fulfill({ contentType: "image/png", body: PNG });
    } else {
      route.fulfill({ status: 502, body: "Upstream 404" });
    }
  });
  await page.route(/supabase\.co\/rest\/v1\/rpc\/(\w+)/, (route) => {
    const name = route.request().url().split("/rpc/")[1];
    const handler = rpcHandlers[name];
    const body = JSON.parse(route.request().postData() || "{}");
    route.fulfill({ contentType: "application/json", body: JSON.stringify(handler ? handler(body) : { valid_token: true }) });
  });
  return page;
}

async function openOwner(options = {}) {
  const context = await browser.newContext({ locale: "ja-JP" });
  await context.addInitScript(() => localStorage.setItem("kore-motteru-owner-tutorial-dismissed-v1", "1"));
  const page = await preparePage(context, options);
  await page.goto(`${BASE}/owner.html#token=${OWNER_TOKEN}`);
  await page.waitForFunction(() => document.getElementById("handoffCount")?.textContent !== "0" ||
    !document.getElementById("handoffEmpty")?.classList.contains("hidden"));
  return page;
}

async function inboxState(page) {
  return page.evaluate(() => ({
    count: document.getElementById("handoffCount").textContent,
    cards: document.querySelectorAll("#handoffList .handoff-item").length,
  }));
}

async function waitInbox(page, expected) {
  await page.waitForFunction((n) =>
    document.getElementById("handoffCount").textContent === String(n) &&
    document.querySelectorAll("#handoffList .handoff-item").length === n, expected);
  // 遅れて届く読み込みで二重に描かれないことも見るため、しばらく待ってから再確認する。
  await page.waitForTimeout(1500);
  assert.deepEqual(await inboxState(page), { count: String(expected), cards: expected });
}

async function shot(page, name) {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true });
}

const log = (message) => console.log(`ok - ${message}`);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

try {
  // ===== 不具合1: 受け取り待ち件数 = PENDING イベント件数 =====
  if (runSection("count")) {
  const a1 = addHandoff(ISBN_A, 1); // 9月23日
  addHandoff(ISBN_A, 1); // 9月27日
  const owner = await openOwner({ metadataDelay: 700 });
  await waitInbox(owner, 2);
  log("同じISBNの受け取り待ちが2イベント → 件数2・カード2");

  addHandoff(ISBN_B, 2);
  await owner.evaluate(() => document.dispatchEvent(new CustomEvent("kore-motteru:handoff-updated")));
  await waitInbox(owner, 3);
  assert.equal(pending().length, 3);
  log("異なるISBNが混在 → イベント総数3と表示件数3が一致");

  // 読み込みが重なる状況（更新イベント＋画面復帰）でも二重に描かない。
  await owner.evaluate(() => {
    document.dispatchEvent(new CustomEvent("kore-motteru:handoff-updated"));
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new CustomEvent("kore-motteru:handoff-updated"));
  });
  await waitInbox(owner, 3);
  log("読み込みが重なっても、カードは二重に描かれず件数と一致");

  // 受け取り（タイマー＋更新イベントで読み込みが重なる経路）で1件だけ減る。
  await owner.locator("#handoffList .handoff-item").first().locator("button", { hasText: "受け取った" }).click();
  await owner.waitForFunction(() => document.querySelector("#handoffList .handoff-result")?.textContent.includes("在庫"));
  await waitInbox(owner, 2);
  assert.equal(db.handoffs.find((h) => h.id === a1.id).status, "RECEIVED");
  log("1イベントを受け取ると、件数もカードも1だけ減る（3→2）");

  owner.once("dialog", (dialog) => dialog.accept());
  await owner.locator("#handoffList .handoff-item").last().locator("button", { hasText: "取り消す" }).click();
  await waitInbox(owner, 1);
  log("1イベントを取り消すと、件数もカードも1だけ減る（2→1）");
  await owner.context().close();
  }

  // ===== 不具合2: オーナーのカメラは 192… を登録候補にしない =====
  if (runSection("scanner")) {
  const scanner = await openOwner();
  await scanner.click("#startBtn");
  await scanner.waitForFunction(() => typeof window.__emit === "function");
  const emit = (code) => scanner.evaluate((c) => window.__emit?.(c), code);
  // 一定時間読めない時に動く既存の自動OCR（owner.js、最大2回）とは別に、
  // 192 を読んだこと自体でカメラが止まらないかを見るため、操作前後の差分だけを確認する。
  const logLength = () => scanner.evaluate(() => window.__scanLog.length);
  const disableTimedAutoOcr = () => scanner.evaluate(() => { autoOcrAttempts = MAX_AUTO_OCR_ATTEMPTS; clearAutoOcrTimer(); });
  const scanState = (since = 0) => scanner.evaluate((from) => ({
    log: window.__scanLog.slice(from).join(","),
    quantityShown: !document.getElementById("quantityPanel").classList.contains("hidden"),
    status: document.getElementById("status").textContent.replace(/\s+/g, " ").trim(),
  }), since);

  db.ownerStateCalls.length = 0;
  await disableTimedAutoOcr();
  let mark = await logLength();
  await scanner.evaluate(() => { window.__ocrText = "1920037017002\nC0037 ¥1700E"; window.__ocrDelay = 50; });
  for (let i = 0; i < 4; i += 1) {
    await emit(PRICE_CODE);
    await scanner.waitForTimeout(120);
  }
  await scanner.waitForTimeout(800);
  let state = await scanState(mark);
  assert.deepEqual(db.ownerStateCalls, [], "192 では登録候補を照会しない");
  assert.equal(state.quantityShown, false);
  assert.equal(state.log, "", "192 を読んでもカメラを止めない（978 の読み取りを続ける）");
  assert.ok(await scanner.evaluate(() => window.__ocrCalls) >= 1, "近くの印字ISBNを探す OCR 自体は動く");
  log("192 を何度読んでも登録候補にならず、カメラは止まらない（下段だけのOCR結果も採用しない）");

  // ISBN-10 救済の落とし穴: 「ISBN」の後に下段コードしか読めなかった時も採用しない。
  await scanner.evaluate(() => { window.__ocrText = "ISBN\n1920037005405"; });
  await scanner.waitForTimeout(2700); // 高速OCRの間隔を空ける
  mark = await logLength();
  for (let i = 0; i < 3; i += 1) {
    await emit(PRICE_CODE_ISBN10_TRAP);
    await scanner.waitForTimeout(120);
  }
  await scanner.waitForTimeout(800);
  state = await scanState(mark);
  assert.deepEqual(db.ownerStateCalls, [], "下段コードの数字から ISBN-10→978 を作らない");
  assert.equal(state.log, "");
  log("「ISBN」＋下段コードしか読めなくても、ISBN-10 経由の偽978を作らない");

  // 192 で OCR が走っている最中に 978 を読めば、そちらを採用する。
  await scanner.evaluate(() => { window.__ocrText = ""; window.__ocrDelay = 1500; });
  await scanner.waitForTimeout(2700);
  mark = await logLength();
  for (let i = 0; i < 3; i += 1) {
    await emit(PRICE_CODE);
    await scanner.waitForTimeout(120);
  }
  await emit("9784058008096");
  await scanner.waitForFunction(() => !document.getElementById("quantityPanel").classList.contains("hidden"));
  await scanner.waitForTimeout(1800); // OCR 完了後も結果で上書きしない
  state = await scanState(mark);
  assert.deepEqual(db.ownerStateCalls, ["9784058008096"]);
  assert.match(state.status, /9784058008096/);
  assert.equal(state.log, "stop", "978 を採用した時だけカメラを止める（OCR 結果で上書きしない）");
  log("二段バーコード（192→978）の順でも、192 を捨てて 978 を採用する");
  await shot(scanner, "owner-scan-978-after-192");

  // 有効な 978/979 は従来どおり登録候補になる。ISBN-10 印字の救済・OCR救済も維持。
  db.ownerStateCalls.length = 0;
  await scanner.click("#againBtn");
  await scanner.waitForFunction(() => typeof window.__emit === "function");
  await emit("9791090636071");
  await scanner.waitForFunction(() => !document.getElementById("quantityPanel").classList.contains("hidden"));
  assert.deepEqual(db.ownerStateCalls, ["9791090636071"]);
  log("有効な 979 バーコードは従来どおり登録候補になる");

  db.ownerStateCalls.length = 0;
  await scanner.click("#againBtn");
  await scanner.waitForFunction(() => typeof window.__emit === "function");
  await disableTimedAutoOcr();
  await scanner.evaluate(() => { window.__ocrText = "ISBN4-19-862573-5\n1920037017002"; window.__ocrDelay = 50; });
  await scanner.waitForTimeout(2700);
  for (let i = 0; i < 3; i += 1) {
    await emit(PRICE_CODE);
    await scanner.waitForTimeout(120);
  }
  await scanner.waitForFunction(() => !document.getElementById("quantityPanel").classList.contains("hidden"));
  assert.deepEqual(db.ownerStateCalls, ["9784198625733"]);
  log("192 しか読めない時は印字ISBNを OCR で救済（ISBN-10→13 変換も維持）");
  await scanner.context().close();
  }

  // ===== 不具合3: オーナー受け取り待ちの表紙をゲスト側と同等に解決する =====
  if (runSection("cover")) {
  db.handoffs.length = 0;
  db.items.clear();
  db.items.set(ISBN_BASHO, 1); // ゲスト本棚にも同じ本
  addHandoff(ISBN_BASHO, 1);

  const guestContext = await browser.newContext({ locale: "ja-JP" });
  const guest = await preparePage(guestContext);
  await guest.goto(`${BASE}/index.html#token=${GUEST_TOKEN}`);
  await guest.waitForSelector("#ownedList .owned-item");
  await guest.waitForFunction(() => {
    const img = document.querySelector("#ownedList .owned-cover img");
    return img && img.complete && img.naturalWidth > 0 && img.src.includes("book-cover-proxy");
  });
  const guestCover = await guest.$eval("#ownedList .owned-cover img", (img) => img.src);

  // 候補の並び（直接・中継の順番）がゲスト本棚と同じ規則であること。
  const parity = await guest.evaluate(() => {
    const sample = [
      "http://books.google.com/books/content?id=BASHO&printsec=frontcover&img=1&zoom=1&source=gbs_api",
      "https://covers.openlibrary.org/b/id/1-M.jpg",
      "https://img.hanmoto.com/bd/img/9784044001070_600.jpg",
    ];
    const proxyBase = `${SUPABASE_URL}/functions/v1/book-cover-proxy`;
    return {
      guest: expandGuestCoverCandidates(sample),
      chain: window.KoreMotteruCoverChain.expandCoverCandidates({ coverUrls: sample }, proxyBase),
    };
  });
  assert.deepEqual(parity.chain, parity.guest, "オーナー側の候補展開はゲスト本棚と同じ");

  const ownerCover = await openOwner();
  await ownerCover.waitForFunction(() => {
    const img = document.querySelector("#handoffList .handoff-cover img");
    return img && img.naturalWidth > 0;
  });
  const ownerCoverSrc = await ownerCover.$eval("#handoffList .handoff-cover img", (img) => img.src);
  // どちらも同じ Google Books の巻（id=BASHO）の表紙を中継経由で表示する。
  // オーナー側は既存の本登録と同じく大きい画像（zoom=2）を先に試すため、zoom の違いは許容する。
  const coverVolume = (src) => {
    const url = new URL(src);
    const inner = new URL(url.searchParams.get("src"));
    return { proxied: url.pathname.endsWith("/book-cover-proxy"), host: inner.hostname, id: inner.searchParams.get("id") };
  };
  assert.deepEqual(coverVolume(ownerCoverSrc), coverVolume(guestCover), "ゲスト本棚と同じ本の表紙（Google表紙の中継）で表示");
  assert.deepEqual(coverVolume(ownerCoverSrc), { proxied: true, host: "books.google.com", id: "BASHO" });
  assert.match(await ownerCover.textContent("#handoffList .handoff-name"), /芭蕉全句集/);
  await shot(ownerCover, "owner-inbox-basho-cover");
  log("芭蕉全句集: オーナー受け取り待ちでもゲスト本棚と同じ表紙（中継）が出る");
  await ownerCover.context().close();

  // 取得不能なら安全に📚。
  coverRequests.length = 0;
  const ownerNoCoverContext = await browser.newContext({ locale: "ja-JP" });
  await ownerNoCoverContext.addInitScript(() => localStorage.setItem("kore-motteru-owner-tutorial-dismissed-v1", "1"));
  const ownerNoCover = await preparePage(ownerNoCoverContext);
  ownerNoCover.__proxyDown = true;
  await ownerNoCover.goto(`${BASE}/owner.html#token=${OWNER_TOKEN}`);
  await ownerNoCover.waitForSelector("#handoffList .handoff-item");
  await ownerNoCover.waitForTimeout(1500);
  assert.equal(await ownerNoCover.$$eval("#handoffList .handoff-cover img", (images) => images.length), 0);
  assert.match(await ownerNoCover.textContent("#handoffList .handoff-cover"), /📚/);
  assert.ok(coverRequests.some((url) => url.includes("book-cover-proxy")), "中継候補まで試してから📚");
  log("表紙を取得できない時は、全候補を試したうえで📚に戻る");
  await ownerNoCover.context().close();

  // ゲスト側の ISBN 確認（重複確認）を壊していない。
  db.ownerStateCalls.length = 0;
  await guest.click("#scanNavBtn");
  await guest.evaluate(() => { document.getElementById("manualEntry").open = true; });
  await guest.fill("#manualEntryInput", ISBN_BASHO);
  await guest.click("#manualEntryForm button[type=submit]");
  await guest.waitForFunction(() => document.getElementById("status").textContent.includes("重複しています"));
  assert.deepEqual(db.ownerStateCalls, [`guest:${ISBN_BASHO}`]);
  log("ゲスト側の ISBN 確認・重複確認は従来どおり");
  }
} finally {
  await browser.close();
  server.close();
}
