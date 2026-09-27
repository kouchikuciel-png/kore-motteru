const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatHandoffDateTime,
  pendingEventsForBarcode,
  describePendingEvent,
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
