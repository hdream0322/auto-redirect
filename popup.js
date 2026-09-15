import {
  loadRules,
  saveRules,
  loadGroups,
  loadEnabled,
  saveEnabled,
  loadSnooze,
  saveSnooze,
  loadNotice,
  normalizeRule,
  ruleIsValid,
  ruleShapeIsValid,
  rulesChanged,
  settingsChanged,
  withScheme,
  isHttpUrl,
  NOTICE_KEY,
} from "./storage.js";

const masterEl = document.getElementById("master");
const stateEl = document.getElementById("state");
const countEl = document.getElementById("count");
const noticeEl = document.getElementById("notice");
const snoozeStateEl = document.getElementById("snoozeState");
const snoozeClearEl = document.getElementById("snoozeClear");
const msgEl = document.getElementById("msg");

let msgTimer;

const quickToggle = document.getElementById("quickToggle");
const quickForm = document.getElementById("quickForm");
const quickSiteEl = document.getElementById("quickSite");
const quickFrom = document.getElementById("quickFrom");
const quickTo = document.getElementById("quickTo");
const quickMode = document.getElementById("quickMode");

let currentUrl = "";
let currentSnooze = null;

const snoozeBtns = [...document.querySelectorAll("[data-snooze]")];

function showMsg(text, kind = "") {
  clearTimeout(msgTimer);
  msgEl.textContent = text;
  msgEl.className = kind;
  if (text) msgTimer = setTimeout(() => (msgEl.textContent = ""), 5000);
}

function paintNotice(text) {
  noticeEl.textContent = text || "";
  noticeEl.hidden = !text;
}

function paint(enabled, rules, groups, snooze) {
  const groupMap = new Map(groups.map((g) => [g.id, g]));
  // background 와 똑같은 판정을 쓴다(그룹 off·시간 조건·무한 루프 모두 반영).
  const active = rules.filter((r) => ruleIsValid(r, groupMap)).length;
  const snoozed = Boolean(snooze && snooze.until > Date.now());

  masterEl.setAttribute("aria-checked", String(enabled));

  if (snoozed) {
    stateEl.innerHTML = `<b>일시 정지 중</b> — 규칙은 그대로 두고 잠시만 쉬고 있습니다.`;
  } else if (enabled) {
    stateEl.innerHTML =
      active > 0
        ? `<b>리다이렉트 작동 중</b> — 저장한 규칙에 맞는 주소로 자동 이동합니다.`
        : `<b>켜짐</b> — 지금 적용 중인 규칙이 없습니다. 아래에서 규칙을 추가하세요.`;
  } else {
    stateEl.innerHTML = `<b>꺼짐</b> — 규칙은 그대로 두고 리다이렉트만 잠시 멈춥니다.`;
  }
  countEl.textContent = `지금 적용 중인 규칙 ${active}개 / 저장된 규칙 ${rules.length}개`;

  const activeSpec = snoozed ? snooze.spec : null;
  snoozeBtns.forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.snooze === activeSpec));
  });

  if (snoozed) {
    const mins = Math.ceil((snooze.until - Date.now()) / 60000);
    const text = mins >= 60 ? `${Math.floor(mins / 60)}시간 ${mins % 60}분` : `${mins}분`;
    snoozeStateEl.textContent =
      `${text} 후 다시 켜집니다` + (activeSpec ? " · 같은 버튼을 다시 누르면 해제" : "");
    snoozeStateEl.hidden = false;
    snoozeClearEl.hidden = false;
  } else {
    snoozeStateEl.hidden = true;
    snoozeClearEl.hidden = true;
  }
}

async function load() {
  const [result, groups, enabled, snooze, notice] = await Promise.all([
    loadRules(),
    loadGroups(),
    loadEnabled(),
    loadSnooze(),
    loadNotice(),
  ]);

  paintNotice(notice);

  // 청크가 덜 동기화된 상태에서 "규칙 0개"라고 말하거나 그 위에 덧쓰면 안 된다.
  if (!result.ok) {
    masterEl.setAttribute("aria-checked", String(enabled));
    stateEl.innerHTML = `<b>규칙을 불러오지 못했습니다</b> — 동기화를 기다리는 중입니다. 잠시 뒤 다시 열어 주세요.`;
    countEl.textContent = "";
    quickToggle.disabled = true;
    return;
  }

  quickToggle.disabled = false;
  currentSnooze = snooze && snooze.until > Date.now() ? snooze : null;
  paint(enabled, result.rules, groups, snooze);
}

