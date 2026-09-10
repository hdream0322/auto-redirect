// 저장된 규칙을 declarativeNetRequest 동적 규칙으로 변환해 적용한다.

import {
  loadRules,
  loadGroups,
  loadEnabled,
  loadSnooze,
  migrateIfNeeded,
  rulesChanged,
  settingsChanged,
  ruleIsValid,
  buildRegexFilter,
  forgivingPrefixRegex,
  setNotice,
  escapeRegex,
  withScheme,
  hostOf,
} from "./storage.js";

const SCHEDULE_ALARM = "ar-schedule"; // 시간 조건 확인용 1분 주기 알람
const SNOOZE_ALARM = "ar-snooze"; // 스누즈 만료 알람

// 규칙마다 10칸짜리 우선순위 대역을 준다.
// 대역 안에서 redirect 는 아래(+0), 그 규칙의 제외(allow)는 위(+5)에 놓아
// "같은 규칙의 redirect 만" 이기고 다른 규칙 대역은 건드리지 않게 한다.
const BAND = 10;
const ALLOW_OFFSET = 5;
const PRIORITY_BASE = 1; // DNR priority 는 1 이상이어야 한다.

// 좁은 범위일수록 먼저 적용되도록: exact > replace > regex > prefix > site.
const MODE_WEIGHT = { exact: 4, replace: 3, regex: 2, prefix: 1, site: 0 };

const MAX_DYNAMIC =
  chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES || 5000;
const MAX_REGEX = chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES || 1000;

/* ── 규칙 빌드 ────────────────────────────────────────── */

// 제외 패턴(부분 문자열 또는 * 글롭)을 regexFilter 로 바꾼다.
function globToRegex(pattern) {
  return escapeRegex(pattern).replace(/\\\*/g, ".*");
}

// mode 가중치 → 원본 주소 길이 → 원래 배열 순서로 정렬한다(동률 없는 안정 정렬).
function orderRules(rules) {
  return rules
    .map((rule, idx) => ({ rule, idx }))
    .sort(
      (a, b) =>
        MODE_WEIGHT[b.rule.mode] - MODE_WEIGHT[a.rule.mode] ||
        (b.rule.from || "").length - (a.rule.from || "").length ||
        a.idx - b.idx
    )
    .map((x) => x.rule);
}

function buildRedirectRule(rule, id, priority) {
  const base = {
    id,
    priority,
    condition: { resourceTypes: ["main_frame"] },
  };

  if (rule.mode === "site") {
    // 도메인 전체: scheme·www·하위 도메인·경로 상관없이 해당 사이트면 무조건 대상으로 보낸다.
    // 예) naver.com  ->  https://daum.net  (www.naver.com, m.naver.com, naver.com/news ... 전부)
    base.condition.requestDomains = [hostOf(rule.from)];
    base.action = { type: "redirect", redirect: { url: withScheme(rule.to) } };
    return base;
  }

  base.condition.regexFilter = buildRegexFilter(rule);

  if (rule.mode === "replace") {
    // 부분 치환: from 으로 시작하는 URL 에서 from 부분만 to 로 바꾸고 나머지 경로는 유지.
    base.action = {
      type: "redirect",
      redirect: { regexSubstitution: withScheme(rule.to).replace(/\\/g, "\\\\") + "\\1" },
    };
  } else if (rule.mode === "regex") {
    // 정규식: to 는 \1 같은 역참조를 쓰는 치환 문자열 그대로.
    base.action = { type: "redirect", redirect: { regexSubstitution: rule.to } };
  } else {
    // prefix / exact: 고정된 대상 주소로 이동.
    base.action = { type: "redirect", redirect: { url: withScheme(rule.to) } };
  }
  return base;
}

/* ── 제외 패턴 ────────────────────────────────────────── */
// DNR 의 allow 는 "그 규칙만" 이라는 개념이 없어서, priority 만으로 범위를 좁히면
// 낮은 우선순위의 다른 규칙까지 함께 막아 버린다.
// 그래서 allow 조건을 "이 규칙이 건드릴 URL 의 부분집합"이 되도록 만든다:
//   allow regexFilter = (이 규칙의 매칭 접두사) + ".*" + (제외 패턴)
// 이러면 다른 규칙이 담당하는 URL 은 애초에 매칭되지 않는다.

// scheme 과 맨 앞 www. 를 뗀 비교용 문자열.
function bare(value) {
  return String(value || "")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "");
}

