import {
  loadRules,
  saveRules,
  loadGroups,
  saveGroups,
  loadEnabled,
  saveEnabled,
  loadSnooze,
  saveSnooze,
  loadNotice,
  migrateIfNeeded,
  normalizeRule,
  normalizeGroup,
  newGroupId,
  rulesChanged,
  ruleShapeIsValid,
  wouldLoopRule,
  withScheme,
  isHttpUrl,
  ENABLED_KEY,
  SNOOZE_KEY,
  GROUPS_KEY,
  NOTICE_KEY,
  UNGROUPED_ID,
} from "./storage.js";

const MODE_HINT = {
  site: "그 사이트면 www·하위 도메인·경로 상관없이 전부 대상 주소로 이동합니다.",
  exact: "주소가 똑같은 그 페이지 하나만 이동합니다 (http/https, www, 끝 / 무시).",
  prefix: "원본 주소로 시작하는 모든 페이지를 대상 한 곳으로 모읍니다.",
  replace: "원본으로 시작하면 앞부분만 대상으로 바꾸고 뒤 경로는 유지합니다.",
  regex: "원본은 정규식(RE2), 대상은 \\1 같은 역참조를 쓰는 치환 문자열입니다.",
};

const LOOP_HINT = "대상이 원본에 다시 걸려 무한 리다이렉트가 됩니다. 이 규칙은 적용되지 않습니다.";

const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

const groupsEl = document.getElementById("groups");
const statusEl = document.getElementById("status");
const masterEl = document.getElementById("master");
const masterLabelEl = document.getElementById("masterLabel");
const wordmarkEl = document.getElementById("wordmark");
const searchEl = document.getElementById("search");
const sortEl = document.getElementById("sort");
const snoozeStateEl = document.getElementById("snoozeState");
const snoozeClearEl = document.getElementById("snoozeClear");
const snoozeBtns = [...document.querySelectorAll("[data-snooze]")];
const importFileEl = document.getElementById("importFile");
const saveEl = document.getElementById("save");
const loadErrorEl = document.getElementById("loadError");
const loadErrorReasonEl = document.getElementById("loadErrorReason");
const noticeEl = document.getElementById("notice");

// 화면 상태. 저장 순서는 state.rules 순서 그대로 유지하고, 정렬은 표시에만 쓴다.
// rev 는 낙관적 잠금용 — 불러온 뒤 다른 곳에서 저장이 있었으면 덮어쓰지 않는다.
const state = { rules: [], groups: [], rev: 0, loaded: false };
let statusTimer;
let snoozeTimer;
let currentSnooze = null;
let selfWriteAt = 0; // 이 페이지가 저장한 변경은 onChanged 안내에서 걸러 낸다.

/* ── 유효성 ───────────────────────────────────────────── */

