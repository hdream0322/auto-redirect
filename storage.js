// 공용 저장소 모듈 — background / options / popup 이 모두 import 한다.
// chrome.storage.sync 는 항목 하나당 약 8KB 제한이 있어, 규칙 배열은 JSON 문자열로 만든 뒤
// ASCII 로 이스케이프해(바이트 수 = 문자 수) 6000자 단위로 잘라
// redirectRules_0, redirectRules_1 … 에 나눠 담는다.

export const LEGACY_RULES_KEY = "redirectRules"; // 예전 단일 키 (마이그레이션 대상)
export const RULES_PREFIX = "redirectRules_"; // 청크 · 메타 공통 prefix
export const RULES_META_KEY = "redirectRules_meta"; // {chunks, count, len, rev}
export const ENABLED_KEY = "redirectEnabled"; // 마스터 on/off
export const GROUPS_KEY = "redirectGroups"; // [{id, name, enabled}]
export const SNOOZE_KEY = "redirectSnooze"; // {until: epochMs, spec?: "15"|"60"|"today"}
export const NOTICE_KEY = "redirectNotice"; // storage.local — 사용자에게 보여 줄 경고

const CHUNK_SIZE = 6000; // ASCII 로 이스케이프하므로 문자 수 = 바이트 수
const QUOTA_BYTES = 102400; // chrome.storage.sync 전체 한도
const RESERVED_BYTES = 8192; // 그룹·스위치·스누즈·키 이름이 쓸 몫
export const MAX_CHUNKS = Math.floor((QUOTA_BYTES - RESERVED_BYTES) / CHUNK_SIZE); // 15

export const UNGROUPED_ID = ""; // groupId 가 비어 있으면 "미분류"

// 정규식 치환 결과가 원본에 다시 걸리는지(무한 루프) 확인할 때 쓰는 더미 값.
const LOOP_PROBE = "0loopprobe0";

/* ── URL 유틸 (세 스크립트 공용) ───────────────────────── */

