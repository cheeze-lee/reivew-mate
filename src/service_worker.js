const STORAGE_SETTINGS_KEY = "reviewMateSettings";

function chromeGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function chromePermContains(origins) {
  return new Promise((resolve) =>
    chrome.permissions.contains({ origins }, (ok) => resolve(Boolean(ok)))
  );
}

function normalizeBaseUrl(url) {
  const v = String(url || "").trim();
  if (!v) return "https://api.openai.com/v1";
  return v.endsWith("/") ? v.slice(0, -1) : v;
}

function baseUrlToOriginPattern(baseUrl) {
  const u = new URL(normalizeBaseUrl(baseUrl));
  return `${u.origin}/*`;
}

function joinUrl(baseUrl, path) {
  const b = normalizeBaseUrl(baseUrl);
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

function headersFromSettings(settings) {
  const h = {
    Authorization: `Bearer ${settings.apiKey}`,
    "Content-Type": "application/json"
  };
  if (settings.orgId) h["OpenAI-Organization"] = settings.orgId;
  if (settings.projectId) h["OpenAI-Project"] = settings.projectId;
  return h;
}

async function getSettings() {
  const got = await chromeGet([STORAGE_SETTINGS_KEY]);
  const s = got[STORAGE_SETTINGS_KEY] || {};
  return {
    apiKey: String(s.apiKey || "").trim(),
    baseUrl: normalizeBaseUrl(s.baseUrl),
    orgId: String(s.orgId || "").trim(),
    projectId: String(s.projectId || "").trim(),
    apiMode: s.apiMode === "chat_completions" ? "chat_completions" : "responses",
    model: String(s.model || "gpt-5").trim() || "gpt-5",
    developerPrompt: String(s.developerPrompt || "").trim()
  };
}

async function testSettings(settings) {
  const originPattern = baseUrlToOriginPattern(settings.baseUrl);
  const hasPerm = await chromePermContains([originPattern]);
  if (!hasPerm) {
    return { ok: false, error: `Missing host permission: ${originPattern} (open extension options and Save/Test)` };
  }

  const url = joinUrl(settings.baseUrl, "/models");
  const res = await fetch(url, { method: "GET", headers: headersFromSettings(settings) });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status} ${res.statusText}${t ? `: ${t.slice(0, 180)}` : ""}` };
  }
  const json = await res.json().catch(() => ({}));
  const count = Array.isArray(json?.data) ? json.data.length : undefined;
  return { ok: true, message: count != null ? `models=${count}` : "ok" };
}

function parseSSEStream(readable, onData, onDone) {
  const decoder = new TextDecoder();
  let buf = "";

  async function pump() {
    const reader = readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Normalize CRLF to LF for simpler parsing.
        buf = buf.replace(/\r\n/g, "\n");
        while (true) {
          const idx = buf.indexOf("\n\n");
          if (idx === -1) break;
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = raw.split("\n");
          const dataLines = [];
          for (const line of lines) {
            if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (dataLines.length === 0) continue;
          const data = dataLines.join("\n").trim();
          onData(data);
        }
      }
    } finally {
      onDone?.();
      reader.releaseLock();
    }
  }

  return pump();
}

async function streamResponses({ settings, messages, requestId, port }) {
  const originPattern = baseUrlToOriginPattern(settings.baseUrl);
  const hasPerm = await chromePermContains([originPattern]);
  if (!hasPerm) throw new Error(`Missing host permission: ${originPattern}`);

  const url = joinUrl(settings.baseUrl, "/responses");
  const input = [];
  if (settings.developerPrompt) input.push({ role: "developer", content: settings.developerPrompt });
  input.push(...messages);

  const ac = new AbortController();
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headersFromSettings(settings), Accept: "text/event-stream" },
    body: JSON.stringify({ model: settings.model, input, stream: true }),
    signal: ac.signal
  });

  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}${t ? `: ${t.slice(0, 300)}` : ""}`);
  }

  parseSSEStream(
    res.body,
    (data) => {
      if (data === "[DONE]") {
        port.postMessage({ type: "done", requestId });
        return;
      }

      let evt;
      try {
        evt = JSON.parse(data);
      } catch {
        return;
      }

      if (evt?.type === "response.output_text.delta" && typeof evt.delta === "string") {
        port.postMessage({ type: "delta", requestId, delta: evt.delta });
      } else if (evt?.type === "response.output_text.done" && typeof evt.text === "string") {
        // No-op: deltas already cover the text; keep in case some providers only send done.
        // port.postMessage({ type: "delta", requestId, delta: evt.text });
      } else if (evt?.type === "response.completed" || evt?.type === "response.done") {
        port.postMessage({ type: "done", requestId });
      } else if (evt?.type === "error") {
        const msg = evt?.error?.message || "stream error";
        port.postMessage({ type: "error", requestId, error: { message: msg } });
      }
    },
    () => {
      // If the stream closes without explicit done, we still mark done.
      port.postMessage({ type: "done", requestId });
      active.delete(requestId);
    }
  ).catch((e) => {
    port.postMessage({ type: "error", requestId, error: { message: String(e?.message || e) } });
    active.delete(requestId);
  });

  return { abort: () => ac.abort() };
}

