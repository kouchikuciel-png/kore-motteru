// 受け渡しイベント（「渡した」1操作 = 1イベント）の表示用ヘルパー。
// 在庫は集約してよいが、受け渡し履歴は集約しない。ここでは数量を足し合わせない。
(() => {
  const TIME_ZONE = "Asia/Tokyo";

  const dateTimeFormatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: TIME_ZONE,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const yearFormatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: TIME_ZONE,
    year: "numeric",
  });

  function parseTimestamp(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // DBの timestamptz を日本時間で「9月27日 13:20」と表示する。
  // 今年以外は「2025年9月27日 13:20」にする。日時が無ければ空文字（推測しない）。
  function formatHandoffDateTime(value, now = new Date()) {
    const date = parseTimestamp(value);
    if (!date) return "";

    const parts = Object.fromEntries(
      dateTimeFormatter.formatToParts(date).map((part) => [part.type, part.value])
    );
    const text = `${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}`;
    const year = yearFormatter.format(date);
    return year === yearFormatter.format(now) ? text : `${year}${text}`;
  }

  function eventTime(event) {
    return parseTimestamp(event?.created_at)?.getTime() ?? 0;
  }

  // 同じ本の受け取り待ちイベントを、古い順に1件ずつ返す（まとめない）。
  function pendingEventsForBarcode(events, barcode) {
    const target = String(barcode || "");
    return (Array.isArray(events) ? events : [])
      .filter((event) => String(event?.barcode || "") === target)
      .filter((event) => !event?.status || event.status === "PENDING")
      .slice()
      .sort((a, b) => eventTime(a) - eventTime(b) || Number(a?.id || 0) - Number(b?.id || 0));
  }

  // 「同じ本が受け取り待ちです」の警告に出す各イベントの説明。
  function describePendingEvent(event, now = new Date()) {
    const when = formatHandoffDateTime(event?.created_at, now);
    const quantity = Math.max(1, Number(event?.quantity || 1));
    return {
      id: event?.id ?? null,
      when,
      quantity,
      text: when
        ? `${when} に「渡した」と記録されています。数量：${quantity}冊`
        : `「渡した」の記録があります。数量：${quantity}冊`,
    };
  }

  const api = {
    TIME_ZONE,
    formatHandoffDateTime,
    pendingEventsForBarcode,
    describePendingEvent,
  };

  if (typeof window !== "undefined") {
    window.KoreMotteruHandoffEvents = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