export function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 사용자가 scheme 없이 "naver.com" 처럼 넣어도 받아 준다.
export function withScheme(value) {
  const v = String(value || "").trim();
  if (/^https?:\/\//i.test(v)) return v;
  return "https://" + v.replace(/^\/+/, "");
}

export function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// 입력값에서 host 만 뽑아 소문자로, 맨 앞 www. 는 떼어 낸다.
export function hostOf(value) {
  try {
    return new URL(withScheme(value)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/* ── 규칙 정규화 (하위호환) ────────────────────────────── */

// 옛 규칙 객체에 새 필드가 없어도 동작하도록 기본값을 채운다.
export function normalizeRule(r) {
  const rule = r && typeof r === "object" ? r : {};
  return {
    from: String(rule.from || ""),
    to: String(rule.to || ""),
    mode: ["site", "exact", "prefix", "replace", "regex"].includes(rule.mode) ? rule.mode : "site",
    enabled: rule.enabled !== false,
    groupId: typeof rule.groupId === "string" ? rule.groupId : UNGROUPED_ID,
    dropQuery: rule.dropQuery === true,
    // 리다이렉트로 주소가 바뀌면서 원본의 #앵커가 목적지에서 안 먹힐 때,
    // "몇 번째 제목이었는지"로 스크롤 위치를 맞춰 준다(기본 켬).
    syncAnchor: rule.syncAnchor !== false,
    exclude: Array.isArray(rule.exclude)
      ? rule.exclude.map((s) => String(s).trim()).filter(Boolean)
      : [],
    schedule: normalizeSchedule(rule.schedule),
  };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/; // 00:00 ~ 23:59 만 허용

export function normalizeSchedule(s) {
  if (!s || typeof s !== "object") return null;
  const days = Array.isArray(s.days)
    ? [...new Set(s.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : [];
  const time = (v) => (TIME_RE.test(String(v || "")) ? String(v) : "");
  const start = time(s.start);
  const end = time(s.end);
  // 요일 조건도 시간 조건도 없으면 스케줄이 없는 것과 같다.
  if (!days.length && (!start || !end || start === end)) return null;
  return { days, start, end };
}

export function normalizeGroup(g) {
  const grp = g && typeof g === "object" ? g : {};
  return {
    id: String(grp.id || ""),
    name: String(grp.name || "이름 없는 그룹"),
    enabled: grp.enabled !== false,
  };
}

export function newGroupId() {
  return "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ── 시간 조건 ────────────────────────────────────────── */

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

// schedule 이 없거나 조건을 만족하면 true.
// 자정을 넘기는 범위(22:00~02:00)는 "시작한 날"의 요일로 판정한다 —
// 즉 새벽 구간(cur < end)은 전날 요일에 속한다.
export function scheduleActive(schedule, now = new Date()) {
  if (!schedule) return true;
  const days = Array.isArray(schedule.days) ? schedule.days : [];
  const { start, end } = schedule;

  // 시간 범위가 없으면 하루 종일 — 오늘 요일만 본다.
  if (!start || !end || start === end) {
    return !days.length || days.includes(now.getDay());
  }

  const cur = now.getHours() * 60 + now.getMinutes();
  const s = toMinutes(start);
  const e = toMinutes(end);

  let startDay;
  if (s < e) {
    if (cur < s || cur >= e) return false;
    startDay = now.getDay();
  } else if (cur >= s) {
    startDay = now.getDay(); // 오늘 저녁에 시작한 구간
  } else if (cur < e) {
    startDay = (now.getDay() + 6) % 7; // 어제 저녁에 시작해 자정을 넘긴 구간
  } else {
    return false;
  }

  return !days.length || days.includes(startDay);
}

/* ── 규칙 → 정규식 (background 와 유효성 검사가 공유) ──── */

// "시작하는 URL" 계열(prefix / replace)에서 www. 와 http/https 를 너그럽게 매칭하는 정규식 조각.
// 포트를 적지 않았으면 어떤 포트든 허용하고, 적었으면 그 포트만 본다.
function hostPortRegex(u) {
  const host = u.hostname.replace(/^www\./, "");
  const port = u.port ? escapeRegex(":" + u.port) : "(?::\\d+)?";
  return "(?:www\\.)?" + escapeRegex(host) + port;
}

export function forgivingPrefixRegex(url) {
  const u = new URL(url);
  return "^https?://" + hostPortRegex(u) + escapeRegex(u.pathname + u.search);
}

// site 모드를 뺀 나머지 모드의 condition.regexFilter 를 만든다.
export function buildRegexFilter(rule) {
  if (rule.mode === "regex") return rule.from;

  if (rule.mode === "replace") {
    // dropQuery 면 물음표 뒤 검색어는 떼고 경로만 이어 붙인다.
    const tail = rule.dropQuery ? "([^?]*)(?:\\?.*)?$" : "(.*)$";
    return forgivingPrefixRegex(withScheme(rule.from)) + tail;
  }

  if (rule.mode === "prefix") {
    return forgivingPrefixRegex(withScheme(rule.from));
  }

  // exact: http/https 차이, www. 유무, 끝의 / 유무만 같은 것으로 본다.
  const u = new URL(withScheme(rule.from));
  const path = (u.pathname + u.search).replace(/\/$/, "");
  return "^https?://" + hostPortRegex(u) + escapeRegex(path) + "/?$";
}

// 리다이렉트 결과로 만들어질 URL(역참조는 더미로 채움).
function redirectTarget(rule) {
  if (rule.mode === "regex") {
    return String(rule.to).replace(/\\(\d)/g, LOOP_PROBE);
  }
  if (rule.mode === "replace") {
    return withScheme(rule.to) + LOOP_PROBE;
  }
  return withScheme(rule.to);
}

// 대상이 원본 도메인(또는 그 하위 도메인)이면 무한 리다이렉트가 되므로 막는다.
function siteWouldLoop(fromHost, toHost) {
  if (!fromHost || !toHost) return false;
  return toHost === fromHost || toHost.endsWith("." + fromHost);
}

// 모든 모드의 무한 리다이렉트 검사: 리다이렉트 결과가 자기 규칙에 다시 걸리면 거부한다.
// (prefix/replace 는 "대상이 원본의 접두사" 인 경우와 같은 뜻이다.)
export function wouldLoopRule(rule) {
  if (rule.mode === "site") return siteWouldLoop(hostOf(rule.from), hostOf(rule.to));
  try {
    return new RegExp(buildRegexFilter(rule)).test(redirectTarget(rule));
  } catch {
    return false; // 정규식이 깨졌으면 ruleIsValid 쪽에서 따로 거른다.
  }
}

/* ── 유효성 (background / options / popup 공용) ────────── */

export function ruleIsValid(r, groupMap, now = new Date()) {
  if (!r || r.enabled === false) return false;
  if (!r.from || !r.to) return false;

  // 그룹이 꺼져 있으면 그 그룹의 규칙은 전부 제외한다.
  if (r.groupId && groupMap && groupMap.get(r.groupId)?.enabled === false) return false;

  if (!scheduleActive(r.schedule, now)) return false;

  if (r.mode === "regex") {
    // RE2 와 100% 같지는 않지만 명백한 실수는 여기서 걸러 낸다.
    if (!r.from.trim() || !r.to.trim()) return false;
    if (r.from === r.to) return false;
    try {
      new RegExp(r.from);
    } catch {
      return false;
    }
    return !wouldLoopRule(r);
  }

  if (r.mode === "site") {
    const fromHost = hostOf(r.from);
    if (!fromHost || !fromHost.includes(".") || /\s/.test(fromHost)) return false;
    if (!isHttpUrl(withScheme(r.to))) return false;
    return !wouldLoopRule(r);
  }

  if (!isHttpUrl(withScheme(r.from)) || !isHttpUrl(withScheme(r.to))) return false;
  if (withScheme(r.from) === withScheme(r.to)) return false;
  return !wouldLoopRule(r);
}

// 시간 조건·그룹을 무시하고 "형식이 올바른가"만 본다(옵션 페이지 경고용).
export function ruleShapeIsValid(r) {
  return ruleIsValid({ ...r, enabled: true, groupId: UNGROUPED_ID, schedule: null }, null);
}

/* ── 청크 직렬화 ──────────────────────────────────────── */

// 비ASCII 문자를 \uXXXX 로 바꿔 문자 수 = UTF-8 바이트 수가 되게 만든다.
// (이스케이프된 JSON 도 JSON.parse 가 그대로 읽는다.)
const NON_ASCII_RE = new RegExp("[\\u007f-\\uffff]", "g");

function toAscii(json) {
  return json.replace(NON_ASCII_RE, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

function chunkKeys(n) {
  return Array.from({ length: n }, (_, i) => RULES_PREFIX + i);
}

/* ── 규칙 읽기 / 쓰기 ──────────────────────────────────── */

// 항상 {ok, rules, rev, reason} 을 돌려준다.
// 청크가 덜 동기화된 상태에서 빈 배열을 반환하면 규칙이 통째로 날아가므로,
// 조각·길이·개수를 모두 검사하고 하나라도 어긋나면 ok:false 로 알린다.
export async function loadRules() {
  const meta = (await chrome.storage.sync.get(RULES_META_KEY))[RULES_META_KEY];

  if (!meta || !Number.isInteger(meta.chunks)) {
    const legacy = (await chrome.storage.sync.get(LEGACY_RULES_KEY))[LEGACY_RULES_KEY];
    return { ok: true, rules: Array.isArray(legacy) ? legacy.map(normalizeRule) : [], rev: 0 };
  }

  const rev = Number.isInteger(meta.rev) ? meta.rev : 0;
  if (meta.chunks === 0) return { ok: true, rules: [], rev };

  const keys = chunkKeys(meta.chunks);
  const data = await chrome.storage.sync.get(keys);
  const missing = keys.filter((k) => typeof data[k] !== "string");
  if (missing.length) {
    return { ok: false, rules: null, rev, reason: `조각 ${missing.length}개가 아직 없습니다.` };
  }

  const json = keys.map((k) => data[k]).join("");
  if (Number.isInteger(meta.len) && json.length !== meta.len) {
    return { ok: false, rules: null, rev, reason: "저장된 길이와 다릅니다." };
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, rules: null, rev, reason: "내용을 해석할 수 없습니다." };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, rules: null, rev, reason: "규칙 목록 형식이 아닙니다." };
  }
  if (Number.isInteger(meta.count) && parsed.length !== meta.count) {
    return { ok: false, rules: null, rev, reason: "규칙 개수가 맞지 않습니다." };
  }

  return { ok: true, rules: parsed.map(normalizeRule), rev };
}

function conflictError(message) {
  const e = new Error(message);
  e.code = "rev-conflict";
  return e;
}

// 규칙 배열을 청크로 잘라 저장한다.
// expectedRev 를 넘기면 그 사이 다른 창·기기가 먼저 저장한 경우 덮어쓰지 않고 거부한다.
export async function saveRules(rules, expectedRev) {
  const list = (Array.isArray(rules) ? rules : []).map(normalizeRule);
  const json = toAscii(JSON.stringify(list));

  const parts = [];
  for (let i = 0; i < json.length; i += CHUNK_SIZE) parts.push(json.slice(i, i + CHUNK_SIZE));
  if (parts.length > MAX_CHUNKS) {
    const kb = Math.ceil(json.length / 1024);
    throw new Error(
      `규칙이 너무 많습니다 (약 ${kb}KB). 동기화 저장 한도는 약 ${Math.floor((MAX_CHUNKS * CHUNK_SIZE) / 1024)}KB 입니다. 규칙을 줄이거나 내보내기로 나눠 보관하세요.`
    );
  }

  const prev = (await chrome.storage.sync.get(RULES_META_KEY))[RULES_META_KEY];
  const prevRev = prev && Number.isInteger(prev.rev) ? prev.rev : 0;
  if (expectedRev != null && prevRev !== expectedRev) {
    throw conflictError("다른 창이나 기기에서 규칙이 먼저 바뀌었습니다. 새로고침한 뒤 다시 저장하세요.");
  }

  const payload = {
    [RULES_META_KEY]: {
      chunks: parts.length,
      count: list.length,
      len: json.length,
      rev: prevRev + 1,
    },
  };
  parts.forEach((p, i) => (payload[RULES_PREFIX + i] = p));

  const stale = [];
  if (prev && Number.isInteger(prev.chunks)) {
    for (let i = parts.length; i < prev.chunks; i++) stale.push(RULES_PREFIX + i);
  }

  await chrome.storage.sync.set(payload);
  if (stale.length) await chrome.storage.sync.remove(stale);
  return prevRev + 1;
}

// 옛 단일 키가 남아 있으면 청크로 옮긴다.
// 이미 청크가 있는데 옛 키가 뒤늦게 동기화돼 온 경우에는 지우기 전에 없는 규칙만 병합한다.
export async function migrateIfNeeded() {
  const data = await chrome.storage.sync.get([LEGACY_RULES_KEY, RULES_META_KEY]);
  const legacy = data[LEGACY_RULES_KEY];
  if (!Array.isArray(legacy)) return false;

  if (!data[RULES_META_KEY]) {
    await saveRules(legacy);
    await chrome.storage.sync.remove(LEGACY_RULES_KEY);
    return true;
  }

  const current = await loadRules();
  if (!current.ok) return false; // 아직 다 못 읽었으면 옛 키를 그대로 둔다.

  const key = (r) => `${r.from}|${r.to}|${r.mode}`;
  const seen = new Set(current.rules.map(key));
  const extra = legacy.map(normalizeRule).filter((r) => !seen.has(key(r)));

  if (extra.length) {
    try {
      await saveRules([...current.rules, ...extra], current.rev);
    } catch {
      return false; // 충돌하면 다음 기회에 다시 시도한다.
    }
  }
  await chrome.storage.sync.remove(LEGACY_RULES_KEY);
  return extra.length > 0;
}

/* ── 그룹 / 마스터 / 스누즈 (작아서 단일 키 유지) ───────── */

export async function loadGroups() {
  const data = await chrome.storage.sync.get(GROUPS_KEY);
  return Array.isArray(data[GROUPS_KEY]) ? data[GROUPS_KEY].map(normalizeGroup) : [];
}

export async function saveGroups(groups) {
  await chrome.storage.sync.set({
    [GROUPS_KEY]: (Array.isArray(groups) ? groups : []).map(normalizeGroup),
  });
}

export async function loadEnabled() {
  const data = await chrome.storage.sync.get(ENABLED_KEY);
  return data[ENABLED_KEY] !== false; // 저장된 적 없으면 on
}

export async function saveEnabled(on) {
  await chrome.storage.sync.set({ [ENABLED_KEY]: Boolean(on) });
}

export async function loadSnooze() {
  const data = await chrome.storage.sync.get(SNOOZE_KEY);
  const s = data[SNOOZE_KEY];
  if (!s || typeof s.until !== "number") return null;
  if (s.until <= Date.now()) {
    await chrome.storage.sync.remove(SNOOZE_KEY); // 만료된 값은 남겨 두지 않는다.
    return null;
  }
  return s;
}

export async function saveSnooze(until, spec) {
  if (!until) await chrome.storage.sync.remove(SNOOZE_KEY);
  else await chrome.storage.sync.set({ [SNOOZE_KEY]: spec ? { until, spec } : { until } });
}

/* ── 사용자 알림 (동적 규칙 한도 초과 등) ──────────────── */

export async function setNotice(text) {
  if (!text) await chrome.storage.local.remove(NOTICE_KEY);
  else await chrome.storage.local.set({ [NOTICE_KEY]: { text, at: Date.now() } });
}

export async function loadNotice() {
  const data = await chrome.storage.local.get(NOTICE_KEY);
  return data[NOTICE_KEY]?.text || "";
}

/* ── 변경 감지 ────────────────────────────────────────── */

// 청크 키는 이름이 계속 바뀌므로 prefix 로 확인한다.
export function rulesChanged(changes) {
  return Object.keys(changes).some((k) => k === LEGACY_RULES_KEY || k.startsWith(RULES_PREFIX));
}

export function settingsChanged(changes) {
  return Boolean(changes[ENABLED_KEY] || changes[GROUPS_KEY] || changes[SNOOZE_KEY]);
}
