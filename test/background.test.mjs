import test from "node:test";
import assert from "node:assert/strict";
import { installChromeStub, matchOutcome } from "./chrome-stub.mjs";

const env = installChromeStub();
const S = await import("../storage.js");
await import("../background.js"); // storage.onChanged 리스너를 등록한다

// 규칙을 저장하고 background 가 DNR 을 다시 만들 때까지 기다린다.
async function apply(rules, extra = {}) {
  await env.clear();
  if (extra.groups) await S.saveGroups(extra.groups);
  await S.saveRules(rules);
  await env.apply();
  return env.dnr.rules;
}

const outcome = (url) => matchOutcome(env.dnr.rules, url);
const redirectsTo = (url) => {
  const m = outcome(url);
  if (!m || m.action.type !== "redirect") return null;
  return m.action.redirect.url || m.action.redirect.regexSubstitution;
};

/* ── 제외 패턴이 다른 규칙으로 새지 않는지 (verifier leak 시나리오) ── */

test("leak: 제외를 건 규칙이 같은 호스트의 다른 규칙을 막지 않는다", async () => {
  await apply([
    { from: "https://a.com/exact", to: "https://target-a.com", mode: "exact", exclude: ["/docs"] },
    { from: "https://a.com/docs", to: "https://target-b.com", mode: "prefix" },
  ]);

  // 제외가 없는 rule#2 는 그대로 동작해야 한다.
  assert.equal(redirectsTo("https://a.com/docs/other"), "https://target-b.com");
  assert.equal(redirectsTo("https://a.com/docs"), "https://target-b.com");
  // rule#1 자체는 살아 있다.
  assert.equal(redirectsTo("https://a.com/exact"), "https://target-a.com");
});

test("leak: 정규식 규칙의 제외가 다른 도메인을 건드리지 않는다", async () => {
  await apply([
    { from: "^https?://(?:www\\.)?a\\.com/watch/(.*)$", to: "https://target-a.com/\\1", mode: "regex", exclude: ["news"] },
    { from: "other.com", to: "https://target-c.com", mode: "site" },
    { from: "a.com", to: "https://target-d.com", mode: "site" },
  ]);

  // 무관한 도메인은 전혀 영향이 없어야 한다.
  assert.equal(redirectsTo("https://other.com/news/1"), "https://target-c.com");
  // 같은 도메인이라도 그 정규식이 담당하지 않는 경로는 막히지 않는다.
  assert.equal(redirectsTo("https://a.com/news/1"), "https://target-d.com");
  // 제외는 자기 규칙 안에서만 작동한다.
  assert.equal(outcome("https://a.com/watch/news-clip").action.type, "allow");
  assert.equal(redirectsTo("https://a.com/watch/movie"), "https://target-a.com/\\1");
});

test("leak: site 규칙의 경로 제외가 다른 도메인·다른 규칙에 안 샌다", async () => {
  await apply([
    { from: "ex.com", to: "https://target-a.com", mode: "site", exclude: ["ex.com/admin"] },
    { from: "other.com", to: "https://target-b.com", mode: "site" },
  ]);

  assert.equal(outcome("https://www.ex.com/admin/page").action.type, "allow");
  assert.equal(redirectsTo("https://ex.com/anything"), "https://target-a.com");
  assert.equal(redirectsTo("https://other.com/admin/page"), "https://target-b.com");
});

test("제외 패턴을 절대 주소로 적어도 접두사와 겹쳐 매칭된다", async () => {
  await apply([
    { from: "https://a.com/docs", to: "https://target-a.com", mode: "prefix", exclude: ["a.com/docs/keep"] },
  ]);
  assert.equal(outcome("https://a.com/docs/keep/x").action.type, "allow");
  assert.equal(redirectsTo("https://a.com/docs/other"), "https://target-a.com");
});

test("leak: site 제외가 호스트 끝을 앵커해 유사 도메인을 삼키지 않는다", async () => {
  await apply([
    { from: "naver.com", to: "https://target-a.com", mode: "site", exclude: ["/news"] },
    { from: "evil.com", to: "https://target-b.com", mode: "site" },
  ]);

  // naver.com.evil.com 은 evil.com 규칙 담당이다. naver.com 의 제외가 억제하면 안 된다.
  assert.equal(redirectsTo("https://naver.com.evil.com/news/1"), "https://target-b.com");
  assert.equal(redirectsTo("https://naver.com.evil.com/home"), "https://target-b.com");
  // 진짜 naver.com 에서는 제외가 그대로 동작한다.
  assert.equal(outcome("https://naver.com/news/1").action.type, "allow");
  assert.equal(outcome("https://www.naver.com/news").action.type, "allow");
  assert.equal(outcome("https://m.naver.com/a/news").action.type, "allow");
  assert.equal(redirectsTo("https://naver.com/home"), "https://target-a.com");
});

