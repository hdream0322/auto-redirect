import test from "node:test";
import assert from "node:assert/strict";
import { installChromeStub } from "./chrome-stub.mjs";

const env = installChromeStub();
const S = await import("../storage.js");

const rule = (o) => S.normalizeRule(o);
const many = (n, f = (i) => ({ from: `s${i}.example.com`, to: `https://t${i}.example.org/some/long/path`, mode: "site" })) =>
  Array.from({ length: n }, (_, i) => f(i));

test("청크 저장/복원 라운드트립", async () => {
  await env.clear();
  await S.saveRules(many(200));
  const meta = env.sync.redirectRules_meta;
  assert.equal(meta.count, 200);
  assert.ok(Number.isInteger(meta.len) && Number.isInteger(meta.rev));

  const r = await S.loadRules();
  assert.equal(r.ok, true);
  assert.equal(r.rules.length, 200);
  assert.equal(r.rules[199].from, "s199.example.com");
});

test("청크가 줄면 남는 조각을 지운다", async () => {
  await env.clear();
  await S.saveRules(many(200));
  await S.saveRules(many(3));
  const chunks = Object.keys(env.sync).filter((k) => /^redirectRules_\d+$/.test(k));
  assert.equal(chunks.length, 1);
});

test("조각이 덜 도착하면 빈 배열이 아니라 실패를 알린다", async () => {
  await env.clear();
  await S.saveRules(many(200));
  const stash = env.sync.redirectRules_1;
  delete env.sync.redirectRules_1;

  const r = await S.loadRules();
  assert.equal(r.ok, false);
  assert.equal(r.rules, null);
  assert.match(r.reason, /조각/);

  env.sync.redirectRules_1 = stash;
  assert.equal((await S.loadRules()).ok, true);
});

test("길이·개수가 어긋나면 실패를 알린다", async () => {
  await env.clear();
  await S.saveRules(many(200));
  const meta = env.sync.redirectRules_meta;

  env.sync.redirectRules_meta = { ...meta, len: meta.len - 1 };
  assert.equal((await S.loadRules()).ok, false);

  env.sync.redirectRules_meta = { ...meta, count: 199 };
  assert.equal((await S.loadRules()).ok, false);

  env.sync.redirectRules_meta = meta;
  assert.equal((await S.loadRules()).ok, true);
});

test("한글 주소도 조각이 8192 byte 를 넘지 않는다", async () => {
  await env.clear();
  await S.saveRules(
    many(40, (i) => ({
      from: `한글도메인${i}.한국/경로/아주아주긴한글경로세그먼트`,
      to: `https://대상${i}.한국/목적지/한글경로`,
      mode: "prefix",
    }))
  );
  const chunks = Object.keys(env.sync).filter((k) => /^redirectRules_\d+$/.test(k));
  for (const k of chunks) {
    assert.ok(Buffer.byteLength(env.sync[k], "utf8") <= 8192, `${k} 가 8KB 를 넘음`);
  }
  const r = await S.loadRules();
  assert.equal(r.ok, true);
  assert.ok(r.rules[7].from.includes("한글도메인7"));
});

test("rev 낙관적 잠금", async () => {
  await env.clear();
  await S.saveRules(many(2));
  const cur = await S.loadRules();

  await S.saveRules(cur.rules, cur.rev); // 다른 창이 먼저 저장
  await assert.rejects(
    () => S.saveRules(cur.rules, cur.rev),
    (e) => e.code === "rev-conflict"
  );

  const fresh = await S.loadRules();
  await S.saveRules(fresh.rules, fresh.rev); // 다시 읽으면 통과
});

test("용량 초과는 한국어 안내로 사전 차단", async () => {
  await env.clear();
  await assert.rejects(
    () => S.saveRules(many(5000, (i) => ({ from: `x${i}.example.com/${"a".repeat(40)}`, to: "https://y.example.org/b", mode: "prefix" }))),
    /한도/
  );
  assert.equal(S.MAX_CHUNKS, 15);
});

test("옛 단일 키 마이그레이션", async () => {
  await env.clear();
  env.sync.redirectRules = [{ from: "naver.com", to: "https://daum.net", mode: "site" }];
  assert.equal(await S.migrateIfNeeded(), true);
  assert.ok(!("redirectRules" in env.sync));
  assert.equal((await S.loadRules()).rules.length, 1);
});