masterEl.addEventListener("click", async () => {
  const next = masterEl.getAttribute("aria-checked") !== "true";
  await saveEnabled(next);
  load();
});

/* ── 스누즈 ───────────────────────────────────────────── */

function snoozeUntil(spec) {
  if (spec === "today") {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }
  return Date.now() + Number(spec) * 60000;
}

snoozeBtns.forEach((btn) => {
  btn.addEventListener("click", async () => {
    const spec = btn.dataset.snooze;
    // 지금 그 버튼으로 멈춰 있으면 같은 버튼이 해제 토글이 된다.
    if (currentSnooze && currentSnooze.spec === spec) {
      await saveSnooze(null);
    } else {
      await saveSnooze(snoozeUntil(spec), spec);
    }
    load();
  });
});

snoozeClearEl.addEventListener("click", async () => {
  await saveSnooze(null);
  load();
});

/* ── 현재 탭으로 빠른 규칙 추가 ──────────────────────── */

// activeTab 권한으로 팝업을 연 순간의 활성 탭 주소만 읽는다.
async function currentTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url || "";
  } catch {
    return "";
  }
}

// 방식에 맞춰 원본 주소 기본값을 만든다.
function defaultFrom(url, mode) {
  try {
    const u = new URL(url);
    if (mode === "site") return u.hostname.replace(/^www\./, "");
    if (mode === "exact") return u.origin + u.pathname + u.search;
    return u.origin + u.pathname;
  } catch {
    return "";
  }
}

quickToggle.addEventListener("click", async () => {
  if (!quickForm.hidden) {
    quickForm.hidden = true;
    return;
  }
  currentUrl = await currentTabUrl();
  if (!isHttpUrl(currentUrl)) {
    showMsg("현재 탭은 일반 웹페이지가 아니라 규칙을 만들 수 없습니다.", "err");
    return;
  }
  quickSiteEl.textContent = currentUrl;
  quickMode.value = "site";
  quickFrom.value = defaultFrom(currentUrl, "site");
  quickTo.value = "";
  quickForm.hidden = false;
  showMsg("");
  quickTo.focus();
});

quickMode.addEventListener("change", () => {
  quickFrom.value = defaultFrom(currentUrl, quickMode.value);
});

document.getElementById("quickCancel").addEventListener("click", () => {
  quickForm.hidden = true;
  showMsg("");
});

document.getElementById("quickSave").addEventListener("click", async () => {
  const from = quickFrom.value.trim();
  const to = quickTo.value.trim();
  if (!from || !to) {
    showMsg("원본 주소와 대상 주소를 모두 입력하세요.", "err");
    return;
  }
  if (!isHttpUrl(withScheme(to))) {
    showMsg("대상 주소 형식이 올바르지 않습니다.", "err");
    return;
  }

  const rule = normalizeRule({ from, to, mode: quickMode.value, enabled: true });
  if (!ruleShapeIsValid(rule)) {
    showMsg("이 조합은 무한 리다이렉트가 되거나 주소 형식이 올바르지 않습니다.", "err");
    return;
  }

  // rev 낙관적 잠금 — 그 사이 다른 곳에서 저장했으면 한 번 다시 읽어 붙인다.
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await loadRules();
    if (!result.ok) {
      showMsg("규칙을 불러오지 못해 저장할 수 없습니다. 잠시 뒤 다시 시도하세요.", "err");
      return;
    }
    try {
      await saveRules([...result.rules, rule], result.rev);
      quickForm.hidden = true;
      showMsg("규칙을 추가했습니다. 바로 적용됩니다.", "ok");
      load();
      return;
    } catch (e) {
      if (e.code === "rev-conflict" && attempt === 0) continue;
      showMsg("저장 실패 — " + e.message, "err");
      return;
    }
  }
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// 다른 창(옵션 페이지 등)에서 바꾼 값도 즉시 반영
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[NOTICE_KEY]) {
    paintNotice(changes[NOTICE_KEY].newValue?.text || "");
    return;
  }
  if (area === "sync" && (rulesChanged(changes) || settingsChanged(changes))) load();
});

load();
