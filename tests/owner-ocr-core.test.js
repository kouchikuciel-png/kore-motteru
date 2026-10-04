const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractValidIsbn,
  isValidIsbn13,
  normalizeOcrDigits,
} = require("../owner-ocr-core.js");

test("extracts a printed ISBN with spaces and hyphens", () => {
  assert.equal(extractValidIsbn("ISBN 978-4-19-862573-3"), "9784198625733");
});

test("extracts a digits-only ISBN", () => {
  assert.equal(extractValidIsbn("9784198625733"), "9784198625733");
});

test("repairs common OCR substitutions before checksum validation", () => {
  assert.equal(extractValidIsbn("ISBN 978-4I9-862S73-3"), "9784198625733");
  assert.equal(normalizeOcrDigits("OQD-ILZ-SGB"), "000112568");
});

test("joins a number split by OCR across lines", () => {
  assert.equal(extractValidIsbn("978-4-19-\n862573-3"), "9784198625733");
});

test("rejects non-ISBN EAN-13 and an invalid check digit", () => {
  assert.equal(extractValidIsbn("1920037017002"), null);
  assert.equal(extractValidIsbn("9784198625734"), null);
  assert.equal(isValidIsbn13("9784198625733"), true);
});

// ---- Issue #40: 書籍2段バーコードの下段（191/192…）を登録候補にしない ----

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { isBookPriceCode, maskBookPriceCodes } = require("../owner-ocr-core.js");

test("191/192 で始まる13桁は書籍の下段コードとして判定する", () => {
  assert.equal(isBookPriceCode("1920037017002"), true);
  assert.equal(isBookPriceCode("1910037017003"), true);
  assert.equal(isBookPriceCode("9784058008096"), false);
  assert.equal(isBookPriceCode("192003701700"), false, "12桁は対象外");
});

test("OCRで下段コードの数字が前後とつながって偽の978を作らない", () => {
  // 「ISBN978」までしか読めず、次の行に下段コードが来た場合。
  // 以前は全文をつなげて 9781920037017（下段の数字から作った偽ISBN）を返していた。
  assert.equal(extractValidIsbn("ISBN978\n1920037017002"), null);
  assert.equal(extractValidIsbn("1920037017002\nC0037 ¥1700E"), null);
});

test("下段コードが写っていても、上段の978/979は従来どおり採用する", () => {
  assert.equal(extractValidIsbn("ISBN978-4-05-800809-6\nC8076 ¥1700E\n1920037017002"), "9784058008096");
  assert.equal(extractValidIsbn("1920037017002\nISBN 978-4-19-862573-3"), "9784198625733");
  assert.equal(extractValidIsbn("978-4-19-\n862573-3"), "9784198625733", "改行で分かれたISBNの救済は維持");
  assert.equal(maskBookPriceCodes("ISBN 9784058008096").includes("9784058008096"), true);
});

function loadIsbnCompat() {
  const core = require("../owner-ocr-core.js");
  const context = {
    console: { warn() {} },
    fetch: async () => ({ ok: false }),
    setTimeout: () => {},
    KoreMotteruOcr: core,
    extractValidIsbn: core.extractValidIsbn,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "owner-isbn-compat.js"), "utf8"), context);
  return context;
}

test("ISBN-10 の救済でも、下段コードの数字から978を作らない", () => {
  const compat = loadIsbnCompat();
  // 1920037005405 の一部 0037005405 は ISBN-10 として有効な並びになってしまう。
  assert.equal(compat.koreMotteruIsbnCompat.isValidIsbn10("0037005405"), true);
  assert.equal(compat.window.extractValidIsbn("ISBN\n1920037005405"), null);
  assert.equal(compat.window.extractValidIsbn("ISBN 1920037005405"), null);
});

test("ISBN-10 の印字は従来どおり ISBN-13 へ変換して採用する", () => {
  const compat = loadIsbnCompat();
  assert.equal(compat.window.extractValidIsbn("ISBN4-19-862573-5"), "9784198625733");
  assert.equal(compat.window.extractValidIsbn("ISBN 4-19-862573-5\n1920037005405"), "9784198625733");
});