test("leak: $ 로 앵커된 정규식 제외가 집합 밖 URL 을 억제하지 않는다", async () => {
  const rules = await apply([
    { from: "^https?://z\\.com/(foo|bar)$", to: "https://target-a.com", mode: "regex", exclude: ["news"] },
    { from: "z.com", to: "https://target-b.com", mode: "site" },
  ]);

  // redirect 가 매칭하지 않는 z.com/foobar/news 는 하위 site 규칙이 그대로 처리해야 한다.
  assert.equal(redirectsTo("https://z.com/foobar/news"), "https://target-b.com");
  assert.equal(redirectsTo("https://z.com/news"), "https://target-b.com");
  // 앵커된 정규식에는 allow 규칙을 만들지 않고 안내만 남긴다.
  assert.equal(rules.filter((r) => r.action.type === "allow").length, 0);
  assert.match(env.local.redirectNotice.text, /\$ 로 고정된 정규식/);
  assert.equal(redirectsTo("https://z.com/foo"), "https://target-a.com");
});

test("$ 앵커 정규식이라도 제외가 정규식 자체에 걸리면 규칙을 끈다", async () => {
  await apply([
    { from: "^https?://z\\.com/(foo|bar)$", to: "https://target-a.com", mode: "regex", exclude: ["foo"] },
  ]);
  assert.equal(env.dnr.rules.length, 0);
});

test("제외가 자기 경로 접두사와 겹치면 규칙을 통째로 끈다", async () => {
  await apply([
    { from: "https://a.com/docs/guide", to: "https://target-a.com", mode: "prefix", exclude: ["/docs"] },
    { from: "a.com", to: "https://target-b.com", mode: "site" },
  ]);

  // 조용히 무의미해지지 않고 규칙이 꺼진다 → 하위 site 규칙이 처리한다.
  assert.equal(env.dnr.rules.filter((r) => r.action.type === "allow").length, 0);
  assert.equal(redirectsTo("https://a.com/docs/guide/x"), "https://target-b.com");
});

test("글롭 * 제외", async () => {
  await apply([{ from: "ex.com", to: "https://target-a.com", mode: "site", exclude: ["*/login*"] }]);
  assert.equal(outcome("https://ex.com/login?x=1").action.type, "allow");
  assert.equal(redirectsTo("https://ex.com/home"), "https://target-a.com");
});

test("정확히 일치는 제외를 빌드 시점에 판정해 allow 규칙을 만들지 않는다", async () => {
  const rules = await apply([
    { from: "https://a.com/one", to: "https://target-a.com", mode: "exact", exclude: ["/one"] },
    { from: "https://a.com/two", to: "https://target-b.com", mode: "exact", exclude: ["/zzz"] },
  ]);
  assert.equal(rules.filter((r) => r.action.type === "allow").length, 0);
  assert.equal(outcome("https://a.com/one"), null); // 규칙 전체가 제외됨
  assert.equal(redirectsTo("https://a.com/two"), "https://target-b.com");
});

test("접두사 전체를 덮는 제외는 규칙을 통째로 끈다", async () => {
  await apply([{ from: "ex.com", to: "https://target-a.com", mode: "site", exclude: ["ex.com"] }]);
  assert.equal(env.dnr.rules.length, 0);
});

/* ── 우선순위 · id ── */

test("우선순위는 방식 → 주소 길이 → 저장 순서, 동률 없음", async () => {
  const rules = await apply([
    { from: "https://ex.com/exact", to: "https://a.com", mode: "exact" },
    { from: "ex.com", to: "https://b.com", mode: "site" },
    { from: "https://ex.com/pre/", to: "https://c.com", mode: "prefix" },
  ]);
  const p = (needle) => rules.find((r) => JSON.stringify(r).includes(needle)).priority;
  assert.ok(p("/exact") > p("/pre/"));
  assert.ok(p("/pre/") > p("requestDomains"));
  assert.equal(new Set(rules.map((r) => r.priority)).size, rules.length);
});

