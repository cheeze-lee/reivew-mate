(() => {
  const ROOT_ATTR = "data-reviewmate-injected";
  if (document.documentElement.hasAttribute(ROOT_ATTR)) return;
  document.documentElement.setAttribute(ROOT_ATTR, "1");

  const STORAGE_SETTINGS_KEY = "reviewMateSettings";
  const STORAGE_CONV_PREFIX = "reviewMateConversation:";

  const LIMITS = {
    maxSelectionChars: 8000,
    maxPrBodyChars: 2000,
    maxDiffChars: 60000,
    maxChangedFileCountInList: 60,
    maxRawFiles: 6,
    maxRawFileChars: 20000,
    maxTotalRawChars: 60000,
    maxRepoSearchTerms: 6,
    maxRepoSearchQueries: 4,
    maxRepoSearchResultsPerQuery: 8,
    maxRepoWideFiles: 8,
    maxRepoWideFileChars: 12000,
    maxRepoWideTotalChars: 90000,
    maxRepoWideTermChars: 48
  };

  const state = {
    open: false,
    includeSelection: true,
    includePrMeta: true,
    includePrDiff: true,
    includePrFiles: false,
    messages: [],
    streaming: null, // { requestId, assistantIndex }
    port: null,
    convKey: null,
    settingsSummary: null,
    context: {
      prKey: null,
      pr: null,
      diff: null,
      diffTruncated: false,
      rawFiles: [], // { path, url, text, truncated }
      rawTotalChars: 0,
      repoWideFiles: [], // { path, url, text, truncated, term }
      repoWideTotalChars: 0,
      repoWideTerms: [],
      repoWideKey: null,
      repoWideError: null,
      loading: false,
      error: null
    }
  };

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function nowTime() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function getConvKey() {
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (m) return `${url.origin}/${m[1]}/${m[2]}/pull/${m[3]}`;
    return `${url.origin}${url.pathname}`;
  }

  function chromeGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function chromeSet(items) {
    return new Promise((resolve) => chrome.storage.local.set(items, resolve));
  }

  function truncateText(s, maxChars) {
    const t = String(s || "");
    if (t.length <= maxChars) return { text: t, truncated: false };
    return { text: `${t.slice(0, maxChars)}\n\n[...truncated ${t.length - maxChars} chars]`, truncated: true };
  }

  function extractMermaidBlocks(text) {
    const src = String(text || "");
    const blocks = [];
    const re = /```mermaid\s*([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(src))) {
      const code = String(m[1] || "").trim();
      if (!code) continue;
      blocks.push({ code });
    }
    return blocks;
  }

  function removeUnsafeSvgContent(svgEl) {
    try {
      const forbidden = svgEl.querySelectorAll("script, foreignObject, iframe, object, embed");
      forbidden.forEach((n) => n.remove());
      const all = svgEl.querySelectorAll("*");
      all.forEach((el) => {
        // strip inline handlers
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase();
          const value = String(attr.value || "");
          if (name.startsWith("on")) el.removeAttribute(attr.name);
          if ((name === "href" || name === "xlink:href") && value.trim().toLowerCase().startsWith("javascript:")) {
            el.removeAttribute(attr.name);
          }
        }
      });
    } catch {
      // best-effort
    }
  }

  const mermaidCache = new Map(); // code -> svgOuterHTML

  let mermaidInited = false;

  function rmId(prefix = "rm") {
    try {
      if (crypto && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
    } catch {}
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function getMermaidGlobal() {
    // `mermaid.min.js` is loaded as a content_script (isolated world), so it should be on our global.
    // @ts-ignore
    const m = window.mermaid;
    if (!m) throw new Error("mermaid 라이브러리가 로드되지 않았습니다. (확장 프로그램을 reload 후 다시 시도)");
    return m;
  }

  function ensureMermaidInit() {
    const mermaid = getMermaidGlobal();
    if (mermaidInited) return mermaid;

    // Prefer pure-SVG labels to avoid SVG <foreignObject> (safer + less likely to break in some contexts).
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
      flowchart: { htmlLabels: false },
      sequence: { htmlLabels: false }
    });
    mermaidInited = true;
    return mermaid;
  }

  async function renderMermaid(code) {
    const mermaid = ensureMermaidInit();
    const src = String(code || "").trim();
    if (!src) throw new Error("mermaid 코드가 비어있습니다.");
    const out = await mermaid.render(rmId("rm-mermaid"), src);
    const svgText = String(out?.svg || "");
    if (!svgText) throw new Error("mermaid 렌더 결과가 비어있습니다.");

    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svg = doc.querySelector("svg");
    if (!svg) throw new Error("SVG 파싱 실패");

    removeUnsafeSvgContent(svg);

    // Make the SVG responsive in our panel container.
    svg.removeAttribute("height");
    svg.setAttribute("style", "max-width: 100%; height: auto; background: transparent;");
    if (!svg.getAttribute("xmlns")) svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return svg.outerHTML;
  }

  function getCsrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || "";
  }

  function parsePrFromUrl() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!m) return null;
    return { owner: m[1], repo: m[2], number: Number(m[3]) };
  }

  function prKeyFromPr(pr) {
    return pr ? `${pr.owner}/${pr.repo}#${pr.number}` : null;
  }

  function getPrBaseUrl(pr) {
    return `${location.origin}/${pr.owner}/${pr.repo}/pull/${pr.number}`;
  }

  async function ghGraphql(query, variables) {
    const csrf = getCsrfToken();
    const res = await fetch("https://github.com/graphql", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-CSRF-Token": csrf
      },
      body: JSON.stringify({ query, variables })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`GitHub GraphQL HTTP ${res.status} ${res.statusText}${t ? `: ${t.slice(0, 180)}` : ""}`);
    }
    const json = await res.json().catch(() => null);
    if (!json) throw new Error("GitHub GraphQL: invalid JSON response");
    if (Array.isArray(json.errors) && json.errors.length) {
      throw new Error(`GitHub GraphQL: ${json.errors[0]?.message || "unknown error"}`);
    }
    return json.data;
  }

  async function loadPrMeta(pr) {
    const query = `
      query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            url
            title
            bodyText
            baseRefName
            headRefName
            headRefOid
            headRepository { nameWithOwner }
            files(first: 100) { nodes { path } totalCount }
          }
        }
      }
    `;
    const data = await ghGraphql(query, { owner: pr.owner, name: pr.repo, number: pr.number });
    const prNode = data?.repository?.pullRequest;
    if (!prNode) throw new Error("PR 메타를 찾지 못했습니다. (권한/로그인 상태 확인)");
    const files = Array.isArray(prNode.files?.nodes) ? prNode.files.nodes.map((n) => n?.path).filter(Boolean) : [];
    const { text: bodyText, truncated: bodyTrunc } = truncateText(prNode.bodyText || "", LIMITS.maxPrBodyChars);
    return {
      url: prNode.url || getPrBaseUrl(pr),
      title: prNode.title || "",
      bodyText,
      bodyTruncated: bodyTrunc,
      baseRefName: prNode.baseRefName || "",
      headRefName: prNode.headRefName || "",
      headRefOid: prNode.headRefOid || "",
      headRepository: prNode.headRepository?.nameWithOwner || `${pr.owner}/${pr.repo}`,
      files,
      totalFiles: Number(prNode.files?.totalCount || files.length || 0)
    };
  }

  async function ensurePrMeta() {
    const pr = parsePrFromUrl();
    if (!pr) return;
    const key = prKeyFromPr(pr);
    if (state.context.prKey === key && state.context.pr) return;

    state.context.prKey = key;
    state.context.pr = null;
    state.context.diff = null;
    state.context.diffTruncated = false;
    state.context.rawFiles = [];
    state.context.rawTotalChars = 0;
    state.context.repoWideFiles = [];
    state.context.repoWideTotalChars = 0;
    state.context.repoWideTerms = [];
    state.context.repoWideKey = null;
    state.context.repoWideError = null;
    state.context.error = null;

    updateSubtitle();
    try {
      state.context.loading = true;
      updateSubtitle();
      state.context.pr = await loadPrMeta(pr);
    } catch (e) {
      state.context.error = String(e?.message || e);
    } finally {
      state.context.loading = false;
      updateSubtitle();
    }
  }

  async function ensurePrDiff() {
    if (state.context.diff) return;
    const pr = parsePrFromUrl();
    if (!pr) return;
    const url = `${getPrBaseUrl(pr)}.diff`;
    try {
      state.context.loading = true;
      state.context.error = null;
      updateSubtitle();
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`PR diff HTTP ${res.status} ${res.statusText}${t ? `: ${t.slice(0, 180)}` : ""}`);
      }
      const text = await res.text();
      const { text: diff, truncated } = truncateText(text, LIMITS.maxDiffChars);
      state.context.diff = diff;
      state.context.diffTruncated = truncated;
    } catch (e) {
      state.context.error = String(e?.message || e);
    } finally {
      state.context.loading = false;
      updateSubtitle();
    }
  }

  function looksLikeTextContentType(ct) {
    const v = String(ct || "").toLowerCase();
    if (!v) return true;
    if (v.startsWith("text/")) return true;
    if (v.includes("json")) return true;
    if (v.includes("javascript")) return true;
    if (v.includes("xml")) return true;
    if (v.includes("yaml") || v.includes("yml")) return true;
    if (v.includes("x-python")) return true;
    if (v.includes("x-sh")) return true;
    if (v.includes("x-c")) return true;
    if (v.includes("x-c++")) return true;
    if (v.includes("x-java")) return true;
    if (v.includes("x-rust")) return true;
    if (v.includes("x-go")) return true;
    return false;
  }

  async function fetchRawFile(repoFullName, ref, path, maxChars) {
    const url = `https://github.com/${repoFullName}/raw/${ref}/${path}`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!looksLikeTextContentType(ct)) return { path, url, text: `[skipped non-text content-type: ${ct}]`, truncated: true };
    const text = await res.text();
    const { text: clipped, truncated } = truncateText(text, maxChars);
    return { path, url, text: clipped, truncated };
  }

  const REPO_SEARCH_STOPWORDS = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "there",
    "into",
    "about",
    "review",
    "reviews",
    "comment",
    "comments",
    "code",
    "files",
    "file",
    "diff",
    "repo",
    "github",
    "model",
    "openai",
    "please",
    "help",
    "test",
    "tests",
    "risk",
    "risks",
    "security",
    "architecture",
    "change",
    "changes",
    "api",
    "옵션",
    "리뷰",
    "코드",
    "변경",
    "파일",
    "테스트",
    "보안",
    "아키텍처",
    "요약",
    "질문",
    "요청"
  ]);

  const NON_SOURCE_EXTENSIONS = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".ico",
    ".pdf",
    ".zip",
    ".gz",
    ".tar",
    ".mp4",
    ".mov",
    ".avi",
    ".mp3",
    ".wav",
    ".ttf",
    ".otf",
    ".woff",
    ".woff2",
    ".eot",
    ".jar",
    ".class",
    ".lock"
  ];

  function normalizeRepoSearchTerm(term) {
    const raw = String(term || "").trim();
    if (!raw) return "";
    const cleaned = raw.replace(/[`"'\\]/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return "";
    return cleaned.length > LIMITS.maxRepoWideTermChars ? cleaned.slice(0, LIMITS.maxRepoWideTermChars) : cleaned;
  }

  function pathTokenize(path) {
    const parts = String(path || "")
      .split("/")
      .map((s) => String(s || "").trim())
      .filter(Boolean);
    const out = [];
    for (const p of parts.slice(-3)) {
      const stem = p.replace(/\.[^.]+$/, "");
      if (!stem) continue;
      out.push(stem);
    }
    return out;
  }

  function looksUsefulRepoPath(path) {
    const p = String(path || "").toLowerCase();
    if (!p || p.endsWith("/")) return false;
    if (
      p.includes("/node_modules/") ||
      p.includes("/dist/") ||
      p.includes("/build/") ||
      p.includes("/coverage/") ||
      p.includes("/.next/") ||
      p.includes("/__pycache__/") ||
      p.includes("/vendor/")
    ) {
      return false;
    }
    return !NON_SOURCE_EXTENSIONS.some((ext) => p.endsWith(ext));
  }

  function extractAsciiTokens(text) {
    const m = String(text || "").match(/[A-Za-z_][A-Za-z0-9_]{2,}/g);
    return Array.isArray(m) ? m : [];
  }

  function extractRepoSearchTerms(userText, selection, fileInfo, pr) {
    const out = [];
    const seen = new Set();

    function addTerm(v) {
      const t = normalizeRepoSearchTerm(v);
      if (!t) return;
      const lower = t.toLowerCase();
      if (REPO_SEARCH_STOPWORDS.has(lower)) return;
      if (lower.length < 3) return;
      if (/^\d+$/.test(lower)) return;
      if (seen.has(lower)) return;
      seen.add(lower);
      out.push(t);
    }

    const ident = extractIdentifierFromSelection(selection);
    if (ident) addTerm(ident);

    for (const tok of extractAsciiTokens(`${userText || ""}\n${selection || ""}`)) addTerm(tok);
    for (const tok of pathTokenize(fileInfo?.path || "")) addTerm(tok);

    // Fallback terms for non-English prompts where identifier extraction can be sparse.
    if (out.length < LIMITS.maxRepoSearchTerms && Array.isArray(pr?.files)) {
      for (const p of pr.files.slice(0, 16)) {
        for (const tok of pathTokenize(p)) addTerm(tok);
        if (out.length >= LIMITS.maxRepoSearchTerms) break;
      }
    }

    if (out.length < LIMITS.maxRepoSearchTerms) {
      const repoName = String(pr?.headRepository || "").split("/").pop();
      addTerm(repoName);
    }

    return out.slice(0, LIMITS.maxRepoSearchTerms);
  }

  async function searchRepoCodePaths(repo, terms) {
    const query = `
      query($query: String!, $first: Int!) {
        search(type: CODE, query: $query, first: $first) {
          edges {
            node {
              ... on Blob {
                url
              }
            }
          }
        }
      }
    `;

    const found = new Map(); // path -> { path, term }
    let firstError = null;
    const pickedTerms = terms.slice(0, LIMITS.maxRepoSearchQueries);

    for (const term of pickedTerms) {
      const q = `repo:${repo} ${term}`;
      try {
        const data = await ghGraphql(query, { query: q, first: LIMITS.maxRepoSearchResultsPerQuery });
        const edges = Array.isArray(data?.search?.edges) ? data.search.edges : [];
        for (const edge of edges) {
          const url = edge?.node?.url;
          if (!url) continue;
          const path = parsePathFromBlobUrl(url);
          if (!path || !looksUsefulRepoPath(path)) continue;
          if (!found.has(path)) found.set(path, { path, term });
        }
      } catch (e) {
        if (!firstError) firstError = e;
      }
    }

    if (found.size === 0 && firstError) throw firstError;
    return Array.from(found.values());
  }

  async function ensureRepoWideFiles(userText) {
    await ensurePrMeta();
    const pr = state.context.pr;
    if (!pr?.headRepository || !pr?.headRefOid) return;

    const selection = state.includeSelection ? getSelectedText() : "";
    const fileInfo = getSelectionFileInfo();
    const terms = extractRepoSearchTerms(userText, selection, fileInfo, pr);
    const key = `${pr.headRepository}@${pr.headRefOid}|${terms.join("|")}`;

    if (state.context.repoWideKey === key && state.context.repoWideFiles.length) return;

    state.context.repoWideFiles = [];
    state.context.repoWideTotalChars = 0;
    state.context.repoWideTerms = terms;
    state.context.repoWideKey = key;
    state.context.repoWideError = null;

    if (terms.length === 0) {
      state.context.repoWideError = "전체 리포 탐색용 검색어를 추출하지 못했습니다.";
      updateSubtitle();
      return;
    }

    try {
      state.context.loading = true;
      updateSubtitle();

      const hits = await searchRepoCodePaths(pr.headRepository, terms);
      if (hits.length === 0) {
        state.context.repoWideError = `리포 코드 검색 결과가 없습니다. (terms: ${terms.join(", ")})`;
        return;
      }

      const changedSet = new Set(Array.isArray(pr.files) ? pr.files : []);
      const orderedHits = hits.slice().sort((a, b) => Number(changedSet.has(a.path)) - Number(changedSet.has(b.path)));

      const picked = [];
      let totalChars = 0;
      for (const hit of orderedHits) {
        if (picked.length >= LIMITS.maxRepoWideFiles) break;
        if (totalChars >= LIMITS.maxRepoWideTotalChars) break;
        const raw = await fetchRawFile(pr.headRepository, pr.headRefOid, hit.path, LIMITS.maxRepoWideFileChars);
        if (!raw) continue;
        picked.push({ ...raw, term: hit.term, changed: changedSet.has(hit.path) });
        totalChars += (raw.text || "").length;
      }

      state.context.repoWideFiles = picked;
      state.context.repoWideTotalChars = totalChars;
      if (picked.length === 0) {
        state.context.repoWideError = "리포 탐색 결과에서 읽을 수 있는 텍스트 파일을 찾지 못했습니다.";
      }
    } catch (e) {
      state.context.repoWideError = String(e?.message || e);
    } finally {
      state.context.loading = false;
      updateSubtitle();
    }
  }

  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function extractIdentifierFromSelection(selection) {
    const s = String(selection || "");
    const m = s.match(/[A-Za-z_$][A-Za-z0-9_$]*/);
    return m ? m[0] : "";
  }

  function buildDefinitionPatterns(ident) {
    const id = escapeRegex(ident);
    return [
      new RegExp(`^\\s*(export\\s+)?(default\\s+)?(async\\s+)?function\\s+${id}\\b`),
      new RegExp(`^\\s*(export\\s+)?(default\\s+)?(const|let|var)\\s+${id}\\s*=\\s*(async\\s*)?\\(`),
      new RegExp(`^\\s*(export\\s+)?(default\\s+)?(const|let|var)\\s+${id}\\s*=\\s*(async\\s*)?function\\b`),
      new RegExp(`^\\s*(export\\s+)?(default\\s+)?class\\s+${id}\\b`),
      new RegExp(`^\\s*def\\s+${id}\\b`),
      new RegExp(`^\\s*class\\s+${id}\\b`),
      new RegExp(`^\\s*func\\s*(\\([^)]*\\)\\s*)?${id}\\b`),
      new RegExp(`^\\s*fn\\s+${id}\\b`)
    ];
  }

  function findDefinitionInText(ident, text) {
    const lines = String(text || "").split("\n");
    const patterns = buildDefinitionPatterns(ident);
    let hit = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (patterns.some((p) => p.test(line))) {
        hit = i;
        break;
      }
    }
    if (hit === -1) return null;

    const from = Math.max(0, hit - 10);
    const to = Math.min(lines.length, hit + 18);
    const snippet = [];
    for (let i = from; i < to; i++) {
      const no = String(i + 1).padStart(5, " ");
      snippet.push(`${no} | ${lines[i]}`);
    }
    return { hitLine: hit + 1, snippet: snippet.join("\n") };
  }

  function parsePathFromBlobUrl(blobUrl) {
    try {
      const u = new URL(blobUrl);
      const parts = u.pathname.split("/");
      const blobIdx = parts.indexOf("blob");
      if (blobIdx === -1) return null;
      const pathParts = parts.slice(blobIdx + 2);
      return decodeURIComponent(pathParts.join("/"));
    } catch {
      return null;
    }
  }

  async function repoDefinitionLookup(ident) {
    await ensurePrMeta();
    const pr = state.context.pr;
    if (!pr?.headRepository || !pr?.headRefOid) {
      pushMsg("assistant", "PR 컨텍스트(HEAD repo/SHA)를 못 가져와서 리포 정의 찾기를 할 수 없습니다.");
      renderMessages({ scroll: true });
      return;
    }

    const repo = pr.headRepository;
    const sha = pr.headRefOid;
    const query = `
      query($query: String!, $first: Int!) {
        search(type: CODE, query: $query, first: $first) {
          edges {
            node {
              ... on Blob {
                url
                repository { nameWithOwner }
              }
            }
          }
        }
      }
    `;

    const q = `repo:${repo} ${ident}`;
    let edges = [];
    try {
      const data = await ghGraphql(query, { query: q, first: 10 });
      edges = Array.isArray(data?.search?.edges) ? data.search.edges : [];
    } catch (e) {
      pushMsg("assistant", `GitHub 코드 검색 실패: ${String(e?.message || e)}`);
      renderMessages({ scroll: true });
      return;
    }

    const paths = [];
    for (const e of edges) {
      const url = e?.node?.url;
      if (!url) continue;
      const p = parsePathFromBlobUrl(url);
      if (p) paths.push(p);
    }
    const uniq = Array.from(new Set(paths));
    if (uniq.length === 0) {
      pushMsg("assistant", `리포 코드 검색 결과가 없습니다: ${ident} (query: ${q})`);
      renderMessages({ scroll: true });
      return;
    }

    const hits = [];
    const tried = [];
    for (const path of uniq) {
      if (hits.length >= 3) break;
      tried.push(path);
      const raw = await fetchRawFile(repo, sha, path, LIMITS.maxRawFileChars);
      if (!raw) continue;
      const def = findDefinitionInText(ident, raw.text);
      if (!def) continue;
      hits.push({
        path,
        line: def.hitLine,
        snippet: def.snippet,
        blob: `https://github.com/${repo}/blob/${sha}/${path}#L${def.hitLine}`,
        raw: `https://github.com/${repo}/raw/${sha}/${path}`
      });
    }

    if (hits.length === 0) {
      pushMsg(
        "assistant",
        `리포 검색은 됐지만 정의 패턴을 못 찾았습니다: ${ident}\n\n후보 파일:\n${tried
          .slice(0, 10)
          .map((p) => `- ${p}`)
          .join("\n")}\n\nTip: 파일을 직접 열어 확인하거나, 다른 키워드(예: class/function/def)를 선택해보세요.`
      );
      renderMessages({ scroll: true });
      return;
    }

    const out = [];
    out.push(`리포 정의 후보: ${ident} (top ${hits.length})`);
    for (const h of hits) {
      out.push(`\n파일: ${h.path}:${h.line}`);
      out.push("```");
      out.push(h.snippet);
      out.push("```");
      out.push(`보기: ${h.blob}`);
    }
    pushMsg("assistant", out.join("\n"));
    renderMessages({ scroll: true });
  }

  async function ensurePrFilesRaw() {
    if (state.context.rawFiles.length) return;
    await ensurePrMeta();
    const pr = state.context.pr;
    if (!pr?.headRefOid) return;
    if (!Array.isArray(pr.files) || pr.files.length === 0) return;

    const selectionInfo = getSelectionFileInfo();
    const preferred = selectionInfo?.path ? [selectionInfo.path] : [];
    const paths = Array.from(new Set(preferred.concat(pr.files))).filter(Boolean);

    try {
      state.context.loading = true;
      state.context.error = null;
      updateSubtitle();

      const picked = [];
      let totalChars = 0;
      for (const p of paths) {
        if (picked.length >= LIMITS.maxRawFiles) break;
        if (totalChars >= LIMITS.maxTotalRawChars) break;

        const one = await fetchRawFile(pr.headRepository, pr.headRefOid, p, LIMITS.maxRawFileChars);
        if (!one) continue;
        picked.push(one);
        totalChars += (one.text || "").length;
      }

      state.context.rawFiles = picked;
      state.context.rawTotalChars = totalChars;
    } catch (e) {
      state.context.error = String(e?.message || e);
    } finally {
      state.context.loading = false;
      updateSubtitle();
    }
  }

  async function loadConversation() {
    const key = `${STORAGE_CONV_PREFIX}${getConvKey()}`;
    const got = await chromeGet([key]);
    const msgs = got[key];
    state.messages = Array.isArray(msgs) ? msgs : [];
  }

  async function saveConversation() {
    const key = `${STORAGE_CONV_PREFIX}${getConvKey()}`;
    const trimmed = state.messages.slice(-50);
    await chromeSet({ [key]: trimmed });
  }

  async function clearConversation() {
    state.messages = [];
    await saveConversation();
    renderMessages();
  }

  function ensurePort() {
    if (state.port) return state.port;
    const port = chrome.runtime.connect({ name: "reviewmate" });
    port.onDisconnect.addListener(() => {
      state.port = null;
    });
    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "delta") onDelta(msg);
      if (msg.type === "done") onDone(msg);
      if (msg.type === "error") onError(msg);
    });
    state.port = port;
    return port;
  }

  function getSelectedText() {
    const sel = window.getSelection();
    if (!sel) return "";
    const t = sel.toString();
    return (t || "").trim();
  }

  function nodeToElement(node) {
    if (!node) return null;
    // Text nodes -> parent element
    // @ts-ignore
    if (node.nodeType === Node.ELEMENT_NODE) return node;
    // @ts-ignore
    return node.parentElement || null;
  }

  function findFileRootFromElement(el) {
    if (!el || !(el instanceof Element)) return null;
    return el.closest("div.js-file, div.file") || null;
  }

  function findVisibleFileRoot() {
    const roots = Array.from(document.querySelectorAll("div.js-file, div.file"));
    let best = null;
    let bestScore = Infinity;
    for (const r of roots) {
      const rect = r.getBoundingClientRect();
      const visible = rect.bottom > 0 && rect.top < window.innerHeight;
      if (!visible) continue;
      const score = Math.abs(rect.top);
      if (score < bestScore) {
        best = r;
        bestScore = score;
      }
    }
    return best;
  }

  function getFileInfoFromRoot(root) {
    if (!root) return null;
    const pathAttr =
      root.getAttribute("data-tagsearch-path") ||
      root.getAttribute("data-path") ||
      root.querySelector("[data-path]")?.getAttribute("data-path") ||
      "";

    const header = root.querySelector(".file-header") || root;
    const blobA =
      header.querySelector('a.Link--primary[href*="/blob/"]') ||
      header.querySelector('a[href*="/blob/"]') ||
      null;
    const blobUrl = blobA ? new URL(blobA.getAttribute("href"), location.origin).toString() : "";
    const rawUrl = blobUrl ? blobUrl.replace("/blob/", "/raw/") : "";

    const pathText = blobA?.textContent?.trim() || "";
    const path = pathAttr || pathText;

    return { path, blobUrl, rawUrl };
  }

  function getSelectionFileInfo() {
    const sel = window.getSelection();
    const el = nodeToElement(sel?.focusNode || sel?.anchorNode);
    const root = findFileRootFromElement(el) || findVisibleFileRoot();
    return getFileInfoFromRoot(root);
  }

  function buildUserContentCompact(userText) {
    const selection = state.includeSelection ? getSelectedText() : "";
    const fileInfo = selection ? getSelectionFileInfo() : null;
    const pieces = [];
    pieces.push(`GitHub PR URL: ${location.href}`);
    if (fileInfo?.path) pieces.push(`선택 파일: ${fileInfo.path}`);
    if (selection) {
      const { text: clipped } = truncateText(selection, LIMITS.maxSelectionChars);
      pieces.push("선택한 코드:");
      pieces.push("```");
      pieces.push(clipped);
      pieces.push("```");
    }
    pieces.push("질문/요청:");
    pieces.push(userText);
    return pieces.join("\n");
  }

  function buildUserContentFull(userText) {
    const selection = state.includeSelection ? getSelectedText() : "";
    const fileInfo = selection ? getSelectionFileInfo() : null;
    const pieces = [];
    pieces.push(`GitHub PR URL: ${location.href}`);

    if (state.includePrMeta && state.context.pr) {
      const pr = state.context.pr;
      pieces.push(`PR 제목: ${pr.title || ""}`);
      pieces.push(`base: ${pr.baseRefName || ""}  head: ${pr.headRefName || ""}`);
      if (pr.headRepository) pieces.push(`head repo: ${pr.headRepository}`);
      if (pr.bodyText) {
        pieces.push("PR 설명:");
        pieces.push(pr.bodyText);
        if (pr.bodyTruncated) pieces.push("[...truncated PR body]");
      }
      if (Array.isArray(pr.files) && pr.files.length) {
        const listed = pr.files.slice(0, LIMITS.maxChangedFileCountInList);
        pieces.push(`변경 파일(${pr.totalFiles || pr.files.length}):`);
        pieces.push(listed.map((p) => `- ${p}`).join("\n"));
        if (pr.files.length > listed.length) pieces.push(`[...and ${pr.files.length - listed.length} more]`);
      }
    }

    if (fileInfo?.path) pieces.push(`선택 파일: ${fileInfo.path}`);
    if (selection) {
      const { text: clipped } = truncateText(selection, LIMITS.maxSelectionChars);
      pieces.push("선택한 코드:");
      pieces.push("```");
      pieces.push(clipped);
      pieces.push("```");
    }

    if (state.includePrDiff) {
      if (state.context.diff) {
        pieces.push(`PR diff${state.context.diffTruncated ? " (truncated)" : ""}:`);
        pieces.push("```diff");
        pieces.push(state.context.diff);
        pieces.push("```");
      } else if (state.context.error) {
        pieces.push(`PR diff를 불러오지 못했습니다: ${state.context.error}`);
      } else {
        pieces.push("PR diff가 아직 로드되지 않았습니다.");
      }
    }

    if (state.includePrFiles) {
      if (state.context.rawFiles.length) {
        pieces.push(
          `변경 파일 원문(최대 ${LIMITS.maxRawFiles}개, 파일당 ${LIMITS.maxRawFileChars} chars, 총 ${LIMITS.maxTotalRawChars} chars)`
        );
        for (const f of state.context.rawFiles) {
          pieces.push(`파일: ${f.path}${f.truncated ? " (truncated)" : ""}`);
          pieces.push("```");
          pieces.push(f.text);
          pieces.push("```");
          pieces.push(`raw: ${f.url}`);
        }
      } else if (state.context.error) {
        pieces.push(`변경 파일 원문을 불러오지 못했습니다: ${state.context.error}`);
      } else {
        pieces.push("변경 파일 원문이 아직 로드되지 않았습니다.");
      }
    }

    if (state.context.repoWideFiles.length) {
      const terms = state.context.repoWideTerms.join(", ");
      pieces.push(
        `전체 리포 탐색 컨텍스트(자동, 검색어: ${terms || "n/a"}, 최대 ${LIMITS.maxRepoWideFiles}개, 파일당 ${LIMITS.maxRepoWideFileChars} chars, 총 ${LIMITS.maxRepoWideTotalChars} chars)`
      );
      for (const f of state.context.repoWideFiles) {
        const tag = [];
        if (f.changed) tag.push("changed-file");
        if (f.term) tag.push(`match:${f.term}`);
        const tagText = tag.length ? ` [${tag.join(", ")}]` : "";
        pieces.push(`파일: ${f.path}${tagText}${f.truncated ? " (truncated)" : ""}`);
        pieces.push("```");
        pieces.push(f.text);
        pieces.push("```");
        pieces.push(`raw: ${f.url}`);
      }
    } else if (state.context.repoWideError) {
      pieces.push(`전체 리포 탐색을 불러오지 못했습니다: ${state.context.repoWideError}`);
    } else {
      pieces.push("전체 리포 탐색 컨텍스트가 아직 로드되지 않았습니다.");
    }

    if (state.context.error) pieces.push(`(컨텍스트 에러) ${state.context.error}`);

    pieces.push("질문/요청:");
    pieces.push(userText);
    return pieces.join("\n");
  }

  function mkMsg(role, content, display) {
    return { role, content, display, ts: nowTime() };
  }

  function pushMsg(role, content, display) {
    state.messages.push(mkMsg(role, content, display));
    saveConversation().catch(() => {});
  }

  function setAssistantDraft(requestId) {
    const idx = state.messages.length;
    state.messages.push(mkMsg("assistant", ""));
    state.streaming = { requestId, assistantIndex: idx };
    renderMessages();
  }

  function appendAssistantDelta(delta) {
    if (!state.streaming) return;
    const idx = state.streaming.assistantIndex;
    if (!state.messages[idx]) return;
    state.messages[idx].content += delta;
    renderMessages({ scroll: true });
  }

  function endStreaming() {
    state.streaming = null;
    saveConversation().catch(() => {});
    renderMessages({ scroll: true });
  }

  function onDelta({ requestId, delta }) {
    if (!state.streaming || state.streaming.requestId !== requestId) return;
    appendAssistantDelta(delta || "");
  }

  function onDone({ requestId }) {
    if (!state.streaming || state.streaming.requestId !== requestId) return;
    endStreaming();
    setBusy(false);
  }

  function onError({ requestId, error }) {
    if (!state.streaming || state.streaming.requestId !== requestId) return;
    appendAssistantDelta(`\n\n[에러] ${error?.message || "요청 실패"}`);
    endStreaming();
    setBusy(false);
  }

  async function getSettingsSummary() {
    const got = await chromeGet([STORAGE_SETTINGS_KEY]);
    const s = got[STORAGE_SETTINGS_KEY] || {};
    const baseUrl = s.baseUrl || "https://api.openai.com/v1";
    const apiMode = s.apiMode || "responses";
    const model = s.model || "gpt-5";
    const hasKey = Boolean(s.apiKey && String(s.apiKey).trim());
    return { baseUrl, apiMode, model, hasKey };
  }

  function updateSubtitle() {
    const subtitle = document.querySelector("#reviewmate-subtitle");
    if (!subtitle) return;
    const parts = [];
    if (state.settingsSummary) parts.push(`${state.settingsSummary.apiMode} · ${state.settingsSummary.model}`);
    const ctx = state.context;
    if (ctx.loading) parts.push("ctx loading...");
    if (ctx.pr) parts.push(`PR files:${ctx.pr.totalFiles || ctx.pr.files?.length || 0}`);
    if (ctx.diff) parts.push(`diff:${Math.round((ctx.diff.length || 0) / 1000)}k`);
    if (ctx.rawFiles?.length) parts.push(`raw:${ctx.rawFiles.length}`);
    if (ctx.repoWideFiles?.length) parts.push(`repo:${ctx.repoWideFiles.length}`);
    if (ctx.repoWideError) parts.push("repo ctx err");
    if (ctx.error) parts.push("ctx err");
    subtitle.textContent = parts.join(" · ") || "GitHub PR에서 바로 질의응답";
  }

  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function sendToModel(userText) {
    const summary = await getSettingsSummary();
    if (!summary.hasKey) {
      pushMsg(
        "assistant",
        "옵션에서 API 키를 먼저 설정하세요. (확장 프로그램 아이콘 > 옵션 또는 패널의 '옵션' 버튼)"
      );
      renderMessages({ scroll: true });
      return;
    }

    const requestId = uuid();

    // Ensure repo/PR context is loaded.
    await ensurePrMeta();
    if (state.includePrDiff) await ensurePrDiff();
    if (state.includePrFiles) await ensurePrFilesRaw();
    await ensureRepoWideFiles(userText);

    // Build the model-facing full content (includes selection + repo context).
    const userContentFull = buildUserContentFull(userText);

    // Store compact content for history to avoid bloating the context window.
    const userContentCompact = buildUserContentCompact(userText);

    // History should not include the new message yet.
    const history = state.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));

    pushMsg("user", userContentCompact, userText);
    setAssistantDraft(requestId);
    setBusy(true);

    const port = ensurePort();
    port.postMessage({
      type: "openai_stream",
      requestId,
      messages: history.concat([{ role: "user", content: userContentFull }])
    });
  }

  function setBusy(busy) {
    const sendBtn = document.querySelector("#reviewmate-send");
    const ta = document.querySelector("#reviewmate-input");
    if (sendBtn) sendBtn.disabled = busy;
    if (ta) ta.disabled = busy;
  }

  function togglePanel(next) {
    const panel = document.querySelector("#reviewmate-panel");
    if (!panel) return;
    state.open = typeof next === "boolean" ? next : !state.open;
    panel.classList.toggle("rm-open", state.open);
  }

  function renderMessages(opts = {}) {
    const body = document.querySelector("#reviewmate-body");
    if (!body) return;
    body.innerHTML = "";

    for (const m of state.messages) {
      const el = document.createElement("div");
      el.className = `rm-msg ${m.role === "user" ? "rm-user" : "rm-assistant"}`;

      const meta = document.createElement("div");
      meta.className = "rm-meta";
      const left = document.createElement("span");
      left.textContent = m.role === "user" ? "나" : "모델";
      const right = document.createElement("span");
      right.style.display = "inline-flex";
      right.style.alignItems = "center";
      right.style.gap = "8px";

      const time = document.createElement("span");
      time.textContent = m.ts || "";
      right.append(time);

      if (m.role === "assistant" && String(m.content || "").trim()) {
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "rm-mini";
        copyBtn.textContent = "복사";
        copyBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(String(m.content || ""));
            copyBtn.textContent = "복사됨";
            setTimeout(() => {
              copyBtn.textContent = "복사";
            }, 900);
          } catch {
            copyBtn.textContent = "실패";
            setTimeout(() => {
              copyBtn.textContent = "복사";
            }, 900);
          }
        });
        right.append(copyBtn);
      }

      meta.append(left, right);

      const pre = document.createElement("pre");
      pre.textContent = m.display ?? m.content ?? "";

      el.append(meta, pre);

      if (m.role === "assistant") {
        const blocks = extractMermaidBlocks(m.content || "");
        for (const b of blocks) {
          const wrap = document.createElement("div");
          wrap.className = "rm-mermaid";

          const toolbar = document.createElement("div");
          toolbar.className = "rm-mermaid-toolbar";

          const leftBox = document.createElement("div");
          leftBox.className = "rm-left";
          const badge = document.createElement("span");
          badge.className = "rm-badge";
          badge.textContent = "mermaid";
          leftBox.append(badge);

          const rightBox = document.createElement("div");
          rightBox.style.display = "inline-flex";
          rightBox.style.gap = "8px";
          rightBox.style.alignItems = "center";

          const renderBtn = document.createElement("button");
          renderBtn.type = "button";
          renderBtn.className = "rm-mini";
          renderBtn.textContent = "렌더";

          const copyCodeBtn = document.createElement("button");
          copyCodeBtn.type = "button";
          copyCodeBtn.className = "rm-mini";
          copyCodeBtn.textContent = "코드 복사";

          const copySvgBtn = document.createElement("button");
          copySvgBtn.type = "button";
          copySvgBtn.className = "rm-mini";
          copySvgBtn.textContent = "SVG 복사";
          copySvgBtn.disabled = true;

          rightBox.append(renderBtn, copyCodeBtn, copySvgBtn);
          toolbar.append(leftBox, rightBox);

          const diagram = document.createElement("div");
          diagram.className = "rm-mermaid-diagram";
          diagram.textContent = "렌더를 누르면 다이어그램이 표시됩니다.";

          const codePre = document.createElement("pre");
          codePre.className = "rm-mermaid-code";
          codePre.textContent = b.code;

          const cached = mermaidCache.get(b.code);
          if (cached) {
            diagram.innerHTML = cached;
            copySvgBtn.disabled = false;
          }

          copyCodeBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            try {
              await navigator.clipboard.writeText(b.code);
              copyCodeBtn.textContent = "복사됨";
              setTimeout(() => (copyCodeBtn.textContent = "코드 복사"), 900);
            } catch {
              copyCodeBtn.textContent = "실패";
              setTimeout(() => (copyCodeBtn.textContent = "코드 복사"), 900);
            }
          });

          copySvgBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const svg = mermaidCache.get(b.code);
            if (!svg) return;
            try {
              await navigator.clipboard.writeText(svg);
              copySvgBtn.textContent = "복사됨";
              setTimeout(() => (copySvgBtn.textContent = "SVG 복사"), 900);
            } catch {
              copySvgBtn.textContent = "실패";
              setTimeout(() => (copySvgBtn.textContent = "SVG 복사"), 900);
            }
          });

          renderBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const existing = mermaidCache.get(b.code);
            if (existing) {
              diagram.innerHTML = existing;
              copySvgBtn.disabled = false;
              return;
            }
            renderBtn.disabled = true;
            diagram.textContent = "렌더링 중...";
            try {
              const svg = await renderMermaid(b.code);
              mermaidCache.set(b.code, svg);
              diagram.innerHTML = svg;
              copySvgBtn.disabled = false;
            } catch (err) {
              diagram.textContent = `렌더 실패: ${String(err?.message || err)}\n\n(대안) mermaid 코드 복사 후 mermaid.live 등에 붙여넣어 확인하세요.`;
            } finally {
              renderBtn.disabled = false;
            }
          });

          wrap.append(toolbar, diagram, codePre);
          el.append(wrap);
        }
      }
      body.append(el);
    }

    if (opts.scroll) body.scrollTop = body.scrollHeight;
  }

  function mountUI() {
    const fab = document.createElement("button");
    fab.id = "reviewmate-fab";
    fab.type = "button";
    fab.textContent = "RM";
    fab.addEventListener("click", () => togglePanel());

    const panel = document.createElement("div");
    panel.id = "reviewmate-panel";

    const header = document.createElement("div");
    header.className = "rm-header";
    header.innerHTML = `
      <div class="rm-title">
        <strong>ReviewMate</strong>
        <span id="reviewmate-subtitle">GitHub PR에서 바로 질의응답</span>
      </div>
      <div class="rm-actions">
        <button class="rm-btn" id="reviewmate-options" type="button">옵션</button>
        <button class="rm-btn rm-danger" id="reviewmate-clear" type="button">새 대화</button>
        <button class="rm-btn" id="reviewmate-close" type="button">닫기</button>
      </div>
    `;

    const quick = document.createElement("div");
    quick.className = "rm-quick";
    quick.innerHTML = `
      <button class="rm-pill" id="rm-q-explain" type="button">선택 코드 설명</button>
      <button class="rm-pill" id="rm-q-review" type="button">리뷰 코멘트 초안</button>
      <button class="rm-pill" id="rm-q-tests" type="button">테스트 제안</button>
      <button class="rm-pill" id="rm-q-security" type="button">보안/리스크</button>
      <button class="rm-pill" id="rm-q-peek" type="button">정의 찾기(파일)</button>
      <button class="rm-pill" id="rm-q-peek-repo" type="button">정의 찾기(리포)</button>
      <button class="rm-pill" id="rm-q-arch" type="button">아키텍처 변화</button>
      <button class="rm-pill" id="rm-q-diagram" type="button">다이어그램</button>
      <button class="rm-pill" id="rm-q-loadctx" type="button">PR 컨텍스트 로드</button>
      <button class="rm-pill" id="rm-q-demo" type="button">UI 데모</button>
    `;

    const body = document.createElement("div");
    body.className = "rm-body";
    body.id = "reviewmate-body";

    const composer = document.createElement("div");
    composer.className = "rm-composer";
    composer.innerHTML = `
      <div class="rm-row">
        <textarea class="rm-textarea" id="reviewmate-input" placeholder="질문을 입력하세요. (선택한 코드 포함: ON)"></textarea>
        <button class="rm-send" id="reviewmate-send" type="button">보내기</button>
      </div>
      <div class="rm-footer">
        <div class="rm-toggles">
          <label class="rm-toggle">
            <input id="reviewmate-include-selection" type="checkbox" checked />
            선택 코드
          </label>
          <label class="rm-toggle">
            <input id="reviewmate-include-pr-meta" type="checkbox" checked />
            PR 요약
          </label>
          <label class="rm-toggle">
            <input id="reviewmate-include-pr-diff" type="checkbox" checked />
            PR diff
          </label>
          <label class="rm-toggle">
            <input id="reviewmate-include-pr-files" type="checkbox" />
            변경 파일 원문
          </label>
        </div>
        <span>토글 <span class="rm-kbd">Ctrl/⌘</span>+<span class="rm-kbd">Shift</span>+<span class="rm-kbd">L</span></span>
      </div>
    `;

    panel.append(header, quick, body, composer);
    document.body.append(fab, panel);

    // Wire events
    document.querySelector("#reviewmate-close")?.addEventListener("click", () => togglePanel(false));
    document.querySelector("#reviewmate-options")?.addEventListener("click", () => {
      try {
        // Prefer chrome.runtime.openOptionsPage() to avoid blocked chrome-extension:// popups.
        const r = chrome.runtime.openOptionsPage?.();
        if (r && typeof r.then === "function") r.catch(() => {});
        else if (chrome.runtime.openOptionsPage) return;
      } catch {}
      try {
        chrome.runtime.sendMessage({ type: "open_options" });
      } catch {}
    });
    document.querySelector("#reviewmate-clear")?.addEventListener("click", () => clearConversation());

    document.querySelector("#reviewmate-include-selection")?.addEventListener("change", (e) => {
      state.includeSelection = Boolean(e.target?.checked);
    });
    document.querySelector("#reviewmate-include-pr-meta")?.addEventListener("change", (e) => {
      state.includePrMeta = Boolean(e.target?.checked);
    });
    document.querySelector("#reviewmate-include-pr-diff")?.addEventListener("change", (e) => {
      state.includePrDiff = Boolean(e.target?.checked);
    });
    document.querySelector("#reviewmate-include-pr-files")?.addEventListener("change", (e) => {
      state.includePrFiles = Boolean(e.target?.checked);
    });

    document.querySelector("#reviewmate-send")?.addEventListener("click", async () => {
      const ta = document.querySelector("#reviewmate-input");
      const v = (ta?.value || "").trim();
      if (!v) return;
      ta.value = "";
      await sendToModel(v);
    });

    document.querySelector("#reviewmate-input")?.addEventListener("keydown", async (e) => {
      if (!(e instanceof KeyboardEvent)) return;
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        document.querySelector("#reviewmate-send")?.click();
      }
    });

    function setTemplate(text) {
      const ta = document.querySelector("#reviewmate-input");
      if (!ta) return;
      ta.value = text;
      ta.focus();
    }

    document.querySelector("#rm-q-explain")?.addEventListener("click", () => {
      setTemplate("선택한 코드를 요약하고, 의도/동작을 단계별로 설명해줘. 리뷰 관점에서 위험한 부분도 같이 알려줘.");
    });
    document.querySelector("#rm-q-review")?.addEventListener("click", () => {
      setTemplate(
        "선택한 코드에 대해 코드리뷰 코멘트를 작성해줘. 버그/엣지케이스/가독성/성능/테스트 관점으로, 바로 PR 코멘트로 붙여넣을 수 있게 간결하게."
      );
    });
    document.querySelector("#rm-q-tests")?.addEventListener("click", () => {
      setTemplate("선택한 변경사항에 대해 추가하면 좋은 테스트 케이스를 구체적으로 제안해줘. (케이스, 기대값, 실패 시 의미)");
    });
    document.querySelector("#rm-q-security")?.addEventListener("click", () => {
      setTemplate("선택한 코드에서 보안/권한/입력검증/정보노출/인젝션 관점의 리스크가 있는지 점검해줘. 있으면 구체적으로.");
    });

    document.querySelector("#rm-q-arch")?.addEventListener("click", () => {
      setTemplate(
        "이 PR이 시스템/아키텍처에 어떤 변화를 주는지 설명해줘. 변경된 모듈/책임/데이터플로우/API 경계를 중심으로:\n(1) 변경 요약\n(2) 영향 범위(호출자/데이터/권한)\n(3) 리스크/회귀 포인트\n(4) 추천 테스트(구체)\n형식으로."
      );
    });

    document.querySelector("#rm-q-diagram")?.addEventListener("click", () => {
      setTemplate(
        "이 PR의 변경사항을 mermaid 다이어그램(코드블록 ```mermaid```)으로 표현해줘. 가능하면 flowchart로:\n- 주요 컴포넌트/모듈\n- 데이터/호출 흐름\n- 변경 전/후 차이를 주석으로\n\n바로 렌더링할 수 있게 mermaid 코드만 깔끔하게 줘."
      );
    });

    document.querySelector("#rm-q-demo")?.addEventListener("click", async () => {
      const demoUser = "이 PR의 핵심 변경점/아키텍처 영향/리스크/테스트 포인트를 정리해줘.";
      const demoUserContent = `GitHub PR URL: ${location.href}\n질문/요청:\n${demoUser}`;

      const demoAssistant =
        "PR 영향 요약(데모)\n\n- 변경된 경계: API -> Service -> Storage\n- 리스크: 입력 검증/호환성/에러 처리\n- 추천 테스트: 회귀 케이스 + 엣지 케이스\n\n```mermaid\nflowchart TD\n  U[\"Reviewer\"] -->|select diff| GH[\"GitHub PR Files\"]\n  GH --> RM[\"ReviewMate Panel\"]\n  RM -->|context: diff + raw| LLM[\"OpenAI Responses API\"]\n  LLM --> RM\n  RM -->|copy comment| PR[\"PR Review Comment\"]\n\n  %% note\n  RM -. \"Definition lookup\" .-> GH\n```\n\n리뷰 코멘트 초안(데모)\n- [P1] 입력 검증/에러 메시지 정리 필요\n- [P2] null/undefined 케이스 테스트 추가 권장\n";

      pushMsg("user", demoUserContent, demoUser);
      pushMsg("assistant", demoAssistant);
      renderMessages({ scroll: true });
    });

    document.querySelector("#rm-q-loadctx")?.addEventListener("click", async () => {
      await ensurePrMeta();
      if (state.includePrDiff) await ensurePrDiff();
      if (state.includePrFiles) await ensurePrFilesRaw();
      const hint = String(document.querySelector("#reviewmate-input")?.value || "").trim();
      await ensureRepoWideFiles(hint);

      const pr = state.context.pr;
      if (pr) {
        const repoStatus = state.context.repoWideError ? `err(${state.context.repoWideError})` : String(state.context.repoWideFiles.length);
        pushMsg(
          "assistant",
          `PR 컨텍스트 로드됨: files=${pr.totalFiles || pr.files?.length || 0} diff=${state.context.diff ? "yes" : "no"} raw=${state.context.rawFiles.length} repo=${repoStatus}`
        );
      } else if (state.context.error) {
        pushMsg("assistant", `PR 컨텍스트 로드 실패: ${state.context.error}`);
      } else {
        pushMsg("assistant", "PR 컨텍스트를 로드하지 못했습니다.");
      }
      renderMessages({ scroll: true });
    });

    document.querySelector("#rm-q-peek")?.addEventListener("click", async () => {
      const selection = getSelectedText();
      if (!selection) {
        pushMsg("assistant", "정의 찾기는 식별자(함수/클래스 이름 등)를 선택한 뒤 사용하세요.");
        renderMessages({ scroll: true });
        return;
      }

      const ident = extractIdentifierFromSelection(selection);
      if (!ident) {
        pushMsg("assistant", `정의 후보 식별자를 추출하지 못했습니다. (선택: ${selection.slice(0, 80)})`);
        renderMessages({ scroll: true });
        return;
      }

      const info = getSelectionFileInfo();
      if (!info?.rawUrl) {
        pushMsg("assistant", "현재 파일의 blob/raw URL을 찾지 못했습니다. (GitHub DOM이 변경됐을 수 있어요)");
        renderMessages({ scroll: true });
        return;
      }

      pushMsg("assistant", `정의 찾는 중: ${ident} (${info.path || "unknown file"})`);
      renderMessages({ scroll: true });

      try {
        const res = await fetch(info.rawUrl, { credentials: "include" });
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          pushMsg(
            "assistant",
            `파일을 불러오지 못했습니다. HTTP ${res.status} ${res.statusText}${t ? `: ${t.slice(0, 180)}` : ""}`
          );
          renderMessages({ scroll: true });
          return;
        }

        const text = await res.text();
        const def = findDefinitionInText(ident, text);
        if (!def) {
          pushMsg(
            "assistant",
            `정의 패턴을 현재 파일에서 찾지 못했습니다: ${ident}\n\n원본 보기: ${info.blobUrl || info.rawUrl}`
          );
          renderMessages({ scroll: true });
          return;
        }

        pushMsg(
          "assistant",
          `정의 후보: ${ident}\n파일: ${info.path || "unknown"}:${def.hitLine}\n\n\`\`\`\n${def.snippet}\n\`\`\`\n원본 보기: ${info.blobUrl || info.rawUrl}`
        );
        renderMessages({ scroll: true });
      } catch (e) {
        pushMsg("assistant", `정의 찾기 실패: ${String(e?.message || e)}`);
        renderMessages({ scroll: true });
      }
    });

    document.querySelector("#rm-q-peek-repo")?.addEventListener("click", async () => {
      const selection = getSelectedText();
      if (!selection) {
        pushMsg("assistant", "리포 정의 찾기는 식별자(함수/클래스 이름 등)를 선택한 뒤 사용하세요.");
        renderMessages({ scroll: true });
        return;
      }
      const ident = extractIdentifierFromSelection(selection);
      if (!ident) {
        pushMsg("assistant", `정의 후보 식별자를 추출하지 못했습니다. (선택: ${selection.slice(0, 80)})`);
        renderMessages({ scroll: true });
        return;
      }
      pushMsg("assistant", `리포에서 정의 찾는 중: ${ident}`);
      renderMessages({ scroll: true });
      await repoDefinitionLookup(ident);
    });
  }

  async function boot() {
    state.convKey = getConvKey();
    await loadConversation();
    mountUI();
    renderMessages({ scroll: true });
    // Slight delay so UI paints before we read settings
    await sleep(0);
    state.settingsSummary = await getSettingsSummary();
    updateSubtitle();
    ensurePrMeta().catch(() => {});

    // Shortcut fallback (GitHub DOM 상에서도 동작하도록). Ctrl/⌘+Shift+L
    window.addEventListener("keydown", (e) => {
      if (!(e instanceof KeyboardEvent)) return;
      const key = (e.key || "").toLowerCase();
      if (key !== "l") return;
      if (!(e.shiftKey && (e.ctrlKey || e.metaKey))) return;
      e.preventDefault();
      togglePanel();
    });

    // GitHub는 Turbo/PJAX로 URL이 바뀌는 경우가 있어, 대화 키를 URL 기준으로 갱신한다.
    setInterval(async () => {
      const nextKey = getConvKey();
      if (nextKey === state.convKey) return;
      state.convKey = nextKey;
      await loadConversation();
      // Reset context on PR change (or reload if still on PR but navigated).
      const pr = parsePrFromUrl();
      const pk = prKeyFromPr(pr);
      if (pk && pk !== state.context.prKey) {
        state.context.prKey = null;
        state.context.pr = null;
        state.context.diff = null;
        state.context.rawFiles = [];
        state.context.rawTotalChars = 0;
        state.context.repoWideFiles = [];
        state.context.repoWideTotalChars = 0;
        state.context.repoWideTerms = [];
        state.context.repoWideKey = null;
        state.context.repoWideError = null;
        state.context.error = null;
        state.context.loading = false;
        updateSubtitle();
        ensurePrMeta().catch(() => {});
      }
      renderMessages({ scroll: true });
    }, 1000);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "toggle_panel") togglePanel();
  });

  boot().catch(() => {});
})();
