const test = require("node:test");
const assert = require("node:assert/strict");

const { expandCoverCandidates, loadCoverChain } = require("../cover-chain.js");

const PROXY = "https://example.supabase.co/functions/v1/book-cover-proxy";
const proxied = (url) => `${PROXY}?src=${encodeURIComponent(url)}`;

test("coverUrls → coverUrl の順に重複なく並べ、各候補に中継版を足す", () => {
  const urls = expandCoverCandidates({
    coverUrls: [
      "http://covers.openlibrary.org/b/id/1-M.jpg",
      "https://books.google.com/books/content?id=abc&printsec=frontcover&img=1",
      "https://covers.openlibrary.org/b/id/1-M.jpg",
    ],
    coverUrl: "https://img.hanmoto.com/bd/img/9784834000825_600.jpg",
  }, PROXY);

  assert.deepEqual(urls, [
    "https://covers.openlibrary.org/b/id/1-M.jpg",
    proxied("https://covers.openlibrary.org/b/id/1-M.jpg"),
    // Google系は本登録・本棚と同じく中継を先に試す
    proxied("https://books.google.com/books/content?id=abc&printsec=frontcover&img=1"),
    "https://books.google.com/books/content?id=abc&printsec=frontcover&img=1",
    "https://img.hanmoto.com/bd/img/9784834000825_600.jpg",
    proxied("https://img.hanmoto.com/bd/img/9784834000825_600.jpg"),
  ]);
});

test("候補が無ければ空、中継先が無ければ元の候補だけ", () => {
  assert.deepEqual(expandCoverCandidates(null, PROXY), []);
  assert.deepEqual(expandCoverCandidates({ coverUrl: "" }, PROXY), []);
  assert.deepEqual(
    expandCoverCandidates({ coverUrls: ["https://a.example/1.jpg"] }, ""),
    ["https://a.example/1.jpg"]
  );
});

// 画像読み込みを模擬する。url → { ok, width, height }
function fakeImages(results) {
  const tried = [];
  const createImage = () => {
    const image = {};
    Object.defineProperty(image, "src", {
      set(url) {
        tried.push(url);
        const result = results[url] || { ok: false };
        queueMicrotask(() => {
          if (!result.ok) return image.onerror?.();
          image.naturalWidth = result.width ?? 300;
          image.naturalHeight = result.height ?? 400;
          image.onload?.();
        });
      },
    });
    return image;
  };
  return { createImage, tried };
}

function fakeContainer() {
  return {
    innerHTML: '<span aria-hidden="true">📚</span>',
    children: [],
    replaceChildren(node) { this.children = [node]; this.innerHTML = ""; },
  };
}

test("1候補が失敗しても📚にせず、中継候補まで順に試して成功した画像を入れる", async () => {
  const urls = ["https://a/1.jpg", proxied("https://a/1.jpg"), "https://b/2.jpg", proxied("https://b/2.jpg")];
  const { createImage, tried } = fakeImages({ [proxied("https://b/2.jpg")]: { ok: true } });
  const container = fakeContainer();
  const states = [];

  const pending = loadCoverChain(container, urls, { createImage });
  states.push(container.innerHTML);
  const result = await pending;

  assert.deepEqual(tried, urls, "失敗した候補の次へ順番に進む");
  assert.equal(result.status, "loaded");
  assert.equal(result.url, proxied("https://b/2.jpg"));
  assert.equal(container.children.length, 1);
  assert.equal(states[0], '<span aria-hidden="true">📚</span>', "成功するまでは📚のまま差し替えない");
});

test("白いダミー（小さすぎる画像）は成功扱いにせず次の候補へ進む", async () => {
  const urls = ["https://hanmoto/placeholder.jpg", "https://ol/real.jpg"];
  const { createImage, tried } = fakeImages({
    "https://hanmoto/placeholder.jpg": { ok: true, width: 1, height: 1 },
    "https://ol/real.jpg": { ok: true, width: 180, height: 260 },
  });
  const result = await loadCoverChain(fakeContainer(), urls, { createImage });
  assert.deepEqual(tried, urls);
  assert.equal(result.url, "https://ol/real.jpg");
});

test("全候補が失敗した時だけ📚にする", async () => {
  const urls = ["https://a/1.jpg", proxied("https://a/1.jpg"), "https://b/2.jpg", proxied("https://b/2.jpg")];
  const { createImage, tried } = fakeImages({});
  const container = fakeContainer();
  container.innerHTML = "loading";
  const result = await loadCoverChain(container, urls, { createImage });
  assert.deepEqual(tried, urls, "全候補を試してから");
  assert.equal(result.status, "failed");
  assert.equal(container.innerHTML, '<span aria-hidden="true">📚</span>');
});

test("画面が切り替わった後の読み込み結果は反映しない", async () => {
  let current = true;
  const { createImage } = fakeImages({ "https://a/1.jpg": { ok: true } });
  const container = fakeContainer();
  const pending = loadCoverChain(container, ["https://a/1.jpg"], { createImage, isCurrent: () => current });
  current = false;
  const result = await pending;
  assert.equal(result.status, "aborted");
  assert.equal(container.children.length, 0);
});
