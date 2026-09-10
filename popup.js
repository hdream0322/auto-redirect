const STORAGE_KEY = "redirectRules";
const ENABLED_KEY = "redirectEnabled";

const masterEl = document.getElementById("master");
const wordmarkEl = document.getElementById("wordmark");
const stateEl = document.getElementById("state");
const countEl = document.getElementById("count");

function withScheme(value) {
  const v = String(value || "").trim();
  if (/^https?:\/\//i.test(v)) return v;
  return "https://" + v.replace(/^\/+/, "");
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function ruleActive(r) {
  if (r.enabled === false || !r.from || !r.to) return false;
  if (!isHttpUrl(withScheme(r.to))) return false;
  if (r.mode === "site") {
    try {
      return new URL(withScheme(r.from)).hostname.includes(".");
    } catch {
      return false;
    }
  }
  return isHttpUrl(withScheme(r.from)) && withScheme(r.from) !== withScheme(r.to);
}

function paint(enabled, rules) {
  const active = rules.filter(ruleActive).length;

  masterEl.setAttribute("aria-checked", String(enabled));
  wordmarkEl.setAttribute("data-on", String(enabled));

  if (enabled) {
    stateEl.innerHTML =
      active > 0
        ? `<b>리다이렉트 작동 중</b> — 저장한 규칙에 맞는 주소로 자동 이동합니다.`
        : `<b>켜짐</b> — 아직 사용 중인 규칙이 없습니다. 아래에서 규칙을 추가하세요.`;
  } else {
    stateEl.innerHTML = `<b>꺼짐</b> — 규칙은 그대로 두고 리다이렉트만 잠시 멈춥니다.`;
  }
  countEl.textContent = `사용 중인 규칙 ${active}개 / 저장된 규칙 ${rules.length}개`;
}

async function load() {
  const data = await chrome.storage.sync.get([STORAGE_KEY, ENABLED_KEY]);
  const rules = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  paint(data[ENABLED_KEY] !== false, rules);
}

masterEl.addEventListener("click", async () => {
  const next = masterEl.getAttribute("aria-checked") !== "true";
  await chrome.storage.sync.set({ [ENABLED_KEY]: next });
  load();
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// 다른 창(옵션 페이지 등)에서 바꾼 값도 즉시 반영
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes[STORAGE_KEY] || changes[ENABLED_KEY])) load();
});

load();