// 도메인 전체 방식은 "naver.com" 같은 host 만 넣어도 유효하다.
function isValidFrom(value, mode) {
  const v = String(value || "").trim();
  if (!v) return true;
  if (mode === "regex") {
    try {
      new RegExp(v);
      return true;
    } catch {
      return false;
    }
  }
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

function isValidTo(value, mode) {
  const v = String(value || "").trim();
  if (!v) return true;
  if (mode === "regex") return true; // 치환 문자열이라 URL 검사를 하지 않는다.
  return isHttpUrl(withScheme(v));
}

/* ── 규칙 행 ─────────────────────────────────────────── */

function ruleRow(rule) {
  const div = document.createElement("div");
  div.className = "rule";
  div._rule = rule;
  div.innerHTML = `
    <input type="text" class="from" placeholder="naver.com" />
    <span class="arrow" aria-hidden="true">→</span>
    <input type="text" class="to" placeholder="https://daum.net" />
    <select class="mode" aria-label="매칭 방식">
      <option value="site">도메인 전체</option>
      <option value="exact">정확히 일치</option>
      <option value="prefix">접두사 일치</option>
      <option value="replace">부분 치환</option>
      <option value="regex">정규식</option>
    </select>
    <select class="group" aria-label="그룹"></select>
    <span class="enabled-cell">
      <button type="button" class="master sm enabled" role="switch" aria-label="이 규칙 사용"></button>
    </span>
    <button type="button" class="del" aria-label="규칙 삭제" title="삭제">&times;</button>
    <span class="rule-hint"></span>
    <details class="adv">
      <summary>예외 · 시간 조건 <span class="badge" hidden></span></summary>
      <div class="adv-body">
        <div class="opt-query" hidden>
          <label class="checkline">
            <input type="checkbox" class="dropQuery" />
            물음표 뒤 검색어 떼고 이동 (부분 치환 전용)
          </label>
        </div>
        <div>
          <h4>제외 패턴</h4>
          <textarea class="exclude" placeholder="naver.com/admin&#10;*/login*"></textarea>
          <p class="note">한 줄에 하나씩. 주소에 이 문자열이 들어 있으면 리다이렉트하지 않습니다. <code>*</code> 는 아무 글자나 뜻합니다.</p>
        </div>
        <div>
          <h4>시간 조건</h4>
          <div class="days"></div>
          <div class="times">
            <input type="time" class="start" aria-label="시작 시각" />
            <span>~</span>
            <input type="time" class="end" aria-label="끝 시각" />
            <button type="button" class="btn ghost clearTime" style="padding:4px 8px;font-size:12px">시간 지우기</button>
          </div>
          <p class="note">요일을 하나도 고르지 않으면 매일, 시작·끝이 같거나 비어 있으면 하루 종일 동작합니다. 22:00~02:00 처럼 자정을 넘겨도 되고, 이때 요일은 시작한 날을 기준으로 봅니다.</p>
        </div>
      </div>
    </details>
  `;

  const from = div.querySelector(".from");
  const to = div.querySelector(".to");
  const enabled = div.querySelector(".enabled");
  const mode = div.querySelector(".mode");
  const group = div.querySelector(".group");
  const hint = div.querySelector(".rule-hint");
  const badge = div.querySelector(".badge");
  const optQuery = div.querySelector(".opt-query");
  const dropQuery = div.querySelector(".dropQuery");
  const exclude = div.querySelector(".exclude");
  const daysEl = div.querySelector(".days");
  const start = div.querySelector(".start");
  const end = div.querySelector(".end");

  from.value = rule.from;
  to.value = rule.to;
  mode.value = rule.mode;
  enabled.setAttribute("aria-checked", String(rule.enabled !== false));
  dropQuery.checked = rule.dropQuery === true;
  exclude.value = rule.exclude.join("\n");
  start.value = rule.schedule?.start || "";
  end.value = rule.schedule?.end || "";

  // 그룹 드롭다운
  const opts = [{ id: UNGROUPED_ID, name: "미분류" }, ...state.groups];
  group.replaceChildren(
    ...opts.map((g) => {
      const o = document.createElement("option");
      o.value = g.id;
      o.textContent = g.name;
      return o;
    })
  );
  group.value = opts.some((g) => g.id === rule.groupId) ? rule.groupId : UNGROUPED_ID;

  // 요일 체크박스 7개
  DAY_NAMES.forEach((name, i) => {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "day";
    box.value = String(i);
    box.checked = Boolean(rule.schedule?.days?.includes(i));
    label.append(box, document.createTextNode(name));
    daysEl.appendChild(label);
  });

  const paintBadge = () => {
    const bits = [];
    if (rule.exclude.length) bits.push(`제외 ${rule.exclude.length}`);
    if (rule.schedule) bits.push("시간");
    if (rule.dropQuery && rule.mode === "replace") bits.push("검색어 제거");
    badge.textContent = bits.join(" · ");
    badge.hidden = bits.length === 0;
  };

  const paintMode = () => {
    if (rule.mode === "regex") {
      from.placeholder = "^https?://(?:www\\.)?example\\.com/old/(.*)$";
      to.placeholder = "https://example.com/new/\\1";
    } else {
      from.placeholder = rule.mode === "site" ? "naver.com" : "https://old.example.com/";
      to.placeholder = "https://daum.net";
    }
    optQuery.hidden = rule.mode !== "replace";
  };

  // 형식 오류와 무한 리다이렉트를 함께 본다.
  const validate = () => {
    const shapeBad = !isValidFrom(from.value, rule.mode) || !isValidTo(to.value, rule.mode);
    const loops = !shapeBad && rule.from && rule.to && wouldLoopRule(rule);
    div.classList.toggle("invalid", Boolean(shapeBad || loops));
    hint.textContent = loops ? LOOP_HINT : MODE_HINT[rule.mode] || "";
  };

  const readSchedule = () => {
    const days = [...daysEl.querySelectorAll(".day")]
      .filter((b) => b.checked)
      .map((b) => Number(b.value));
    const s = start.value;
    const e = end.value;
    rule.schedule = !days.length && (!s || !e || s === e) ? null : { days, start: s, end: e };
  };

  from.addEventListener("input", () => {
    rule.from = from.value.trim();
    validate();
  });
  to.addEventListener("input", () => {
    rule.to = to.value.trim();
    validate();
  });
  mode.addEventListener("change", () => {
    rule.mode = mode.value;
    paintMode();
    paintBadge();
    validate();
  });
  group.addEventListener("change", () => {
    rule.groupId = group.value;
    render(); // 다른 그룹 섹션으로 옮겨 그린다.
  });
  enabled.addEventListener("click", () => {
    rule.enabled = enabled.getAttribute("aria-checked") !== "true";
    enabled.setAttribute("aria-checked", String(rule.enabled));
  });
  dropQuery.addEventListener("change", () => {
    rule.dropQuery = dropQuery.checked;
    paintBadge();
    validate();
  });
  exclude.addEventListener("input", () => {
    rule.exclude = exclude.value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    paintBadge();
  });
  const onSchedule = () => {
    readSchedule();
    paintBadge();
  };
  daysEl.addEventListener("change", onSchedule);
  start.addEventListener("change", onSchedule);
  end.addEventListener("change", onSchedule);
  div.querySelector(".clearTime").addEventListener("click", () => {
    start.value = "";
    end.value = "";
    onSchedule();
  });
  div.querySelector(".del").addEventListener("click", () => {
    const i = state.rules.indexOf(rule);
    if (i >= 0) state.rules.splice(i, 1);
    render();
  });

  paintMode();
  paintBadge();
  validate();
  return div;
}

/* ── 렌더 ─────────────────────────────────────────────── */

function sortedIndices(indices) {
  const by = sortEl.value;
  if (by === "none") return indices;
  const copy = [...indices];
  if (by === "recent") return copy.reverse();
  if (by === "from") {
    return copy.sort((a, b) =>
      state.rules[a].from.localeCompare(state.rules[b].from, "ko", { numeric: true })
    );
  }
  const order = { site: 0, exact: 1, prefix: 2, replace: 3, regex: 4 };
  return copy.sort((a, b) => order[state.rules[a].mode] - order[state.rules[b].mode]);
}

function groupSection(group, indices) {
  const isUngrouped = group.id === UNGROUPED_ID;
  const sec = document.createElement("div");
  sec.className = "group-sec";

  const head = document.createElement("div");
  head.className = "group-head";
  head.innerHTML = `
    <input type="text" class="gname" aria-label="그룹 이름" />
    <span class="gcount"></span>
  `;
  const gname = head.querySelector(".gname");
  gname.value = group.name;
  if (isUngrouped) gname.disabled = true;
  else {
    gname.addEventListener("input", () => {
      group.name = gname.value;
    });
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "master sm";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-label", "그룹 사용");
    sw.setAttribute("aria-checked", String(group.enabled !== false));
    sw.addEventListener("click", () => {
      group.enabled = sw.getAttribute("aria-checked") !== "true";
      sw.setAttribute("aria-checked", String(group.enabled));
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "gdel";
    del.title = "그룹 삭제 (규칙은 미분류로 이동)";
    del.setAttribute("aria-label", "그룹 삭제");
    del.innerHTML = "&times;";
    del.addEventListener("click", () => {
      state.rules.forEach((r) => {
        if (r.groupId === group.id) r.groupId = UNGROUPED_ID;
      });
      state.groups = state.groups.filter((g) => g.id !== group.id);
      render();
    });
    head.append(sw, del);
  }

  const list = document.createElement("div");
  list.className = "rules";
  for (const i of sortedIndices(indices)) list.appendChild(ruleRow(state.rules[i]));
  if (!indices.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "이 그룹에는 아직 규칙이 없습니다.";
    list.appendChild(empty);
  }
  head.querySelector(".gcount").textContent = `${indices.length}개`;

  const foot = document.createElement("div");
  foot.className = "group-foot";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn";
  add.textContent = "＋ 규칙 추가";
  add.addEventListener("click", () => {
    state.rules.push(normalizeRule({ groupId: group.id }));
    render();
    const rows = groupsEl.querySelectorAll(".rule");
    rows[rows.length - 1]?.querySelector(".from")?.focus();
  });
  foot.appendChild(add);

  sec.append(head, list, foot);
  return sec;
}

function render() {
  const known = new Set(state.groups.map((g) => g.id));
  const buckets = new Map([[UNGROUPED_ID, []]]);
  state.groups.forEach((g) => buckets.set(g.id, []));
  state.rules.forEach((r, i) => {
    const key = r.groupId && known.has(r.groupId) ? r.groupId : UNGROUPED_ID;
    buckets.get(key).push(i);
  });

  groupsEl.replaceChildren(
    groupSection({ id: UNGROUPED_ID, name: "미분류" }, buckets.get(UNGROUPED_ID)),
    ...state.groups.map((g) => groupSection(g, buckets.get(g.id)))
  );
  applyFilter();
}

// 검색은 기존 DOM 을 다시 만들지 않고 표시 여부만 토글한다.
function applyFilter() {
  const q = searchEl.value.trim().toLowerCase();
  for (const sec of groupsEl.querySelectorAll(".group-sec")) {
    let visible = 0;
    for (const row of sec.querySelectorAll(".rule")) {
      const rule = row._rule;
      const hit = !q || (rule.from + " " + rule.to).toLowerCase().includes(q);
      row.classList.toggle("hidden", !hit);
      if (hit) visible += 1;
    }
    sec.hidden = Boolean(q) && visible === 0;
  }
}

function showStatus(text, kind = "") {
  clearTimeout(statusTimer);
  statusEl.textContent = text;
  statusEl.className = kind;
  if (text) statusTimer = setTimeout(() => (statusEl.textContent = ""), 5000);
}

function showLoadError(reason) {
  state.loaded = false;
  loadErrorReasonEl.textContent = reason ? `(${reason})` : "";
  loadErrorEl.hidden = false;
  saveEl.disabled = true;
  groupsEl.replaceChildren();
}

function paintNotice(text) {
  noticeEl.textContent = text || "";
  noticeEl.hidden = !text;
}

document.getElementById("reload").addEventListener("click", () => location.reload());

/* ── 마스터 스위치 ───────────────────────────────────── */

function paintMaster(enabled) {
  masterEl.setAttribute("aria-checked", String(enabled));
  masterLabelEl.textContent = enabled ? "켜짐" : "꺼짐";
  wordmarkEl.setAttribute("data-on", String(enabled));
}

masterEl.addEventListener("click", async () => {
  const next = masterEl.getAttribute("aria-checked") !== "true";
  paintMaster(next);
  await saveEnabled(next);
  showStatus(next ? "자동 리다이렉트를 켰습니다." : "자동 리다이렉트를 껐습니다.", "ok");
});

/* ── 스누즈 ───────────────────────────────────────────── */

function paintSnooze(snooze) {
  clearTimeout(snoozeTimer);
  const left = snooze ? snooze.until - Date.now() : 0;
  currentSnooze = left > 0 ? snooze : null;

  const activeSpec = left > 0 ? snooze.spec : null;
  snoozeBtns.forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.snooze === activeSpec));
  });

  if (left <= 0) {
    snoozeStateEl.textContent = "";
    snoozeStateEl.className = "";
    snoozeClearEl.hidden = true;
    return;
  }
  const mins = Math.ceil(left / 60000);
  const text = mins >= 60 ? `${Math.floor(mins / 60)}시간 ${mins % 60}분` : `${mins}분`;
  snoozeStateEl.textContent =
    `일시 정지 중 — ${text} 후 다시 켜집니다` + (activeSpec ? " (같은 버튼을 다시 누르면 해제)" : "");
  snoozeStateEl.className = "active";
  snoozeClearEl.hidden = false;
  snoozeTimer = setTimeout(() => paintSnooze(snooze), 30000);
}

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
    if (currentSnooze && currentSnooze.spec === spec) {
      await saveSnooze(null);
      paintSnooze(null);
      showStatus("일시 정지를 해제했습니다.", "ok");
      return;
    }
    const until = snoozeUntil(spec);
    await saveSnooze(until, spec);
    paintSnooze({ until, spec });
    showStatus("리다이렉트를 잠시 멈췄습니다.", "ok");
  });
});