// 사용자가 제외 패턴을 절대 주소로 적었으면(naver.com/admin) 이 규칙의 접두사만큼 잘라 내
// "접두사 뒤에 오는 부분"으로 바꾼다. 이렇게 해야 접두사와 겹쳐도 매칭된다.
function relativizeExclude(pattern, rule) {
  if (rule.mode === "regex") return pattern; // 접두사를 알 수 없다.

  const host = hostOf(rule.from) || "";
  let prefix = host;
  if (rule.mode !== "site") {
    try {
      const u = new URL(withScheme(rule.from));
      prefix = bare(u.host + u.pathname + u.search).replace(/\/$/, "");
    } catch {
      prefix = host;
    }
  }

  const bp = bare(pattern);
  for (const head of [prefix, host]) {
    if (head && bp.toLowerCase().startsWith(head.toLowerCase())) {
      return bp.slice(head.length) || "/";
    }
  }
  return pattern;
}

// 이 규칙이 매칭하는 URL 의 앞부분(끝 앵커 없음). allow 를 이 집합 안으로 가둔다.
function excludeBaseFilter(rule) {
  if (rule.mode === "site") {
    // requestDomains 와 같은 범위(해당 도메인 + 하위 도메인)를 정규식으로 표현.
    return "^https?://(?:[^/?#]*\\.)?" + escapeRegex(hostOf(rule.from)) + "(?::\\d+)?";
  }
  if (rule.mode === "regex") {
    // 사용자 정규식 자체가 범위를 한정한다. 끝 $ 는 뒤를 이어 붙이려고 뗀다
    // (regexEndAnchored 가 false 인 경우에만 여기 오므로 집합이 넓어지지 않는다).
    return "(?:" + String(rule.from).replace(/\$$/, "") + ")";
  }
  // prefix / replace 는 접두사 정규식이 곧 매칭 집합이다(경로가 호스트 끝을 앵커한다).
  return forgivingPrefixRegex(withScheme(rule.from));
}

// base 뒤에 제외 패턴을 붙여 allow 의 regexFilter 를 만든다.
// site 는 base 가 호스트에서 끝나 `.*` 가 뒤를 삼킬 수 있으므로
// (naver.com 규칙이 naver.com.evil.com 까지 매칭) 두 갈래로 나눠 호스트 끝을 앵커한다.
//   1) 호스트 뒤에 구분자(/?#)나 끝이 오고, 그 뒤 어딘가에 제외 패턴
//   2) 호스트 바로 뒤에 제외 패턴 (제외가 "/admin" 처럼 구분자로 시작하는 경우)
function composeAllowFilter(rule, base, excl) {
  const filter =
    rule.mode === "site"
      ? `(?:${base}(?:[/?#]|$).*${excl}|${base}${excl})`
      : base + ".*" + excl;
  // 이어 붙이며 생긴 연속 ".*" 는 하나로 줄인다(정규식 2KB 한도를 아끼려고).
  return filter.replace(/(?:\.\*){2,}/g, ".*");
}

// 끝이 .* 또는 (.*) 로 끝나면 $ 를 떼도 매칭 집합이 그대로다(가장 흔한 형태).
// 그 밖에 $ 로 끝나는 정규식은 $ 를 떼는 순간 집합이 넓어진다 — 예를 들어
// ^https?://z\.com/(foo|bar)$ 에서 $ 를 떼면 z.com/foobar/news 까지 들어온다.
const TRAILING_WILDCARD = /(?:\((?:\?:)?\.\*\)|\.\*)\$$/;

function regexEndAnchored(src) {
  return /\$$/.test(src) && !TRAILING_WILDCARD.test(src);
}

// 이 규칙이 매칭하는 모든 URL 이 공통으로 포함하는 문자열(= 접두사).
function canonicalPrefix(rule) {
  if (rule.mode === "site") return "https://" + hostOf(rule.from);
  if (rule.mode === "regex") return null;
  return withScheme(rule.from);
}

// 정확히 일치는 http/https·www·끝 / 차이까지 같은 URL 로 보므로 그 변형들도 함께 본다.
function exactVariants(rule) {
  const u = new URL(withScheme(rule.from));
  const host = u.hostname.replace(/^www\./, "") + (u.port ? ":" + u.port : "");
  const path = (u.pathname + u.search).replace(/\/$/, "");
  const out = [];
  for (const scheme of ["https://", "http://"]) {
    for (const h of [host, "www." + host]) {
      out.push(scheme + h + path, scheme + h + path + "/");
    }
  }
  return out;
}

function patternMatches(pattern, samples) {
  let re;
  try {
    re = new RegExp(globToRegex(pattern));
  } catch {
    return false; // 잘못된 패턴은 무시
  }
  return samples.some((s) => re.test(s));
}

