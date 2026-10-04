const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatHandoffDateTime,
  pendingEventsForBarcode,
  describePendingEvent,
  mergeGuestProductState,
} = require("../handoff-events.js");

const NOW = new Date("2026-09-27T06:00:00Z");

test("DBの日時（UTC）を日本時間で表示する", () => {
  assert.equal(formatHandoffDateTime("2026-09-27T04:20:00Z", NOW), "9月27日 13:20");
  assert.equal(formatHandoffDateTime("2026-09-27T13:20:00+09:00", NOW), "9月27日 13:20");
  // UTCでは前日でも、日本時間では翌日になる。
  assert.equal(formatHandoffDateTime("2026-10-03T09:42:00Z", NOW), "10月3日 18:42");
  assert.equal(formatHandoffDateTime("2026-09-26T15:05:00Z", NOW), "9月27日 00:05");
});

test("今年以外は年も表示し、日時が無い・壊れている時は推測しない", () => {
  // 年の判定も日本時間で行う（UTCでは2025年でも、日本時間では2026年）。
  assert.equal(formatHandoffDateTime("2025-12-31T15:30:00Z", NOW), "1月1日 00:30");
  assert.equal(formatHandoffDateTime("2025-12-31T14:30:00Z", NOW), "2025年12月31日 23:30");
  assert.equal(formatHandoffDateTime("2025-09-27T04:20:00Z", NOW), "2025年9月27日 13:20");
  assert.equal(formatHandoffDateTime(null, NOW), "");
  assert.equal(formatHandoffDateTime("not-a-date", NOW), "");
});

test("同じ本の受け取り待ちをイベントごとに古い順で返し、数量を合算しない", () => {
  const events = [
    { id: 3, barcode: "9784834000825", quantity: 2, created_at: "2026-10-03T09:42:00Z", status: "PENDING" },
    { id: 1, barcode: "9784834000825", quantity: 1, created_at: "2026-09-27T04:20:00Z", status: "PENDING" },
    { id: 9, barcode: "9784033030203", quantity: 1, created_at: "2026-09-27T04:30:00Z", status: "PENDING" },
    { id: 2, barcode: "9784834000825", quantity: 1, created_at: "2026-09-27T04:35:00Z", status: "PENDING" },
    { id: 4, barcode: "9784834000825", quantity: 5, created_at: "2026-09-28T00:00:00Z", status: "CANCELLED" },
  ];

  const pending = pendingEventsForBarcode(events, "9784834000825");
  assert.deepEqual(pending.map((event) => event.id), [1, 2, 3]);
  assert.deepEqual(pending.map((event) => event.quantity), [1, 1, 2]);
  assert.equal(pendingEventsForBarcode(events, "9780000000000").length, 0);
  assert.equal(pendingEventsForBarcode(null, "9784834000825").length, 0);
});

test("警告文は既存イベントの日時と数量を示す", () => {
  const described = describePendingEvent(
    { id: 1, quantity: 1, created_at: "2026-09-27T04:20:00Z" },
    NOW
  );
  assert.deepEqual(described, {
    id: 1,
    when: "9月27日 13:20",
    quantity: 1,
    text: "9月27日 13:20 に「渡した」と記録されています。数量：1冊",
  });

  assert.equal(
    describePendingEvent({ id: 2, quantity: 2, created_at: null }, NOW).text,
    "「渡した」の記録があります。数量：2冊"
  );
});

test("重複確認に本人の受け取り待ちを重ね、在庫・購入予定が0でも重複として扱う", () => {
  const state = { valid_token: true, owned_quantity: 0, planned_quantity: 0, duplicate: false };
  const mine = [
    { id: 7, barcode: "9784834000825", quantity: 2, created_at: "2026-09-27T04:35:00Z", status: "PENDING" },
    { id: 5, barcode: "9784834000825", quantity: 1, created_at: "2026-09-27T04:20:00Z", status: "PENDING" },
    { id: 6, barcode: "9784033030203", quantity: 1, created_at: "2026-09-27T04:25:00Z", status: "PENDING" },
  ];

  const merged = mergeGuestProductState(state, mine, "9784834000825");
  assert.equal(merged.duplicate, true);
  assert.equal(merged.owned_quantity, 0);
  assert.equal(merged.planned_quantity, 0);
  assert.deepEqual(
    merged.my_pending_handoffs.map((event) => [event.id, event.quantity, event.created_at]),
    [[5, 1, "2026-09-27T04:20:00Z"], [7, 2, "2026-09-27T04:35:00Z"]],
    "イベントごとに古い順。数量は合算しない"
  );
});

test("本人の受け取り待ちが無ければ、従来どおり在庫・購入予定だけで判定する", () => {
  assert.equal(
    mergeGuestProductState({ owned_quantity: 0, planned_quantity: 0, duplicate: false }, [], "9784834000825").duplicate,
    false
  );
  const owned = mergeGuestProductState({ owned_quantity: 1, planned_quantity: 0, duplicate: true }, null, "9784834000825");
  assert.equal(owned.duplicate, true);
  assert.deepEqual(owned.my_pending_handoffs, []);
});

// ---- Issue #40: 受け取り待ち件数は PENDING イベント件数（ISBN単位にまとめない） ----
const { uniquePendingEvents } = require("../handoff-events.js");

test("受け取り待ち件数は同じISBNでもイベントごとに数える", () => {
  const events = [
    { id: 1, barcode: "9784834000825", quantity: 1, created_at: "2026-09-23T03:00:00Z" },
    { id: 2, barcode: "9784834000825", quantity: 1, created_at: "2026-09-27T03:00:00Z" },
  ];
  assert.equal(uniquePendingEvents(events).length, 2);
});

test("異なるISBNが混在しても、イベント総数と件数が一致する（数量は足さない）", () => {
  const events = [
    { id: 1, barcode: "9784834000825", quantity: 1 },
    { id: 2, barcode: "9784834000825", quantity: 3 },
    { id: 3, barcode: "9784033030203", quantity: 2 },
  ];
  const unique = uniquePendingEvents(events);
  assert.deepEqual(unique.map((event) => event.id), [1, 2, 3], "届いた順のまま1件ずつ");
  assert.equal(unique.length, 3);
});

test("同じイベントが重複して届いた時だけ1件にし、受取・取消済みは数えない", () => {
  const events = [
    { id: 1, barcode: "9784834000825", quantity: 1 },
    { id: 1, barcode: "9784834000825", quantity: 1 },
    { id: 2, barcode: "9784834000825", quantity: 1, status: "RECEIVED" },
    { id: 3, barcode: "9784834000825", quantity: 1, status: "CANCELLED" },
    { id: 4, barcode: "9784834000825", quantity: 1, status: "PENDING" },
  ];
  assert.deepEqual(uniquePendingEvents(events).map((event) => event.id), [1, 4]);
  assert.deepEqual(uniquePendingEvents(null), []);
});