snoozeClearEl.addEventListener("click", async () => {
  await saveSnooze(null);
  paintSnooze(null);
  showStatus("일시 정지를 해제했습니다.", "ok");
});

/* ── 그룹 추가 ────────────────────────────────────────── */

document.getElementById("addGroup").addEventListener("click", () => {
  state.groups.push(normalizeGroup({ id: newGroupId(), name: "새 그룹", enabled: true }));
  render();
});

/* ── 검색 / 정렬 ─────────────────────────────────────── */

searchEl.addEventListener("input", applyFilter);
sortEl.addEventListener("change", render);

/* ── 내보내기 / 가져오기 ─────────────────────────────── */

document.getElementById("export").addEventListener("click", () => {
  const payload = { version: 1, rules: state.rules, groups: state.groups };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `auto-redirect-rules-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showStatus(`규칙 ${state.rules.length}개를 파일로 내보냈습니다.`, "ok");
});

document.getElementById("import").addEventListener("click", () => importFileEl.click());

importFileEl.addEventListener("change", async () => {
  const file = importFileEl.files?.[0];
  importFileEl.value = "";
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showStatus("가져오기 실패 — JSON 형식이 아닙니다.", "err");
    return;
  }
  const rawRules = Array.isArray(data) ? data : data?.rules;
  if (!Array.isArray(rawRules)) {
    showStatus("가져오기 실패 — rules 배열을 찾을 수 없습니다.", "err");
    return;
  }

  let skipped = 0;
  const rules = [];
  for (const raw of rawRules) {
    if (!raw || typeof raw !== "object" || !raw.from || !raw.to) {
      skipped += 1;
      continue;
    }
    rules.push(normalizeRule(raw));
  }
  const groups = Array.isArray(data?.groups)
    ? data.groups.filter((g) => g && g.id).map(normalizeGroup)
    : [];

  if (!rules.length) {
    showStatus(`가져올 수 있는 규칙이 없습니다 (건너뛴 항목 ${skipped}개).`, "err");
    return;
  }

  const replace = confirm(
    `규칙 ${rules.length}개를 가져옵니다.\n\n확인 = 기존 규칙을 모두 지우고 교체\n취소 = 기존 규칙 뒤에 추가(병합)`
  );

  if (replace) {
    state.rules = rules;
    state.groups = groups;
  } else {
    const existing = new Set(state.groups.map((g) => g.id));
    groups.forEach((g) => {
      if (!existing.has(g.id)) state.groups.push(g);
    });
    state.rules.push(...rules);
  }
  render();
  showStatus(
    `${replace ? "교체" : "병합"}했습니다 — 규칙 ${rules.length}개` +
      (skipped ? `, 건너뛴 항목 ${skipped}개` : "") +
      ". 저장을 눌러 적용하세요.",
    "ok"
  );
});

/* ── 저장 / 되돌리기 ─────────────────────────────────── */

document.getElementById("revert").addEventListener("click", load);

saveEl.addEventListener("click", async () => {
  if (!state.loaded) return;
  const rules = state.rules.filter((r) => r.from || r.to);
  const invalid = rules.filter((r) => !ruleShapeIsValid(r)).length;
  try {
    selfWriteAt = Date.now();
    state.rev = await saveRules(rules, state.rev);
    await saveGroups(state.groups);
    selfWriteAt = Date.now();
    state.rules = rules;
    render(); // 빈 행을 정리해 DOM 과 state 를 다시 맞춘다.
    if (invalid) {
      showStatus(
        `저장했지만 주소 형식이 틀렸거나 무한 리다이렉트가 되는 규칙 ${invalid}개는 적용되지 않습니다.`,
        "err"
      );
    } else {
      showStatus("저장했습니다. 바로 적용됩니다.", "ok");
    }
  } catch (e) {
    if (e.code === "rev-conflict") {
      showStatus(e.message, "err");
    } else {
      showStatus("저장 실패 — " + e.message, "err");
    }
  }
});

/* ── 초기 로드 ──────────────────────────────────────── */

async function load() {
  await migrateIfNeeded().catch(() => {});
  const [result, groups, enabled, snooze, notice] = await Promise.all([
    loadRules(),
    loadGroups(),
    loadEnabled(),
    loadSnooze(),
    loadNotice(),
  ]);

  paintMaster(enabled);
  paintSnooze(snooze);
  paintNotice(notice);

  if (!result.ok) {
    showLoadError(result.reason);
    showStatus("");
    return;
  }

  loadErrorEl.hidden = true;
  saveEl.disabled = false;
  state.loaded = true;
  state.rules = result.rules;
  state.rev = result.rev;
  state.groups = groups;
  render();
  showStatus("");
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[NOTICE_KEY]) {
    paintNotice(changes[NOTICE_KEY].newValue?.text || "");
    return;
  }
  if (area !== "sync") return;
  if (changes[ENABLED_KEY]) paintMaster(changes[ENABLED_KEY].newValue !== false);
  if (changes[SNOOZE_KEY]) paintSnooze(changes[SNOOZE_KEY].newValue || null);
  // 다른 창에서 규칙·그룹이 바뀌면 편집 중인 내용을 덮어쓰지 않고 안내만 한다.
  if ((rulesChanged(changes) || changes[GROUPS_KEY]) && Date.now() - selfWriteAt > 1500) {
    showStatus("다른 창에서 규칙이 바뀌었습니다. 되돌리기를 누르면 최신 내용을 불러옵니다.");
  }
});

load();