test("뒤늦게 온 옛 키는 중복을 빼고 병합한다", async () => {
  await env.clear();
  await S.saveRules([{ from: "a.com", to: "https://b.com", mode: "site" }]);
  env.sync.redirectRules = [
    { from: "a.com", to: "https://b.com", mode: "site" },
    { from: "c.com", to: "https://d.com", mode: "site" },
  ];
  await S.migrateIfNeeded();
  const r = await S.loadRules();
  assert.equal(r.rules.length, 2);
  assert.ok(r.rules.some((x) => x.from === "c.com"));
  assert.ok(!("redirectRules" in env.sync));
});

test("무한 리다이렉트는 다섯 방식 모두에서 막는다", () => {
  const loops = (o) => S.wouldLoopRule(rule(o));
  assert.equal(loops({ mode: "site", from: "naver.com", to: "https://m.naver.com" }), true);
  assert.equal(loops({ mode: "prefix", from: "https://old.example.com/blog/", to: "https://www.old.example.com/blog/x" }), true);
  assert.equal(loops({ mode: "replace", from: "https://x.com/a/", to: "https://x.com/a/b/" }), true);
  assert.equal(loops({ mode: "exact", from: "https://x.com/a/", to: "http://www.x.com/a" }), true);
  assert.equal(loops({ mode: "regex", from: "^https?://x\\.com/old/(.*)$", to: "https://x.com/old/\\1?v=2" }), true);

  assert.equal(loops({ mode: "prefix", from: "https://old.example.com/blog/", to: "https://new.example.com/" }), false);
  assert.equal(loops({ mode: "replace", from: "https://wiki.b.com/en/", to: "https://wiki.b.com/ko/" }), false);
  assert.equal(loops({ mode: "regex", from: "^https?://(?:www\\.)?youtube\\.com/shorts/(.*)$", to: "https://www.youtube.com/watch?v=\\1" }), false);
});

test("포트와 www 처리", () => {
  assert.match(S.buildRegexFilter(rule({ mode: "prefix", from: "https://ex.com/a" })), /\(\?::\\d\+\)\?/);
  assert.ok(S.buildRegexFilter(rule({ mode: "prefix", from: "https://ex.com:8080/a" })).includes(":8080"));

  const f = new RegExp(S.buildRegexFilter(rule({ mode: "exact", from: "https://ex.com/a/" })));
  assert.equal(f.test("http://www.ex.com/a"), true);
  assert.equal(f.test("https://ex.com/a/"), true);
  assert.equal(f.test("https://ex.com/a/b"), false);
});

test("자정을 넘기는 시간대는 시작한 날의 요일로 본다", () => {
  const at = (d, h, m) => new Date(2026, 8, d, h, m); // 2026-09-11 = 금요일
  const fri = { days: [5], start: "22:00", end: "02:00" };
  assert.equal(S.scheduleActive(fri, at(11, 23, 0)), true); // 금 23:00
  assert.equal(S.scheduleActive(fri, at(12, 1, 0)), true); // 토 01:00 = 전날 금 시작
  assert.equal(S.scheduleActive(fri, at(12, 23, 0)), false); // 토 23:00
  assert.equal(S.scheduleActive(fri, at(11, 1, 0)), false); // 금 01:00 = 전날 목 시작
});

test("잘못된 시각은 무시한다", () => {
  assert.equal(S.normalizeSchedule({ days: [], start: "25:00", end: "99:99" }), null);
  assert.deepEqual(S.normalizeSchedule({ days: [1], start: "09:00", end: "18:00" }), {
    days: [1],
    start: "09:00",
    end: "18:00",
  });
});

test("만료된 스누즈 키는 지운다", async () => {
  await env.clear();
  env.sync.redirectSnooze = { until: Date.now() - 1000 };
  assert.equal(await S.loadSnooze(), null);
  assert.ok(!("redirectSnooze" in env.sync));
});

test("스누즈에 spec 을 넣으면 함께 저장·복원된다", async () => {
  await env.clear();
  const until = Date.now() + 60000;
  await S.saveSnooze(until, "15");
  assert.deepEqual(env.sync.redirectSnooze, { until, spec: "15" });
  assert.deepEqual(await S.loadSnooze(), { until, spec: "15" });

  // spec 없이 저장하면 기존 형태 그대로(하위호환)
  await S.saveSnooze(until);
  assert.deepEqual(env.sync.redirectSnooze, { until });

  // 해제
  await S.saveSnooze(null);
  assert.ok(!("redirectSnooze" in env.sync));
});