async function streamChatCompletions({ settings, messages, requestId, port }) {
  const originPattern = baseUrlToOriginPattern(settings.baseUrl);
  const hasPerm = await chromePermContains([originPattern]);
  if (!hasPerm) throw new Error(`Missing host permission: ${originPattern}`);

  const url = joinUrl(settings.baseUrl, "/chat/completions");
  const msgs = [];
  if (settings.developerPrompt) msgs.push({ role: "system", content: settings.developerPrompt });
  msgs.push(...messages);

  const ac = new AbortController();
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headersFromSettings(settings), Accept: "text/event-stream" },
    body: JSON.stringify({ model: settings.model, messages: msgs, stream: true }),
    signal: ac.signal
  });

  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}${t ? `: ${t.slice(0, 300)}` : ""}`);
  }

  parseSSEStream(
    res.body,
    (data) => {
      if (data === "[DONE]") {
        port.postMessage({ type: "done", requestId });
        return;
      }
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        return;
      }
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) port.postMessage({ type: "delta", requestId, delta });
    },
    () => {
      port.postMessage({ type: "done", requestId });
      active.delete(requestId);
    }
  ).catch((e) => {
    port.postMessage({ type: "error", requestId, error: { message: String(e?.message || e) } });
    active.delete(requestId);
  });

  return { abort: () => ac.abort() };
}

const active = new Map(); // requestId -> { abort, port }

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "reviewmate") return;

  port.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "abort" && msg.requestId) {
      const h = active.get(msg.requestId);
      if (h) h.abort();
      active.delete(msg.requestId);
      return;
    }

    if (msg.type !== "openai_stream") return;

    const requestId = String(msg.requestId || "").trim();
    const messages = Array.isArray(msg.messages) ? msg.messages : [];
    if (!requestId || messages.length === 0) {
      port.postMessage({ type: "error", requestId, error: { message: "invalid request" } });
      return;
    }

    const settings = await getSettings();
    if (!settings.apiKey) {
      port.postMessage({ type: "error", requestId, error: { message: "API key is missing" } });
      return;
    }

    try {
      const handler =
        settings.apiMode === "chat_completions"
          ? await streamChatCompletions({ settings, messages, requestId, port })
          : await streamResponses({ settings, messages, requestId, port });
      active.set(requestId, { abort: handler.abort, port });
    } catch (e) {
      port.postMessage({ type: "error", requestId, error: { message: String(e?.message || e) } });
    }
  });

  port.onDisconnect.addListener(() => {
    for (const [id, h] of active.entries()) {
      if (h.port !== port) continue;
      try {
        h.abort();
      } catch {}
      active.delete(id);
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "openai_test") {
    const settings = msg.settings;
    testSettings({
      apiKey: String(settings?.apiKey || "").trim(),
      baseUrl: normalizeBaseUrl(settings?.baseUrl),
      orgId: String(settings?.orgId || "").trim(),
      projectId: String(settings?.projectId || "").trim()
    })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg?.type === "open_options") {
    chrome.runtime.openOptionsPage().catch(() => {});
    sendResponse?.({ ok: true });
    return;
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-panel") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs?.[0]?.id;
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { type: "toggle_panel" });
  });
});
