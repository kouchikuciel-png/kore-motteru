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
