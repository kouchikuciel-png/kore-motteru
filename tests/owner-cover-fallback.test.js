const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "owner-cover-fallback.js"),
  "utf8"
);

// 版元ドットコムのURLは実画像が無くても白いプレースホルダーを返すことがあるため、
// 最終候補として扱う（5b2d902）。
test("keeps the Hanmoto cover as the last candidate for Japanese ISBNs", async () => {
  const context = {
    console: { warn() {} },
    fetch: async () => ({ ok: false }),
    fetchBookMetadata: async () => ({
      title: "ケチャップマン２ : せんべいやのマヨネエ",
      author: "鈴木のりたけ",
      coverUrl: "https://covers.openlibrary.org/b/isbn/9784893097576-M.jpg?default=false",
      coverUrls: ["https://covers.openlibrary.org/b/isbn/9784893097576-M.jpg?default=false"],
    }),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const metadata = await context.fetchBookMetadata("9784893097576");

  assert.equal(
    metadata.coverUrls[0],
    "https://covers.openlibrary.org/b/isbn/9784893097576-M.jpg?default=false"
  );
  assert.equal(
    metadata.coverUrls[metadata.coverUrls.length - 1],
    "https://img.hanmoto.com/bd/img/9784893097576_600.jpg"
  );
});

test("does not add Hanmoto when no title was found", async () => {
  const context = {
    console: { warn() {} },
    fetch: async () => ({ ok: false }),
    fetchBookMetadata: async () => ({ title: "", author: "", coverUrl: "", coverUrls: [] }),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const metadata = await context.fetchBookMetadata("9784141992776");

  assert.equal(
    metadata.coverUrls.some((url) => url.includes("hanmoto.com")),
    false
  );
});

test("does not add Hanmoto for non-Japanese ISBNs", async () => {
  const context = {
    console: { warn() {} },
    fetch: async () => ({ ok: false }),
    fetchBookMetadata: async () => ({
      title: "Example",
      author: "Author",
      coverUrl: "https://covers.openlibrary.org/b/isbn/9780306406157-M.jpg?default=false",
      coverUrls: ["https://covers.openlibrary.org/b/isbn/9780306406157-M.jpg?default=false"],
    }),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const metadata = await context.fetchBookMetadata("9780306406157");

  assert.equal(
    metadata.coverUrls[0],
    "https://covers.openlibrary.org/b/isbn/9780306406157-M.jpg?default=false"
  );
});
