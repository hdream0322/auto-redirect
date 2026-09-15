// 테스트용 chrome.* 스텁. 실제 확장 API 대신 메모리 저장소와 규칙 목록을 흉내 낸다.

export function installChromeStub() {
  const sync = {};
  const local = {};
  const session = {};
  const listeners = [];
  let generation = 0;
  const nav = { before: [], dom: [], injections: [] };

  const area = (bag) => ({
    async get(k) {
      const keys = k == null ? Object.keys(bag) : Array.isArray(k) ? k : [k];
      const out = {};
      for (const key of keys) if (key in bag) out[key] = bag[key];
      return out;
    },
    async set(o) {
      Object.assign(bag, o);
    },
    async remove(k) {
      for (const key of Array.isArray(k) ? k : [k]) delete bag[key];
    },
  });

  const dnr = {
    MAX_NUMBER_OF_DYNAMIC_RULES: 5000,
    MAX_NUMBER_OF_REGEX_RULES: 1000,
    rules: [],
    // 특정 규칙을 브라우저가 거부하는 상황을 흉내 낼 때 쓴다.
    reject: null,
    async getDynamicRules() {
      return this.rules;
    },
    async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
      if (this.reject && addRules.some(this.reject)) throw new Error("rule rejected by stub");
      this.rules = this.rules.filter((r) => !removeRuleIds.includes(r.id)).concat(addRules);
    },
  };

  globalThis.chrome = {
    storage: {
      sync: area(sync),
      local: area(local),
      session: area(session),
      onChanged: { addListener: (f) => listeners.push(f) },
    },
    runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    alarms: {
      created: new Map(),
      async get(n) {
        return this.created.get(n) || null;
      },
      create(n, o) {
        this.created.set(n, { name: n, ...o });
      },
      async clear(n) {
        this.created.delete(n);
      },
      onAlarm: { addListener() {} },
    },
    declarativeNetRequest: dnr,
    webNavigation: {
      onBeforeNavigate: { addListener: (f) => nav.before.push(f) },
      onDOMContentLoaded: { addListener: (f) => nav.dom.push(f) },
    },
    scripting: {
      async executeScript(opts) {
        nav.injections.push(opts);
      },
    },
    tabs: { onRemoved: { addListener() {} } },
  };

  return {
    sync,
    local,
    session,
    dnr,
    nav,
    // 서비스 워커가 종료됐다 다시 뜨는 상황: 메모리 상태만 날아가고 저장소는 남는다.
    async restartWorker() {
      nav.before.length = 0;
      nav.dom.length = 0;
      listeners.length = 0;
      await import(`../background.js?worker=${++generation}`);
    },
    // 네비게이션 이벤트를 흉내 내 앵커 동기화 경로를 태운다.
    async navigate(startUrl, committedUrl, tabId = 1) {
      nav.injections.length = 0;
      for (const f of nav.before) await f({ frameId: 0, tabId, url: startUrl });
      for (const f of nav.dom) await f({ frameId: 0, tabId, url: committedUrl });
    },
    // background.js 의 storage.onChanged 리스너를 깨워 규칙을 다시 적용시킨다.
    async apply() {
      for (const f of listeners) await f({ redirectRules_meta: {} }, "sync");
      await new Promise((r) => setTimeout(r, 250));
    },
    async clear() {
      for (const k of Object.keys(sync)) delete sync[k];
      for (const k of Object.keys(local)) delete local[k];
      for (const k of Object.keys(session)) delete session[k];
      dnr.rules = [];
      dnr.reject = null;
    },
  };
}

// URL 이 어떤 DNR 규칙에 걸리는지 계산한다(priority 최댓값, allow 가 redirect 를 이김).
export function matchOutcome(rules, url) {
  const hits = rules.filter((r) => {
    const c = r.condition;
    if (c.regexFilter && !new RegExp(c.regexFilter).test(url)) return false;
    if (c.requestDomains) {
      const host = new URL(url).hostname;
      if (!c.requestDomains.some((d) => host === d || host.endsWith("." + d))) return false;
    }
    return true;
  });
  if (!hits.length) return null;
  const top = Math.max(...hits.map((r) => r.priority));
  const best = hits.filter((r) => r.priority === top);
  const allow = best.find((r) => r.action.type === "allow");
  return allow || best[0];
}
