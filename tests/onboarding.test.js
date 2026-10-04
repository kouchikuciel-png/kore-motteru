const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const onboarding = require("../onboarding.js");

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    keys: () => [...data.keys()],
  };
}

function handoffUiFingerprint() {
  // handoff-ui.js（呼び名の端末保存）の tokenFingerprint をそのまま取り出して比べる。
  const source = fs.readFileSync(path.join(__dirname, "..", "handoff-ui.js"), "utf8");
  const match = source.match(/function tokenFingerprint\(value\) \{[\s\S]*?\n  \}/);
  assert.ok(match, "handoff-ui.js に tokenFingerprint がある");
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${match[0]}; this.fingerprint = tokenFingerprint;`, context);
  return context.fingerprint;
}

test("共有先の指紋は呼び名の端末保存と同じ計算で、トークンそのものは保存キーに入らない", () => {
  const reference = handoffUiFingerprint();
  for (const token of ["kmtg_abc_123", "legacy-shop-token", ""]) {
    assert.equal(onboarding.tokenFingerprint(token), reference(token));
  }
  const key = onboarding.guestStorageKey("kmtg_secret_token_value");
  assert.ok(key.startsWith(onboarding.GUEST_KEY_PREFIX));
  assert.equal(key.includes("kmtg_secret_token_value"), false);
});

test("家族向け案内は共有先ごとに「表示済み」を覚える", () => {
  const storage = memoryStorage();
  assert.equal(onboarding.guestOnboardingSeen(storage, "token-a"), false);
  onboarding.markGuestOnboardingSeen(storage, "token-a");
  assert.equal(onboarding.guestOnboardingSeen(storage, "token-a"), true, "同じ共有先では次回から自動表示しない");
  assert.equal(onboarding.guestOnboardingSeen(storage, "token-b"), false, "別の共有先では初回として表示する");
});

test("家主向け案内は完了後、または以前「次回から表示しない」を選んだ端末では自動表示しない", () => {
  const fresh = memoryStorage();
  assert.equal(onboarding.ownerOnboardingDone(fresh), false);
  onboarding.markOwnerOnboardingDone(fresh);
  assert.equal(onboarding.ownerOnboardingDone(fresh), true);

  const legacy = memoryStorage({ [onboarding.OWNER_LEGACY_DISMISSED_KEY]: "1" });
  assert.equal(onboarding.ownerOnboardingDone(legacy), true);
});

test("端末保存が使えない（プライベートモード等）でも例外にせず、表示済みでない扱いにする", () => {
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.equal(onboarding.guestOnboardingSeen(broken, "t"), false);
  assert.equal(onboarding.markGuestOnboardingSeen(broken, "t"), false);
  assert.equal(onboarding.ownerOnboardingDone(broken), false);
  assert.equal(onboarding.ownerOnboardingDone(null), false);
});

test("表示文は Issue #42 の文案どおりで、技術用語を使わない", () => {
  const guest = onboarding.GUEST_COPY;
  assert.equal(guest.title, "このページでできること");
  assert.equal(guest.lead, "この家に登録されている本を見たり、買う前に同じ本がないか確認できます。");
  assert.deepEqual(guest.items.map((item) => item.title), ["家にある本を見る", "買う前に確認する", "渡した本を記録する"]);
  assert.equal(guest.note, "インストールは不要です。この専用QR・リンクから開けます。");
  assert.equal(guest.cta, "持ってるものを見る");

  const owner = onboarding.OWNER_COPY;
  assert.deepEqual(owner.items.map((item) => item.title), ["家の本を登録する", "家族に専用QRを渡す", "受け取った本を確認する"]);
  assert.equal(owner.cta, "本を登録してみる");

  const allText = JSON.stringify([guest, owner]);
  for (const word of ["ISBN", "JAN", "RPC", "Owner", "Guest", "ゲスト", "オーナー", "トークン"]) {
    assert.equal(allText.includes(word), false, `「${word}」を使わない`);
  }
});

test("手順の表示は番号つきで、文中のHTMLを無害化する", () => {
  const html = onboarding.stepsHtml([{ title: "<b>見る</b>", text: "a & b" }]);
  assert.match(html, /<ol class="onboarding-steps">/);
  assert.match(html, /&lt;b&gt;見る&lt;\/b&gt;/);
  assert.match(html, /a &amp; b/);
});
