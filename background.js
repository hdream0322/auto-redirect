// 저장된 규칙을 declarativeNetRequest 동적 규칙으로 변환해 적용한다.

const STORAGE_KEY = "redirectRules";
const ENABLED_KEY = "redirectEnabled"; // 확장 전체 on/off 마스터 스위치 (기본 on)

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 더 구체적인 규칙(긴 from, exact > replace > prefix)이 먼저 적용되도록 우선순위를 계산한다.
function rulePriority(rule) {
  const modeWeight = rule.mode === "exact" ? 2000000 : rule.mode === "replace" ? 1000000 : 0;
  return 1 + modeWeight + Math.min(rule.from.length, 900000);
}

function buildRule(rule, id) {
  const base = {
    id,
    priority: rulePriority(rule),
    condition: { resourceTypes: ["main_frame"] },
  };

  if (rule.mode === "replace") {
    // 부분 치환: from 으로 시작하는 URL 에서 from 부분만 to 로 바꾸고 나머지 경로는 유지
    // 예) https://wiki.bambulab.com/en/  ->  https://wiki.bambulab.com/ko/
    base.condition.regexFilter = "^" + escapeRegex(rule.from) + "(.*)$";
    base.action = {
      type: "redirect",
      redirect: { regexSubstitution: rule.to.replace(/\\/g, "\\\\") + "\\1" },
    };
  } else if (rule.mode === "prefix") {
    // 접두사 매칭: from 으로 시작하는 모든 URL 을 고정된 to 로 이동
    base.condition.regexFilter = "^" + escapeRegex(rule.from);
    base.action = { type: "redirect", redirect: { url: rule.to } };
  } else {
    // 정확히 일치
    base.condition.regexFilter = "^" + escapeRegex(rule.from) + "$";
    base.action = { type: "redirect", redirect: { url: rule.to } };
  }
  return base;
}

function isRedirectableUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function applyRules() {
  const data = await chrome.storage.sync.get([STORAGE_KEY, ENABLED_KEY]);
  const rules = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  const masterEnabled = data[ENABLED_KEY] !== false; // 저장된 적 없으면 on

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  // 마스터 스위치가 꺼져 있으면 규칙을 하나도 적용하지 않는다(전부 제거만).
  const addRules = !masterEnabled ? [] : rules
    .filter(
      (r) =>
        r.enabled !== false &&
        isRedirectableUrl(r.from) &&
        isRedirectableUrl(r.to) &&
        r.from !== r.to
    )
    .map((r, i) => buildRule(r, i + 1));

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
