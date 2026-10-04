(() => {
  function isValidIsbn13(value) {
    const isbn = String(value || "");
    if (!/^97[89]\d{10}$/.test(isbn)) return false;

    let sum = 0;
    for (let i = 0; i < 12; i += 1) {
      sum += Number(isbn[i]) * (i % 2 === 0 ? 1 : 3);
    }
    return ((10 - (sum % 10)) % 10) === Number(isbn[12]);
  }

  function normalizeOcrDigits(value) {
    const substitutions = {
      O: "0",
      Q: "0",
      D: "0",
      I: "1",
      L: "1",
      Z: "2",
      S: "5",
      G: "6",
      B: "8",
    };

    return String(value || "")
      .normalize("NFKC")
      .toUpperCase()
      .replace(/[OQDILZSGB]/g, (character) => substitutions[character])
      .replace(/[^0-9]/g, "");
  }

  // 日本の書籍2段バーコードの下段（191/192…）は価格・分類コードで、本の識別子ではない。
  function isBookPriceCode(value) {
    return /^19[12]\d{10}$/.test(String(value || ""));
  }

  const BOOK_PRICE_CODE_SEPARATOR = "|";

  // OCR文字列から 191/192 の13桁の並びを取り除き、区切り記号に置き換える。
  // 区切り記号はISBNの数字として扱われないため、下段の数字が前後の数字とつながって
  // 別のISBN（ISBN-10 経由を含む）として拾われることがなくなる。
  function maskBookPriceCodes(text) {
    return String(text || "")
      .normalize("NFKC")
      .replace(/[0-9OQDILZSGB]+/gi, (run) =>
        isBookPriceCode(normalizeOcrDigits(run)) ? ` ${BOOK_PRICE_CODE_SEPARATOR} ` : run);
  }

  function extractValidIsbn(text) {
    const raw = maskBookPriceCodes(text);
    const lines = raw.split(/\r?\n/).filter(Boolean);

    // 行単位を先に調べることで、上下に別の番号がある本でも混線させない。
    // 最後に全文も調べ、OCRがISBNの途中で改行した場合を救済する。
    // 下段コードを取り除いた位置では数字をつながない。
    for (const candidate of [...lines, raw]) {
      for (const piece of candidate.split(BOOK_PRICE_CODE_SEPARATOR)) {
        const digits = normalizeOcrDigits(piece);
        for (let i = 0; i <= digits.length - 13; i += 1) {
          const isbn = digits.slice(i, i + 13);
          if (isValidIsbn13(isbn)) return isbn;
        }
      }
    }
    return null;
  }

  const api = {
    extractValidIsbn,
    isValidIsbn13,
    normalizeOcrDigits,
    isBookPriceCode,
    maskBookPriceCodes,
  };

  if (typeof window !== "undefined") {
    window.KoreMotteruOcr = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
