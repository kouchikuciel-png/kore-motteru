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
