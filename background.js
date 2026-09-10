// 저장된 규칙을 declarativeNetRequest 동적 규칙으로 변환해 적용한다.

const STORAGE_KEY = "redirectRules";
const ENABLED_KEY = "redirectEnabled"; // 확장 전체 on/off 마스터 스위치 (기본 on)

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 사용자가 scheme 없이 "naver.com" 처럼 넣어도 받아 준다.
function withScheme(value) {
  const v = String(value || "").trim();
  if (/^https?:\/\//i.test(v)) return v;
  return "https://" + v.replace(/^\/+/, "");
}

// 입력값에서 host 만 뽑아 소문자로, 맨 앞 www. 는 떼어 낸다.
function hostOf(value) {
  try {
    return new URL(withScheme(value)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isRedirectableUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// 대상이 원본 도메인(또는 그 하위 도메인)이면 무한 리다이렉트가 되므로 막는다.
function wouldLoop(fromHost, toHost) {
  if (!fromHost || !toHost) return false;
  return toHost === fromHost || toHost.endsWith("." + fromHost);
}

function ruleIsValid(r) {
  if (r.enabled === false) return false;
  if (!r.from || !r.to) return false;

  if (r.mode === "site") {
    const fromHost = hostOf(r.from);
    const toHost = hostOf(r.to);
    if (!fromHost || !fromHost.includes(".") || /\s/.test(fromHost)) return false;
    if (!isRedirectableUrl(withScheme(r.to))) return false;
    if (wouldLoop(fromHost, toHost)) {
      console.warn("[Auto Redirect] 무한 리다이렉트가 되어 건너뜀:", r);
      return false;
    }
    return true;
  }

  return (
    isRedirectableUrl(withScheme(r.from)) &&
    isRedirectableUrl(withScheme(r.to)) &&
    withScheme(r.from) !== withScheme(r.to)
  );
}

// 더 구체적인 규칙이 먼저 적용되도록 우선순위를 계산한다.
// 좁은 범위일수록 높게: exact > replace > prefix > site.
function rulePriority(rule) {
  const modeWeight =
    rule.mode === "exact"
      ? 3000000
      : rule.mode === "replace"
        ? 2000000
        : rule.mode === "prefix"
          ? 1000000
          : 0; // site
  return 1 + modeWeight + Math.min((rule.from || "").length, 900000);
}

// "시작하는 URL" 계열(prefix / replace)에서 www. 와 http/https 를 너그럽게 매칭하는 정규식 조각.
function forgivingPrefixRegex(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, "");
  return "^https?://(?:www\\.)?" + escapeRegex(host) + escapeRegex(u.pathname + u.search);
}

function buildRule(rule, id) {
  const base = {
    id,
    priority: rulePriority(rule),
    condition: { resourceTypes: ["main_frame"] },
  };

  if (rule.mode === "site") {
    // 도메인 전체: scheme·www·하위 도메인·경로 상관없이 해당 사이트면 무조건 대상으로 보낸다.
    // 예) naver.com  ->  https://daum.net  (www.naver.com, m.naver.com, naver.com/news ... 전부)
    base.condition.requestDomains = [hostOf(rule.from)];
    base.action = { type: "redirect", redirect: { url: withScheme(rule.to) } };
    return base;
  }

  if (rule.mode === "replace") {
    // 부분 치환: from 으로 시작하는 URL 에서 from 부분만 to 로 바꾸고 나머지 경로는 유지.
    // 예) https://wiki.bambulab.com/en/  ->  https://wiki.bambulab.com/ko/
    base.condition.regexFilter = forgivingPrefixRegex(withScheme(rule.from)) + "(.*)$";
    base.action = {
      type: "redirect",
      redirect: { regexSubstitution: withScheme(rule.to).replace(/\\/g, "\\\\") + "\\1" },
    };
  } else if (rule.mode === "prefix") {
    // 접두사 매칭: from 으로 시작하는 모든 URL 을 고정된 to 로 이동.
    base.condition.regexFilter = forgivingPrefixRegex(withScheme(rule.from));
    base.action = { type: "redirect", redirect: { url: withScheme(rule.to) } };
  } else {
    // 정확히 일치: http/https 차이와 끝의 / 유무만 같은 것으로 보고, 그 외에는 엄격히 일치.
    const rest = withScheme(rule.from).replace(/^https?:\/\//i, "").replace(/\/$/, "");
    base.condition.regexFilter = "^https?://" + escapeRegex(rest) + "/?$";
    base.action = { type: "redirect", redirect: { url: withScheme(rule.to) } };
  }
  return base;
}

async function applyRules() {
  const data = await chrome.storage.sync.get([STORAGE_KEY, ENABLED_KEY]);
  const rules = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  const masterEnabled = data[ENABLED_KEY] !== false; // 저장된 적 없으면 on

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  // 마스터 스위치가 꺼져 있으면 규칙을 하나도 적용하지 않는다(전부 제거만).
  const addRules = !masterEnabled
    ? []
    : rules
        .filter(ruleIsValid)
        .map((r, i) => {
          try {
            return buildRule(r, i + 1);
          } catch (e) {
            console.warn("[Auto Redirect] 규칙 변환 실패, 건너뜀:", r, e);
            return null;
          }
        })
        .filter(Boolean);

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (e) {
    // 규칙 하나가 잘못돼도 전체가 사라지지 않도록, 실패 시 유효한 규칙만 한 개씩 다시 적용한다.
    console.warn("[Auto Redirect] 일괄 적용 실패, 개별 적용으로 대체:", e);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    for (const rule of addRules) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
      } catch (err) {
        console.warn("[Auto Redirect] 규칙 건너뜀:", rule, err);
      }
    }
  }
}

chrome.runtime.onInstalled.addListener(applyRules);
chrome.runtime.onStartup.addListener(applyRules);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes[STORAGE_KEY] || changes[ENABLED_KEY])) applyRules();
});

// 툴바 아이콘 클릭 시에는 popup.html 이 열린다(manifest 의 default_popup).
// 팝업에서 on/off 를 토글하고, "규칙 설정" 버튼으로 옵션 페이지로 이동한다.
