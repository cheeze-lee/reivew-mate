const STORAGE_SETTINGS_KEY = "reviewMateSettings";

const DEFAULTS = {
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  orgId: "",
  projectId: "",
  apiMode: "responses",
  model: "gpt-5",
  developerPrompt:
    "당신은 시니어 소프트웨어 엔지니어이자 꼼꼼한 코드리뷰어다. 답변은 한국어로, 간결하고 실행 가능하게 작성한다. 버그/리스크/엣지케이스/테스트 누락을 우선으로 지적하고, 가능하면 구체적인 수정 제안과 예시를 제시한다."
};

function $(id) {
  return document.getElementById(id);
}

function chromeGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function chromeSet(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

function chromePermContains(origins) {
  return new Promise((resolve) =>
    chrome.permissions.contains({ origins }, (ok) => resolve(Boolean(ok)))
  );
}

function chromePermRequest(origins) {
  return new Promise((resolve) =>
    chrome.permissions.request({ origins }, (ok) => resolve(Boolean(ok)))
  );
}

function chromePermRemove(origins) {
  return new Promise((resolve) =>
    chrome.permissions.remove({ origins }, (ok) => resolve(Boolean(ok)))
  );
}

function normalizeBaseUrl(url) {
  const v = String(url || "").trim();
  if (!v) return DEFAULTS.baseUrl;
  return v.endsWith("/") ? v.slice(0, -1) : v;
}

function baseUrlToOriginPattern(baseUrl) {
  const u = new URL(normalizeBaseUrl(baseUrl));
  return `${u.origin}/*`;
}

function setStatus(text, kind = "muted") {
  const el = $("status");
  if (!el) return;
  el.textContent = text;
  el.style.color = kind === "ok" ? "#86efac" : kind === "err" ? "#fca5a5" : "rgba(226,232,240,0.72)";
}

async function showPermissionState(baseUrl) {
  try {
    const originPattern = baseUrlToOriginPattern(baseUrl);
    const ok = await chromePermContains([originPattern]);
    setStatus(ok ? `권한 OK: ${originPattern}` : `권한 필요: ${originPattern}`, ok ? "ok" : "err");
  } catch (e) {
    setStatus(`권한 상태 확인 실패: ${String(e?.message || e)}`, "err");
  }
}

async function ensureBaseUrlPermission(baseUrl) {
  const originPattern = baseUrlToOriginPattern(baseUrl);
  const has = await chromePermContains([originPattern]);
  if (has) return { ok: true, originPattern };
  const granted = await chromePermRequest([originPattern]);
  return { ok: granted, originPattern };
}

async function load() {
  const got = await chromeGet([STORAGE_SETTINGS_KEY]);
  const s = { ...DEFAULTS, ...(got[STORAGE_SETTINGS_KEY] || {}) };

  $("apiKey").value = s.apiKey || "";
  $("baseUrl").value = s.baseUrl || DEFAULTS.baseUrl;
  $("orgId").value = s.orgId || "";
  $("projectId").value = s.projectId || "";
  $("apiMode").value = s.apiMode || "responses";
  $("model").value = s.model || DEFAULTS.model;
  $("developerPrompt").value = s.developerPrompt || DEFAULTS.developerPrompt;

  await showPermissionState(s.baseUrl || DEFAULTS.baseUrl);
}

function collect() {
  let baseUrl = $("baseUrl").value;
  // Keep the UI input normalized (helps permission status messages match).
  baseUrl = normalizeBaseUrl(baseUrl);
  $("baseUrl").value = baseUrl;
  return {
    apiKey: String($("apiKey").value || "").trim(),
    baseUrl,
    orgId: String($("orgId").value || "").trim(),
    projectId: String($("projectId").value || "").trim(),
    apiMode: $("apiMode").value || "responses",
    model: String($("model").value || "").trim() || DEFAULTS.model,
    developerPrompt: String($("developerPrompt").value || "").trim() || DEFAULTS.developerPrompt
  };
}

async function save() {
  const prev = (await chromeGet([STORAGE_SETTINGS_KEY]))[STORAGE_SETTINGS_KEY] || {};
  const s = collect();

  let perm;
  try {
    perm = await ensureBaseUrlPermission(s.baseUrl);
  } catch (e) {
    setStatus(`권한 요청 실패: ${String(e?.message || e)}`, "err");
  }

  await chromeSet({ [STORAGE_SETTINGS_KEY]: s });

  // If baseUrl host changed, drop old host permission to reduce blast radius.
  try {
    const prevBaseUrl = prev.baseUrl || DEFAULTS.baseUrl;
    const prevOrigin = baseUrlToOriginPattern(prevBaseUrl);
    const nextOrigin = baseUrlToOriginPattern(s.baseUrl);
    if (prevOrigin !== nextOrigin) await chromePermRemove([prevOrigin]);
  } catch {
    // Best-effort.
  }

  if (perm?.ok) setStatus(`저장됨 (권한 OK: ${perm.originPattern})`, "ok");
  else setStatus("저장됨 (주의: base_url 도메인 권한이 없어 호출이 차단될 수 있음)", "err");
}

async function wipeKey() {
  const got = await chromeGet([STORAGE_SETTINGS_KEY]);
  const s = { ...DEFAULTS, ...(got[STORAGE_SETTINGS_KEY] || {}) };
  s.apiKey = "";
  await chromeSet({ [STORAGE_SETTINGS_KEY]: s });
  $("apiKey").value = "";
  setStatus("키 삭제됨", "ok");
}

async function testConnection() {
  const s = collect();
  if (!s.apiKey) {
    setStatus("API 키가 비어있습니다.", "err");
    return;
  }

  setStatus("권한 확인 중...");
  const perm = await ensureBaseUrlPermission(s.baseUrl);
  if (!perm.ok) {
    setStatus(`권한 거절됨: ${perm.originPattern}`, "err");
    return;
  }

  setStatus("테스트 중...");
  const res = await chrome.runtime.sendMessage({ type: "openai_test", settings: s });
  if (res?.ok) {
    setStatus(`성공: ${res.message}`, "ok");
  } else {
    setStatus(`실패: ${res?.error || "알 수 없는 에러"}`, "err");
  }
}

$("save").addEventListener("click", () => save().catch((e) => setStatus(String(e?.message || e), "err")));
$("wipeKey").addEventListener("click", () => wipeKey().catch((e) => setStatus(String(e?.message || e), "err")));
$("test").addEventListener("click", () =>
  testConnection().catch((e) => setStatus(String(e?.message || e), "err"))
);

$("baseUrl").addEventListener("change", () => showPermissionState($("baseUrl").value));

load().catch((e) => setStatus(String(e?.message || e), "err"));
