// 受け渡しイベント（Issue #38）のDBテスト。
// scripts/db-test.sh が用意する使い捨てPostgreSQLでだけ実行する。
// PGTEST_DATABASE_URL が無い環境（通常の単体テスト実行時）はスキップする。
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

const DB_URL = process.env.PGTEST_DATABASE_URL;
const skip = DB_URL ? false : "PGTEST_DATABASE_URL is not set (run scripts/db-test.sh)";

const ISBN_A = "9784834000825";
const ISBN_B = "9784033030203";
const OWNER_TOKEN = "owner-token-for-local-db-test";

function literal(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sql(query) {
  return execFileSync("psql", [DB_URL, "-At", "-q", "-v", "ON_ERROR_STOP=1", "-c", query], {
    encoding: "utf8",
  }).trim();
}

function rpc(name, ...args) {
  return JSON.parse(sql(`select public.${name}(${args.map(literal).join(", ")})::text`));
}

function rows(query) {
  const text = sql(`select coalesce(json_agg(t), '[]'::json)::text from (${query}) t`);
  return JSON.parse(text);
}

let guest;

test.before(() => {
  if (skip) return;
  sql(`
    insert into public.share_tokens (household_id, token_hash, permission)
    select h.id, encode(extensions.digest(${literal(OWNER_TOKEN)}, 'sha256'), 'hex'), 'OWNER'
    from public.households h where h.display_name = '新井家・試験'
  `);
  guest = rpc("create_owner_guest_invite", OWNER_TOKEN, "じいじ");
  assert.equal(guest.valid_token, true);
});

function handoff(barcode, quantity) {
  return rpc("create_handoff_request", guest.guest_token, barcode, guest.guest_key, "じいじ", quantity);
}

function eventRow(id) {
  return rows(`select id, barcode, quantity, status, sender_key, sender_label, created_at, received_at, cancelled_at
               from public.handoff_requests where id = ${Number(id)}`)[0];
}

function myPending() {
  return rpc("get_my_pending_handoffs", guest.guest_token, guest.guest_key);
}

const created = {};

test("初回の「渡した」は1イベントを作り、日時と数量を保持する", { skip }, () => {
  const result = handoff(ISBN_A, 1);
  assert.equal(result.valid_token, true);
  assert.equal(result.status, "PENDING");
  created.first = eventRow(result.handoff_id);

  assert.equal(created.first.quantity, 1);
  assert.equal(created.first.status, "PENDING");
  assert.equal(created.first.sender_key, guest.guest_key);
  assert.equal(created.first.sender_label, "じいじ");
  assert.ok(created.first.created_at, "created_at (timestamptz) が記録される");
  assert.equal(created.first.received_at, null);
  assert.equal(created.first.cancelled_at, null);
});

test("同じISBNをもう一度「渡した」にすると、既存イベントは変えずに2件目を作る", { skip }, () => {
  const result = handoff(ISBN_A, 1);
  assert.notEqual(result.handoff_id, created.first.id);
  created.second = eventRow(result.handoff_id);

  assert.deepEqual(eventRow(created.first.id), created.first, "1件目は数量も日時も変わらない");
  assert.equal(created.second.quantity, 1);
  assert.ok(new Date(created.second.created_at) >= new Date(created.first.created_at));

  const sameIsbn = rows(`select id from public.handoff_requests
                         where sender_key = ${literal(guest.guest_key)} and barcode = ${literal(ISBN_A)}`);
  assert.equal(sameIsbn.length, 2);
});

test("1回の操作で2冊渡すと、quantity=2 の1イベントになる", { skip }, () => {
  const result = handoff(ISBN_A, 2);
  created.third = eventRow(result.handoff_id);
  assert.equal(created.third.quantity, 2);

  const sameIsbn = rows(`select quantity from public.handoff_requests
                         where sender_key = ${literal(guest.guest_key)} and barcode = ${literal(ISBN_A)}
                         order by created_at, id`);
  assert.deepEqual(sameIsbn.map((row) => row.quantity), [1, 1, 2], "過去イベント同士を ×4 に集約しない");
});

test("「あなたが渡したもの」は同じISBNでもイベントごとに日時・数量を返す（再読込・別端末でも同じ）", { skip }, () => {
  const first = myPending();
  assert.equal(first.valid_token, true);
  const ids = first.items.map((item) => item.id);
  assert.deepEqual(ids, [created.third.id, created.second.id, created.first.id], "新しい順に個別で返る");
  assert.deepEqual(first.items.map((item) => item.quantity), [2, 1, 1]);
  for (const item of first.items) {
    assert.equal(item.barcode, ISBN_A);
    assert.equal(item.status, "PENDING");
    assert.equal(item.sender_label, "じいじ");
    assert.ok(!Number.isNaN(Date.parse(item.created_at)));
  }

  // 同じ専用QRを別端末で開いた場合も、端末ではなくサーバー側の履歴を読む。
  const again = myPending();
  assert.deepEqual(again, first);
});

test("1イベントを取り消しても、同じISBNの他イベントは受け取り待ちのまま", { skip }, () => {
  const result = rpc("cancel_my_handoff_request", guest.guest_token, created.second.id, guest.guest_key);
  assert.equal(result.cancelled, true);
  assert.ok(result.cancelled_at);

  const cancelled = eventRow(created.second.id);
  assert.equal(cancelled.status, "CANCELLED");
  assert.ok(cancelled.cancelled_at, "取消日時を記録する");
  assert.equal(eventRow(created.first.id).status, "PENDING");
  assert.equal(eventRow(created.third.id).status, "PENDING");
  assert.deepEqual(myPending().items.map((item) => item.id), [created.third.id, created.first.id]);
});

test("1イベントを受け取っても、他のイベントは受け取り待ちのまま", { skip }, () => {
  const before = rows(`select quantity from public.household_items where barcode = ${literal(ISBN_A)}`);
  assert.equal(before.length, 0);

  const result = rpc("accept_handoff_request", OWNER_TOKEN, created.first.id);
  assert.equal(result.accepted, true);
  assert.equal(result.quantity, 1);

  const received = eventRow(created.first.id);
  assert.equal(received.status, "RECEIVED");
  assert.ok(received.received_at);
  assert.equal(received.created_at, created.first.created_at, "渡した日時は受取後も変えない");
  assert.equal(eventRow(created.third.id).status, "PENDING");
  assert.deepEqual(myPending().items.map((item) => item.id), [created.third.id]);

  const pendingForOwner = rpc("get_pending_handoffs", OWNER_TOKEN).items.filter((item) => item.barcode === ISBN_A);
  assert.deepEqual(pendingForOwner.map((item) => item.id), [created.third.id]);
});

test("受取完了後の在庫は同一ISBNで集約され、既存仕様どおり", { skip }, () => {
  handoff(ISBN_B, 1);
  const result = rpc("accept_handoff_request", OWNER_TOKEN, created.third.id);
  assert.equal(result.quantity_before, 1);
  assert.equal(result.quantity, 3);

  const again = rpc("accept_handoff_request", OWNER_TOKEN, created.third.id);
  assert.equal(again.accepted, false, "同じイベントの二重受取はしない");
  assert.equal(again.status, "RECEIVED");

  const owned = rpc("get_household_owned_items", OWNER_TOKEN).items.filter((item) => item.barcode === ISBN_A);
  assert.equal(owned.length, 1, "在庫は1行に集約");
  assert.equal(owned[0].quantity, 3);

  const state = rpc("get_household_product_state", guest.guest_token, ISBN_A);
  assert.equal(state.owned_quantity, 3);
  assert.equal(state.duplicate, true);

  const origins = rows(`select quantity, giver_label from public.item_origins
                        where barcode = ${literal(ISBN_A)} order by id`);
  assert.deepEqual(origins, [{ quantity: 1, giver_label: "じいじ" }, { quantity: 2, giver_label: "じいじ" }],
    "来歴は受け取ったイベントごとに残る");
});

test("オーナー側の取消でも取消日時を記録し、他イベントには触れない", { skip }, () => {
  const a = handoff(ISBN_B, 1);
  const pendingBefore = myPending().items.map((item) => item.id);
  const result = rpc("cancel_owner_handoff_request", OWNER_TOKEN, a.handoff_id);
  assert.equal(result.cancelled, true);
  assert.ok(eventRow(a.handoff_id).cancelled_at);
  assert.deepEqual(myPending().items.map((item) => item.id), pendingBefore.filter((id) => id !== a.handoff_id));
});

test("ゲストの重複確認は本人の受け取り待ちを含め、イベントごとの日時・数量を返す", { skip }, () => {
  const ISBN_C = "9784772100182";
  const other = rpc("create_owner_guest_invite", OWNER_TOKEN, "ばあば");

  const before = rpc("get_guest_product_state", guest.guest_token, ISBN_C, guest.guest_key);
  assert.equal(before.duplicate, false);
  assert.deepEqual(before.my_pending_handoffs, []);

  const first = handoff(ISBN_C, 1);
  const second = handoff(ISBN_C, 2);

  const mine = rpc("get_guest_product_state", guest.guest_token, ISBN_C, guest.guest_key);
  assert.equal(mine.valid_token, true);
  assert.equal(mine.owned_quantity, 0);
  assert.equal(mine.planned_quantity, 0);
  assert.equal(mine.duplicate, true, "在庫・購入予定が0でも、本人の受け取り待ちがあれば重複");
  assert.deepEqual(mine.my_pending_handoffs.map((event) => [event.id, event.quantity, event.status]),
    [[first.handoff_id, 1, "PENDING"], [second.handoff_id, 2, "PENDING"]], "古い順・イベントごと・合算しない");
  assert.deepEqual(
    mine.my_pending_handoffs.map((event) => Date.parse(event.created_at)),
    [first.handoff_id, second.handoff_id].map((id) => Date.parse(eventRow(id).created_at)),
    "各イベントの「渡した」日時をそのまま返す"
  );
  assert.equal("my_pending_quantity" in mine, false, "受け取り待ちの合計数量は返さない");

  // 他のゲストには、件数も存在も示さない。
  const theirs = rpc("get_guest_product_state", other.guest_token, ISBN_C, other.guest_key);
  assert.equal(theirs.duplicate, false);
  assert.deepEqual(theirs.my_pending_handoffs, []);
  assert.equal(theirs.owned_quantity, 0);
  assert.equal(theirs.planned_quantity, 0);
  assert.deepEqual(Object.keys(theirs).sort(), ["duplicate", "my_pending_handoffs", "owned_quantity", "planned_quantity", "valid_token"]);

  // 専用QRでは本人をトークンから決める。クライアントの識別子が空・別の値でも、本人の分だけを返す。
  const ownIds = mine.my_pending_handoffs.map((event) => event.id);
  assert.deepEqual(rpc("get_guest_product_state", guest.guest_token, ISBN_C, null).my_pending_handoffs.map((e) => e.id), ownIds);
  assert.deepEqual(rpc("get_guest_product_state", guest.guest_token, ISBN_C, "someone-else").my_pending_handoffs.map((e) => e.id), ownIds);
  assert.equal(rpc("get_household_product_state", guest.guest_token, ISBN_C).duplicate, false);
  assert.equal(rpc("get_guest_product_state", "invalid-token", ISBN_C, guest.guest_key).valid_token, false);

  // 1件取り消すと残りだけ、受け取ると在庫側の重複へ移る。
  rpc("cancel_my_handoff_request", guest.guest_token, first.handoff_id, guest.guest_key);
  assert.deepEqual(rpc("get_guest_product_state", guest.guest_token, ISBN_C, guest.guest_key)
    .my_pending_handoffs.map((event) => event.id), [second.handoff_id]);
  rpc("accept_handoff_request", OWNER_TOKEN, second.handoff_id);
  const received = rpc("get_guest_product_state", guest.guest_token, ISBN_C, guest.guest_key);
  assert.deepEqual(received.my_pending_handoffs, []);
  assert.equal(received.owned_quantity, 2);
  assert.equal(received.duplicate, true);
  assert.equal(rpc("get_guest_product_state", other.guest_token, ISBN_C, other.guest_key).owned_quantity, 2,
    "受取後の在庫は全ゲストに見える（既存仕様）");
});

// ---- 本人識別のなりすまし対策（専用QRでは p_buyer_key を信用しない） ----

const ISBN_D = "9784001106879";
const LEGACY_SHOP_TOKEN = "legacy-shared-shop-link";
const CHECK_TOKEN = "legacy-check-only-link";

function addShareToken(token, permission) {
  sql(`
    insert into public.share_tokens (household_id, token_hash, permission)
    select h.id, encode(extensions.digest(${literal(token)}, 'sha256'), 'hex'), ${literal(permission)}
    from public.households h where h.display_name = '新井家・試験'
  `);
}

// 返ってきたJSONに、指定したイベントの痕跡（ID・日時・数量の組）が含まれていないことを確かめる。
function assertNoTraceOf(result, events, message) {
  const text = JSON.stringify(result);
  for (const event of events) {
    assert.equal(text.includes(`"id":${event.id},`) || text.includes(`"id":${event.id}}`), false, `${message}: id ${event.id}`);
    assert.equal(text.includes(String(event.created_at).slice(0, 19)), false, `${message}: created_at`);
    const created = new Date(event.created_at).toISOString().slice(0, 19);
    assert.equal(text.includes(created), false, `${message}: created_at (ISO)`);
  }
}

test("クロスゲスト: じいじのトークン＋ばあばの guest_key では、ばあばの情報を返さない・操作できない", { skip }, () => {
  const baba = rpc("create_owner_guest_invite", OWNER_TOKEN, "ばあば");
  const babaFirst = eventRow(rpc("create_handoff_request", baba.guest_token, ISBN_D, baba.guest_key, "ばあば", 1).handoff_id);
  const babaSecond = eventRow(rpc("create_handoff_request", baba.guest_token, ISBN_D, baba.guest_key, "ばあば", 2).handoff_id);
  const babaEvents = [babaFirst, babaSecond];
  assert.equal(babaFirst.sender_key, baba.guest_key);

  // 重複確認: じいじには ISBN_D の受け取り待ちが無いので、重複なし・件数ゼロ。
  const state = rpc("get_guest_product_state", guest.guest_token, ISBN_D, baba.guest_key);
  assert.equal(state.valid_token, true);
  assert.deepEqual(state.my_pending_handoffs, []);
  assert.equal(state.duplicate, false);
  assertNoTraceOf(state, babaEvents, "get_guest_product_state");

  // 受け取り待ち一覧: じいじ本人の分だけ。ばあばのイベントは存在も件数も出ない。
  const jijiOwn = rpc("get_my_pending_handoffs", guest.guest_token, guest.guest_key);
  const spoofed = rpc("get_my_pending_handoffs", guest.guest_token, baba.guest_key);
  assert.deepEqual(spoofed, jijiOwn, "別人のキーを送っても、じいじ本人の一覧と同じ");
  assert.ok(spoofed.items.every((item) => item.sender_label === "じいじ"));
  assertNoTraceOf(spoofed, babaEvents, "get_my_pending_handoffs");

  // 取消: ばあばのイベントIDとキーを送っても取り消せない（存在も示さない）。
  const cancel = rpc("cancel_my_handoff_request", guest.guest_token, babaFirst.id, baba.guest_key);
  assert.deepEqual(cancel, { valid_token: true, request_found: false, cancelled: false });
  assert.equal(eventRow(babaFirst.id).status, "PENDING");

  // 「渡した」: ばあばのキー・呼び名を送っても、じいじ名義で記録される。
  const created = eventRow(rpc("create_handoff_request", guest.guest_token, ISBN_D, baba.guest_key, "ばあば", 1).handoff_id);
  assert.equal(created.sender_key, guest.guest_key);
  assert.equal(created.sender_label, "じいじ");

  // 購入予定: ばあばのキー・呼び名を送っても、じいじ名義で記録される。
  const plan = rpc("add_purchase_plan", guest.guest_token, ISBN_D, baba.guest_key, "ばあば", 1, "GIFT_SECRET");
  assert.equal(plan.buyer_key, guest.guest_key);
  assert.deepEqual(rows(`select buyer_key, buyer_label from public.purchase_plans where id = ${Number(plan.plan_id)}`),
    [{ buyer_key: guest.guest_key, buyer_label: "じいじ" }]);

  // ばあば本人から見た一覧は、じいじの操作の影響を受けない。
  const babaView = rpc("get_my_pending_handoffs", baba.guest_token, null);
  assert.deepEqual(babaView.items.map((item) => item.id), [babaSecond.id, babaFirst.id]);
  assert.deepEqual(babaView.items.map((item) => item.quantity), [2, 1]);
  assert.deepEqual(rpc("get_guest_product_state", baba.guest_token, ISBN_D, guest.guest_key).my_pending_handoffs.map((e) => e.id),
    [babaFirst.id, babaSecond.id], "逆方向（ばあばのトークン＋じいじのキー）でも、ばあば本人の分だけ");
});

test("CHECKトークンでは、ゲスト個人の受け取り待ちを返さない", { skip }, () => {
  addShareToken(CHECK_TOKEN, "CHECK");
  const babaKey = rows(`select sender_key from public.handoff_requests where barcode = ${literal(ISBN_D)} and sender_label = 'ばあば' limit 1`)[0].sender_key;

  const state = rpc("get_guest_product_state", CHECK_TOKEN, ISBN_D, babaKey);
  assert.equal(state.valid_token, true);
  assert.deepEqual(state.my_pending_handoffs, []);
  assert.equal(rpc("get_guest_product_state", CHECK_TOKEN, ISBN_D, guest.guest_key).my_pending_handoffs.length, 0);
  assert.equal(rpc("get_my_pending_handoffs", CHECK_TOKEN, babaKey).valid_token, false);
  assert.equal(rpc("cancel_my_handoff_request", CHECK_TOKEN, 1, babaKey).valid_token, false);
});

test("従来の共有リンク（専用QRでないSHOP）は端末識別子で動き続け、guest: の人物にはなりすませない", { skip }, () => {
  addShareToken(LEGACY_SHOP_TOKEN, "SHOP");
  const deviceKey = "device-7f3c2a";

  // 互換: 端末識別子で記録・一覧・取消ができる。
  const own = eventRow(rpc("create_handoff_request", LEGACY_SHOP_TOKEN, ISBN_D, deviceKey, "おじちゃん", 1).handoff_id);
  assert.equal(own.sender_key, deviceKey);
  assert.equal(own.sender_label, "おじちゃん");
  assert.deepEqual(rpc("get_my_pending_handoffs", LEGACY_SHOP_TOKEN, deviceKey).items.map((i) => i.id), [own.id]);
  assert.deepEqual(rpc("get_guest_product_state", LEGACY_SHOP_TOKEN, ISBN_D, deviceKey).my_pending_handoffs.map((e) => e.id), [own.id]);

  // 専用QRの人物キー（guest:）は受け付けない。
  const babaEvents = rows(`select id, created_at, quantity from public.handoff_requests
                           where barcode = ${literal(ISBN_D)} and sender_label = 'ばあば' and status = 'PENDING' order by id`);
  const babaKey = rows(`select sender_key from public.handoff_requests where id = ${babaEvents[0].id}`)[0].sender_key;
  const listed = rpc("get_my_pending_handoffs", LEGACY_SHOP_TOKEN, babaKey);
  assert.deepEqual(listed.items, []);
  assertNoTraceOf(listed, babaEvents, "legacy get_my_pending_handoffs");
  const state = rpc("get_guest_product_state", LEGACY_SHOP_TOKEN, ISBN_D, babaKey);
  assert.deepEqual(state.my_pending_handoffs, []);
  assertNoTraceOf(state, babaEvents, "legacy get_guest_product_state");
  assert.equal(rpc("cancel_my_handoff_request", LEGACY_SHOP_TOKEN, babaEvents[0].id, babaKey).request_found, false);
  assert.equal(eventRow(babaEvents[0].id).status, "PENDING");
  // 取消も互換どおり。
  assert.equal(rpc("cancel_my_handoff_request", LEGACY_SHOP_TOKEN, own.id, deviceKey).cancelled, true);
});

function tableCounts() {
  return rows(`select
    (select count(*) from public.handoff_requests)::int as handoffs,
    (select count(*) from public.purchase_plans)::int as plans,
    (select count(*) from public.handoff_plan_consumptions)::int as consumptions`)[0];
}

test("従来の共有リンクで予約済みの guest: キー・空キーを送っても、行を一切作らない", { skip }, () => {
  const babaKey = rows(`select sender_key from public.handoff_requests
                        where barcode = ${literal(ISBN_D)} and sender_label = 'ばあば' limit 1`)[0].sender_key;
  assert.match(babaKey, /^guest:/);
  const allBefore = rows("select id, status, quantity, sender_key from public.handoff_requests order by id");
  const plansBefore = rows("select id, status, quantity, buyer_key from public.purchase_plans order by id");
  const countsBefore = tableCounts();
  const plannedBefore = rpc("get_household_product_state", LEGACY_SHOP_TOKEN, ISBN_D).planned_quantity;

  for (const key of [babaKey, `  ${babaKey}  `, "guest:anything", "", "   ", null]) {
    const handoffResult = rpc("create_handoff_request", LEGACY_SHOP_TOKEN, ISBN_D, key, "ばあば", 1);
    assert.deepEqual(handoffResult,
      { valid_token: true, valid_barcode: true, valid_quantity: true, valid_buyer: false }, `handoff key=${JSON.stringify(key)}`);
    const planResult = rpc("add_purchase_plan", LEGACY_SHOP_TOKEN, ISBN_D, key, "ばあば", 3, "GIFT_SECRET");
    assert.deepEqual(planResult, { valid_token: true, valid_buyer: false }, `plan key=${JSON.stringify(key)}`);
  }

  assert.deepEqual(tableCounts(), countsBefore, "handoff_requests / purchase_plans / 消費記録の行数が増えない");
  assert.equal(rpc("get_household_product_state", LEGACY_SHOP_TOKEN, ISBN_D).planned_quantity, plannedBefore,
    "家全体の planned_quantity が増えない");
  assert.deepEqual(rows("select id, status, quantity, sender_key from public.handoff_requests order by id"), allBefore,
    "既存の受け渡しデータを変更しない");
  assert.deepEqual(rows("select id, status, quantity, buyer_key from public.purchase_plans order by id"), plansBefore,
    "既存の購入予定を変更しない");
});

test("従来の共有リンクの通常の端末キーでは、購入予定→渡した→一覧→取消が引き続き動く", { skip }, () => {
  const deviceKey = "device-2b91e0";
  const before = tableCounts();
  const plannedBefore = rpc("get_household_product_state", LEGACY_SHOP_TOKEN, ISBN_D).planned_quantity;

  const plan = rpc("add_purchase_plan", LEGACY_SHOP_TOKEN, ISBN_D, deviceKey, "おばちゃん", 2, "GIFT_SECRET");
  assert.equal(plan.valid_token, true);
  assert.equal(plan.buyer_key, deviceKey);
  assert.equal(plan.planned_quantity_after, plannedBefore + 2);

  const handoffResult = rpc("create_handoff_request", LEGACY_SHOP_TOKEN, ISBN_D, deviceKey, "おばちゃん", 1);
  assert.equal(handoffResult.status, "PENDING");
  assert.equal(handoffResult.planned_quantity_consumed, 1, "自分の購入予定だけを消費する");
  const event = eventRow(handoffResult.handoff_id);
  assert.equal(event.sender_key, deviceKey);
  assert.equal(event.sender_label, "おばちゃん");

  assert.deepEqual(rpc("get_my_pending_handoffs", LEGACY_SHOP_TOKEN, deviceKey).items.map((i) => i.id), [event.id]);
  assert.deepEqual(rpc("get_guest_product_state", LEGACY_SHOP_TOKEN, ISBN_D, deviceKey).my_pending_handoffs.map((e) => e.id), [event.id]);

  const cancelled = rpc("cancel_my_handoff_request", LEGACY_SHOP_TOKEN, event.id, deviceKey);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.restored_planned_quantity, 1);
  assert.deepEqual(rpc("get_my_pending_handoffs", LEGACY_SHOP_TOKEN, deviceKey).items, []);

  const after = tableCounts();
  assert.equal(after.handoffs, before.handoffs + 1);
  assert.ok(after.plans > before.plans);
});