test("allow id 는 redirect id 대역과 겹치지 않는다", async () => {
  const rules = await apply([
    { from: "ex.com", to: "https://a.com", mode: "site", exclude: ["/x"] },
  ]);
  const redirect = rules.find((r) => r.action.type === "redirect");
  const allow = rules.find((r) => r.action.type === "allow");
  assert.ok(redirect.id <= 5000);
  assert.ok(allow.id > 5000);
  assert.equal(allow.priority, redirect.priority + 5);
});

/* ── 그룹 · 스누즈 · 시간 조건 ── */

test("꺼진 그룹의 규칙은 제외된다", async () => {
  await apply(
    [
      { from: "a.com", to: "https://x.com", mode: "site", groupId: "g1" },
      { from: "b.com", to: "https://y.com", mode: "site" },
    ],
    { groups: [{ id: "g1", name: "업무", enabled: false }] }
  );
  assert.equal(outcome("https://a.com/"), null);
  assert.equal(redirectsTo("https://b.com/"), "https://y.com");
});

test("스누즈 중에는 규칙을 모두 내린다", async () => {
  await apply([{ from: "a.com", to: "https://x.com", mode: "site" }]);
  assert.equal(env.dnr.rules.length, 1);
  await S.saveSnooze(Date.now() + 60000);
  await env.apply();
  assert.equal(env.dnr.rules.length, 0);
  assert.ok(chrome.alarms.created.has("ar-snooze"));
});

test("시간 조건 밖의 규칙은 빠지고, 있을 때만 1분 알람을 만든다", async () => {
  await apply([{ from: "a.com", to: "https://x.com", mode: "site" }]);
  assert.equal(chrome.alarms.created.has("ar-schedule"), false);

  await apply([
    { from: "a.com", to: "https://x.com", mode: "site", schedule: { days: [], start: "03:00", end: "03:01" } },
    { from: "b.com", to: "https://y.com", mode: "site" },
  ]);
  assert.equal(chrome.alarms.created.get("ar-schedule").periodInMinutes, 1);
  assert.equal(redirectsTo("https://b.com/"), "https://y.com");
  const now = new Date();
  const inWindow = now.getHours() === 3 && now.getMinutes() === 0;
  assert.equal(outcome("https://a.com/") !== null, inWindow);
});

/* ── 실패 처리 ── */

test("규칙을 읽지 못하면 기존 DNR 규칙을 유지한다", async () => {
  await apply([{ from: "a.com", to: "https://x.com", mode: "site" }]);
  const before = env.dnr.rules.length;
  assert.ok(before > 0);

  delete env.sync.redirectRules_0; // 조각이 아직 안 온 상태
  await env.apply();

  assert.equal(env.dnr.rules.length, before);
  assert.match(env.local.redirectNotice.text, /읽지 못했습니다/);
});

test("배치 실패 시 규칙 단위로 되살리고 고아 allow 를 남기지 않는다", async () => {
  await env.clear();
  await S.saveRules([
    { from: "bad.com", to: "https://x.com", mode: "site", exclude: ["/keep"] },
    { from: "good.com", to: "https://y.com", mode: "site" },
  ]);
  // bad.com 의 redirect 만 브라우저가 거부하는 상황
  env.dnr.reject = (r) => r.action.type === "redirect" && r.condition.requestDomains?.[0] === "bad.com";
  await env.apply();

  assert.equal(env.dnr.rules.some((r) => r.condition.requestDomains?.[0] === "bad.com"), false);
  assert.equal(env.dnr.rules.some((r) => r.action.type === "allow"), false, "고아 allow 가 남았다");
  assert.equal(redirectsTo("https://good.com/"), "https://y.com");
  assert.match(env.local.redirectNotice.text, /"bad\.com"/);
});

test("onChanged 가 연달아 와도 한 번만 적용한다", async () => {
  await apply([{ from: "a.com", to: "https://x.com", mode: "site" }]);
  let calls = 0;
  const orig = env.dnr.updateDynamicRules.bind(env.dnr);
  env.dnr.updateDynamicRules = async (a) => {
    calls += 1;
    return orig(a);
  };
  await env.apply();
  env.dnr.updateDynamicRules = orig;
  assert.equal(calls, 1);
});
