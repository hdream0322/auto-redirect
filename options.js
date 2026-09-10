const STORAGE_KEY = "redirectRules";
const ENABLED_KEY = "redirectEnabled";

const MODE_HINT = {
  site: "그 사이트면 www·하위 도메인·경로 상관없이 전부 대상 주소로 이동합니다.",
  exact: "주소가 똑같은 그 페이지 하나만 이동합니다 (http/https, 끝 / 무시).",
  prefix: "원본 주소로 시작하는 모든 페이지를 대상 한 곳으로 모읍니다.",
  replace: "원본으로 시작하면 앞부분만 대상으로 바꾸고 뒤 경로는 유지합니다.",
};

const rulesEl = document.getElementById("rules");
const statusEl = document.getElementById("status");
const masterEl = document.getElementById("master");
const masterLabelEl = document.getElementById("masterLabel");
const wordmarkEl = document.getElementById("wordmark");

let statusTimer;

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

// 도메인 전체 방식은 "naver.com" 같은 host 만 넣어도 유효하다.
function isValidFrom(value, mode) {
  const v = value.trim();
  if (!v) return true;
  if (mode === "site") {
    try {
      const h = new URL(withScheme(v)).hostname;
      return h.includes(".") && !/\s/.test(h);
    } catch {
      return false;
    }
  }
  return isHttpUrl(withScheme(v));
}

/* ── 규칙 행 ─────────────────────────────────────────── */
function ruleRow(rule = { from: "", to: "", mode: "site", enabled: true }) {
  const div = document.createElement("div");
  div.className = "rule";
  div.innerHTML = `
    <input type="text" class="from" placeholder="naver.com" />
    <span class="arrow" aria-hidden="true">→</span>
    <input type="text" class="to" placeholder="https://daum.net" />
    <select class="mode" aria-label="매칭 방식">
      <option value="site">도메인 전체</option>
      <option value="exact">정확히 일치</option>
      <option value="prefix">접두사 일치</option>
      <option value="replace">부분 치환</option>
    </select>
    <span class="enabled-cell">
      <button type="button" class="master sm enabled" role="switch" aria-label="이 규칙 사용"></button>
    </span>
    <button type="button" class="del" aria-label="규칙 삭제" title="삭제">&times;</button>
    <span class="rule-hint"></span>
  `;

  const from = div.querySelector(".from");
  const to = div.querySelector(".to");
  const enabled = div.querySelector(".enabled");
  const mode = div.querySelector(".mode");
  const hint = div.querySelector(".rule-hint");

  from.value = rule.from || "";
  to.value = rule.to || "";
  mode.value = rule.mode || "site";
  enabled.setAttribute("aria-checked", String(rule.enabled !== false));

  const paintHint = () => {
    hint.textContent = MODE_HINT[mode.value] || "";
    from.placeholder = mode.value === "site" ? "naver.com" : "https://old.example.com/";
  };
  const validate = () => {
    const bad =
      !isValidFrom(from.value, mode.value) ||
      (to.value.trim() && !isHttpUrl(withScheme(to.value.trim())));
    div.classList.toggle("invalid", Boolean(bad));
  };
  from.addEventListener("input", validate);
  to.addEventListener("input", validate);
  mode.addEventListener("change", () => {
    paintHint();
    validate();
  });
  paintHint();
  validate();

  enabled.addEventListener("click", () => {
    const next = enabled.getAttribute("aria-checked") !== "true";
    enabled.setAttribute("aria-checked", String(next));
  });
  div.querySelector(".del").addEventListener("click", () => div.remove());

  return div;
}

function render(rules) {
  rulesEl.replaceChildren();
  if (!rules.length) {
    rulesEl.appendChild(ruleRow());
    return;
  }
  rules.forEach((r) => rulesEl.appendChild(ruleRow(r)));
}

function collect() {
  return [...rulesEl.querySelectorAll(".rule")]
    .map((el) => ({
      from: el.querySelector(".from").value.trim(),
      to: el.querySelector(".to").value.trim(),
      mode: el.querySelector(".mode").value,
      enabled: el.querySelector(".enabled").getAttribute("aria-checked") === "true",
    }))
    .filter((r) => r.from || r.to);
}

function showStatus(text, kind = "") {
  clearTimeout(statusTimer);
  statusEl.textContent = text;
  statusEl.className = kind;
  if (text) statusTimer = setTimeout(() => (statusEl.textContent = ""), 4000);
}

/* ── 마스터 스위치 ───────────────────────────────────── */
function paintMaster(enabled) {
  masterEl.setAttribute("aria-checked", String(enabled));
  masterLabelEl.textContent = enabled ? "켜짐" : "꺼짐";
  wordmarkEl.setAttribute("data-on", String(enabled));
}

masterEl.addEventListener("click", async () => {
  const next = masterEl.getAttribute("aria-checked") !== "true";
  paintMaster(next);
  await chrome.storage.sync.set({ [ENABLED_KEY]: next });
  showStatus(next ? "자동 리다이렉트를 켰습니다." : "자동 리다이렉트를 껐습니다.", "ok");
});

/* ── 저장 / 되돌리기 / 추가 ──────────────────────────── */
document.getElementById("add").addEventListener("click", () => {
  const row = ruleRow();
  rulesEl.appendChild(row);
  row.querySelector(".from").focus();
});

document.getElementById("revert").addEventListener("click", load);

document.getElementById("save").addEventListener("click", async () => {
  const rules = collect();
  const invalid = rules.filter(
    (r) => !isValidFrom(r.from, r.mode) || !r.from || !isHttpUrl(withScheme(r.to))
  ).length;
  try {
    await chrome.storage.sync.set({ [STORAGE_KEY]: rules });
    if (invalid) {
      showStatus(`저장했지만 주소 형식이 아닌 규칙 ${invalid}개는 적용되지 않습니다.`, "err");
    } else {
      showStatus("저장했습니다. 바로 적용됩니다.", "ok");
    }
  } catch (e) {
    showStatus("저장 실패 — " + e.message, "err");
  }
});

/* ── 초기 로드 ──────────────────────────────────────── */
async function load() {
  const data = await chrome.storage.sync.get([STORAGE_KEY, ENABLED_KEY]);
  paintMaster(data[ENABLED_KEY] !== false);
  render(Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : []);
  showStatus("");
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[ENABLED_KEY]) {
    paintMaster(changes[ENABLED_KEY].newValue !== false);
  }
});

load();