// 제외를 반영해 이 규칙의 DNR 규칙 묶음을 만든다.
// 규칙 전체가 제외되면 null 을 돌려 아예 적용하지 않는다.
function buildRuleGroup(rule, redirectId, allowStartId, priority, notes) {
  const patterns = rule.exclude || [];
  const redirect = () => buildRedirectRule(rule, redirectId, priority);

  if (!patterns.length) return { rule, dnr: [redirect()] };

  // 정확히 일치는 대상 URL 이 하나뿐이라 빌드 시점에 판정한다 — allow 규칙이 필요 없다.
  if (rule.mode === "exact") {
    const samples = exactVariants(rule);
    return patterns.some((p) => patternMatches(p, samples)) ? null : { rule, dnr: [redirect()] };
  }

  // 끝이 $ 로 고정된 정규식은 "매칭 집합의 부분집합"이 되는 allow 를 만들 수 없다.
  // (^https?://z\.com/(foo|bar)$ 에서 $ 만 떼면 z.com/foobar/news 까지 집합이 넓어진다.)
  // 그래서 allow 를 만들지 않고, 제외가 정규식 자체에 걸리면 규칙을 끈다.
  if (rule.mode === "regex" && regexEndAnchored(rule.from)) {
    if (patterns.some((p) => patternMatches(p, [rule.from]))) return null;
    notes.push(
      `"${rule.from}" 규칙의 제외 패턴은 끝이 $ 로 고정된 정규식이라 적용하지 못했습니다. $ 를 빼거나 제외 조건을 정규식 안에 직접 넣어 주세요.`
    );
    return { rule, dnr: [redirect()] };
  }

  // 제외 패턴이 이 규칙의 접두사 자체에 걸리면 매칭되는 모든 URL 이 제외 대상이다.
  // (예: 규칙 a.com/docs/guide 에 제외 "/docs" — 사용자 의도는 규칙 끄기다.)
  const prefix = canonicalPrefix(rule);
  if (prefix && patterns.some((p) => patternMatches(p, [prefix]))) return null;

  const base = excludeBaseFilter(rule);
  const allows = [];
  for (const p of patterns) {
    const rel = relativizeExclude(p, rule);
    if (rel === "/" || rel === "") return null; // 접두사 전체가 제외 대상이다.
    allows.push({
      id: allowStartId + allows.length,
      priority: priority + ALLOW_OFFSET,
      condition: {
        regexFilter: composeAllowFilter(rule, base, globToRegex(rel)),
        resourceTypes: ["main_frame"],
      },
      action: { type: "allow" },
    });
  }

  return { rule, dnr: [redirect(), ...allows] };
}

// 유효한 규칙을 우선순위 순으로 DNR 규칙 묶음으로 바꾼다.
function buildBundles(rules, groupMap, active) {
  if (!active) return { list: [], truncated: 0, notes: [] };

  const valid = orderRules(rules.filter((r) => ruleIsValid(r, groupMap)));
  const list = [];
  const notes = [];
  let truncated = 0;
  let redirectId = 1;
  let allowId = MAX_DYNAMIC + 1; // redirect id 와 절대 겹치지 않는 대역
  let total = 0;
  let regexCount = 0;

  valid.forEach((rule, i) => {
    // 정렬 결과에서 앞에 있을수록(더 구체적일수록) 높은 우선순위를 준다.
    const priority = PRIORITY_BASE + (valid.length - 1 - i) * BAND;
    let bundle;
    try {
      bundle = buildRuleGroup(rule, redirectId, allowId, priority, notes);
    } catch (e) {
      console.warn("[Auto Redirect] 규칙 변환 실패, 건너뜀:", rule, e);
      return;
    }
    if (!bundle) return; // 제외 패턴이 규칙 전체를 덮는 경우

    const regexInBundle = bundle.dnr.filter((r) => r.condition.regexFilter).length;
    if (total + bundle.dnr.length > MAX_DYNAMIC || regexCount + regexInBundle > MAX_REGEX) {
      truncated += 1;
      return;
    }
    list.push(bundle);
    total += bundle.dnr.length;
    regexCount += regexInBundle;
    redirectId += 1;
    allowId += bundle.dnr.length - 1;
  });

  return { list, truncated, notes };
}

/* ── 적용 ─────────────────────────────────────────────── */