test("専用QRでは識別子を送らなくても、サーバー導出の本人キーで記録される", { skip }, () => {
  const before = tableCounts();
  const event = eventRow(rpc("create_handoff_request", guest.guest_token, ISBN_D, null, null, 1).handoff_id);
  assert.equal(event.sender_key, guest.guest_key);
  assert.equal(event.sender_label, "じいじ");
  const plan = rpc("add_purchase_plan", guest.guest_token, ISBN_D, "", null, 1, "GIFT_SECRET");
  assert.equal(plan.buyer_key, guest.guest_key);
  assert.equal(tableCounts().handoffs, before.handoffs + 1);
  rpc("cancel_my_handoff_request", guest.guest_token, event.id, null);
  assert.equal(eventRow(event.id).status, "CANCELLED");
});

test("Issue #40: オーナーの受け取り待ちは同じISBNでもイベントごとに返り、受取・取消で1件ずつ減る", { skip }, () => {
  const ISBN_E = "9784044001070";
  const countFor = (barcode) => rpc("get_pending_handoffs", OWNER_TOKEN).items.filter((item) => item.barcode === barcode);
  const before = rpc("get_pending_handoffs", OWNER_TOKEN).items.length;

  const first = handoff(ISBN_E, 1);
  const second = handoff(ISBN_E, 1);
  const third = handoff(ISBN_D, 2);
  assert.deepEqual(countFor(ISBN_E).map((item) => item.id), [first.handoff_id, second.handoff_id], "同じISBNでも2件");
  assert.equal(rpc("get_pending_handoffs", OWNER_TOKEN).items.length, before + 3, "異なるISBN混在でもイベント総数");

  rpc("accept_handoff_request", OWNER_TOKEN, first.handoff_id);
  assert.deepEqual(countFor(ISBN_E).map((item) => item.id), [second.handoff_id]);
  assert.equal(rpc("get_pending_handoffs", OWNER_TOKEN).items.length, before + 2, "受取で1件だけ減る");

  rpc("cancel_owner_handoff_request", OWNER_TOKEN, third.handoff_id);
  assert.equal(rpc("get_pending_handoffs", OWNER_TOKEN).items.length, before + 1, "取消で1件だけ減る");
  rpc("cancel_owner_handoff_request", OWNER_TOKEN, second.handoff_id);
});

test("018 適用前の既存データは壊さず、取消日時を捏造しない", { skip }, () => {
  const legacy = rows(`select quantity, status, created_at, received_at, cancelled_at
                       from public.handoff_requests
                       where sender_key = 'legacy-device-key' order by id`);
  assert.equal(legacy.length, 3);
  assert.deepEqual(legacy.map((row) => [row.quantity, row.status]), [[1, "PENDING"], [1, "CANCELLED"], [2, "RECEIVED"]]);
  assert.ok(legacy.every((row) => row.cancelled_at === null), "過去の取消日時はNULLのまま");
  assert.equal(new Date(legacy[0].created_at).toISOString(), "2026-09-20T04:20:00.000Z", "既存の created_at を保持");
  assert.equal(new Date(legacy[2].received_at).toISOString(), "2026-09-22T01:00:00.000Z");
});