async function applyRules() {
  const [result, groups, masterEnabled, snooze] = await Promise.all([
    loadRules(),
    loadGroups(),
    loadEnabled(),
    loadSnooze(),
  ]);

  // 청크가 덜 동기화된 상태를 "규칙 0개"로 오인하면 리다이렉트가 통째로 사라진다.
  // 이럴 때는 기존 동적 규칙을 그대로 두고 다음 기회를 기다린다.
  if (!result.ok) {
    console.warn("[Auto Redirect] 규칙을 읽지 못해 기존 규칙을 유지합니다:", result.reason);
    await setNotice(`규칙을 읽지 못했습니다 (${result.reason}) — 동기화를 기다리는 중입니다.`);
    return;
  }

  const rules = result.rules;
  const groupMap = new Map(groups.map((g) => [g.id, g]));
  const snoozed = Boolean(snooze && snooze.until > Date.now());

  const bundles = buildBundles(rules, groupMap, masterEnabled && !snoozed);
  const addRules = bundles.list.flatMap((b) => b.dnr);

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  const rejectedFrom = [];
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (e) {
    // 규칙 하나가 잘못돼도 전체가 사라지지 않도록, 실패 시 규칙 단위로 다시 적용한다.
    // (예: 경로가 아주 긴 한글 주소는 컴파일된 정규식이 브라우저의 2KB 한도를 넘는다.)
    // redirect 가 거부되면 그 규칙의 allow 도 넣지 않는다 — 주인 없는 allow 가 남으면
    // 다른 규칙까지 계속 막아 버리기 때문이다.
    console.warn("[Auto Redirect] 일괄 적용 실패, 규칙 단위 적용으로 대체:", e);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    for (const bundle of bundles.list) {
      const [redirect, ...allows] = bundle.dnr;
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [redirect] });
      } catch (err) {
        rejectedFrom.push(bundle.rule.from);
        console.warn("[Auto Redirect] 규칙 건너뜀(제외 패턴도 함께 제외):", bundle.rule, err);
        continue; // 고아 allow 방지
      }
      for (const allow of allows) {
        try {
          await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [allow] });
        } catch (err) {
          console.warn("[Auto Redirect] 제외 패턴 건너뜀:", allow, err);
        }
      }
    }
  }

  const notes = [...bundles.notes];
  if (bundles.truncated) {
    notes.push(
      `규칙 ${bundles.truncated}개는 브라우저의 동적 규칙 개수 한도를 넘어 적용하지 못했습니다.`
    );
  }
  if (rejectedFrom.length) {
    const names = rejectedFrom.slice(0, 3).map((f) => `"${f}"`).join(", ");
    const more = rejectedFrom.length > 3 ? ` 외 ${rejectedFrom.length - 3}개` : "";
    notes.push(
      `${names}${more} 규칙은 브라우저가 거부했습니다. 주소가 아주 길거나(정규식 2KB 한도) 지원되지 않는 정규식 문법일 수 있습니다.`
    );
  }
  await setNotice(notes.join(" "));
  await syncAlarms(rules, snooze);
}

// 시간 조건이 있는 규칙이 하나라도 있을 때만 1분 주기 알람을 만든다(불필요한 웨이크 방지).
async function syncAlarms(rules, snooze) {
  if (rules.some((r) => r.schedule)) {
    const existing = await chrome.alarms.get(SCHEDULE_ALARM);
    if (!existing) chrome.alarms.create(SCHEDULE_ALARM, { periodInMinutes: 1 });
  } else {
    await chrome.alarms.clear(SCHEDULE_ALARM);
  }

  await chrome.alarms.clear(SNOOZE_ALARM);
  if (snooze && snooze.until > Date.now()) {
    chrome.alarms.create(SNOOZE_ALARM, { when: snooze.until + 500 });
  }
}

/* ── 직렬화 + 디바운스 ────────────────────────────────── */
// 저장 한 번이 onChanged 를 여러 번 부르므로, 몰아서 한 번만 그리고 순서대로 실행한다.

let queue = Promise.resolve();
let debounceTimer = null;

function scheduleApply(delay = 100) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    queue = queue.then(applyRules).catch((e) => console.warn("[Auto Redirect] 적용 실패:", e));
  }, delay);
}

async function boot() {
  try {
    await migrateIfNeeded();
  } catch (e) {
    console.warn("[Auto Redirect] 규칙 마이그레이션 실패:", e);
  }
  scheduleApply(0);
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SCHEDULE_ALARM || alarm.name === SNOOZE_ALARM) scheduleApply(0);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (rulesChanged(changes) || settingsChanged(changes)) scheduleApply();
});

// 툴바 아이콘 클릭 시에는 popup.html 이 열린다(manifest 의 default_popup).
// 팝업에서 on/off·스누즈를 토글하고, "규칙 설정" 버튼으로 옵션 페이지로 이동한다.
