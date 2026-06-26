// 브라우저에서 직접 Claude(api.anthropic.com)를 호출해 증류한다.
//
// 왜 브라우저에서? Render(무료) 서버 → Anthropic 연결이 길거나 동시 다발이면
// 'premature close'로 끊긴다. 사용자의 브라우저가 본인 API 키로 Anthropic에
// 직접 호출하면 그 약한 고리가 사라진다. 키는 브라우저 localStorage에만 있고
// 우리 서버로는 절대 가지 않는다. Anthropic은 이 용도를 공식 허용한다
// (anthropic-dangerous-direct-browser-access 헤더).
//
// 호출은 스트리밍(SSE)으로 한다 — 모바일 브라우저의 요청 idle 타임아웃을 피하려고
// (생성 중 바이트가 계속 흐르게).
(function () {
  "use strict";

  const API_URL = "https://api.anthropic.com/v1/messages";
  const MODEL = "claude-haiku-4-5"; // 트랜스크립트(번역·정리) — 가장 저렴(입력 $1·출력 $5/1M)
  const STRUCT_MODEL = "claude-sonnet-4-6"; // 구조 요약(시사점·마케터 관점·챕터)만 상위 모델로 — 인사이트 품질↑
  const MAX_OUT = 16000; // 호출당 max_tokens 상한
  const SINGLE_PASS_BUDGET = 14000; // 예상 출력이 이 토큰을 넘으면 분할
  const CHUNK_CHARS = 8000; // 분할 시 청크당 원문 문자 수
  const MAX_ATTEMPTS = 5; // 호출당 끊김 재시도
  const STRUCTURE_INPUT_CAP = 40000; // 구조 요약 입력 상한(초장편은 대표 발췌)
  const CONCURRENCY = 3; // 청크 동시 처리 개수

  let _apiKey = ""; // distill() 호출 동안만 유지
  let _context = ""; // 독자가 주입한 맥락(관심사·배경). distill() 호출 동안만 유지
  let _progress = function () {}; // 진행 로그 콜백(distill/followUp 동안만). 재시도·폴백도 여기로.

  // ── 스키마 ────────────────────────────────────────────────────────────
  const META_PROPS = {
    koreanTitle: { type: "string", description: "영상 제목의 한글 번역" },
    originalTitle: { type: "string", description: "원문 제목(원어 그대로)" },
    channel: { type: "string", description: "채널명. 모르면 빈 문자열" },
    publishedDate: { type: "string", description: "게재일. 모르면 빈 문자열" },
    sourceLang: { type: "string", description: "원본 음성/자막 언어(예: en, ko). 모르면 빈 문자열" },
    oneLiner: { type: "string", description: "이 영상의 핵심을 한 문장으로 증류(한글)" },
    topic: { type: "string", description: "이 영상이 무엇에 관한 것인지 2~4문장으로 설명한 맥락(한글)" },
    keyTakeaways: {
      type: "array",
      items: { type: "string" },
      description: "영상 자체의 핵심 시사점(보편적, 영상 근거 기반). 누가 봐도 유효한 통찰 3~6개(한글)",
    },
    marketerAngle: {
      type: "object",
      description: "반도체 마케터(AI 동향 관심) 관점에서의 연관성. 억지로 연결하지 말 것.",
      properties: {
        relevance: {
          type: "string",
          enum: ["high", "medium", "low", "none"],
          description: "이 영상이 반도체·AI 마케팅과 실제로 얼마나 연관되는지 정직하게",
        },
        notes: {
          type: "array",
          items: { type: "string" },
          description:
            "반도체 마케터 관점의 해석·시사점(모델의 해석임). 연관이 약하면 솔직히 밝히고 무리한 연결 금지. relevance가 none이면 빈 배열 가능.",
        },
      },
      required: ["relevance", "notes"],
      additionalProperties: false,
    },
    chapters: {
      type: "array",
      description: "영상 흐름을 따라 구조화한 타임스탬프 목차(구조 요약). 각 챕터는 영상 시점에 대응한다.",
      items: {
        type: "object",
        properties: {
          timestamp: { type: "string", description: "mm:ss 또는 h:mm:ss 형식" },
          seconds: { type: "integer", description: "챕터 시작 시점(초). 클릭 시 영상 점프에 사용" },
          heading: { type: "string", description: "챕터 소제목(한글)" },
          summary: { type: "string", description: "해당 구간 요약(한글)" },
        },
        required: ["timestamp", "seconds", "heading", "summary"],
        additionalProperties: false,
      },
    },
    keyTerms: {
      type: "array",
      description: "이해를 돕는 핵심 용어·숫자·고유명사 풀이 (없으면 빈 배열)",
      items: {
        type: "object",
        properties: {
          term: { type: "string", description: "용어(원어 병기 가능)" },
          note: { type: "string", description: "짧은 한글 설명" },
        },
        required: ["term", "note"],
        additionalProperties: false,
      },
    },
    keyQuotes: {
      type: "array",
      description:
        "영상에서 인상적이거나 핵심을 찌르는 실제 발언을 원문 그대로 뽑은 인용. 절대 지어내지 말고 자막에 실제로 있는 말만. 핵심을 압축하는 한두 문장 위주로 3~6개(없으면 빈 배열).",
      items: {
        type: "object",
        properties: {
          timestamp: { type: "string", description: "발언 시점 mm:ss 또는 h:mm:ss(모르면 빈 문자열)" },
          seconds: { type: "integer", description: "발언 시점(초). 클릭 점프용. 모르면 0" },
          speaker: { type: "string", description: "화자(알면). 모르면 빈 문자열" },
          original: { type: "string", description: "원문 그대로의 인용(원어, 그대로 verbatim)" },
          korean: { type: "string", description: "그 인용의 한글 번역" },
        },
        required: ["timestamp", "seconds", "speaker", "original", "korean"],
        additionalProperties: false,
      },
    },
  };

  const TRANSCRIPT_PROP = {
    transcript: {
      type: "array",
      description:
        "영상 흐름을 따라 문단 단위로 정리한 한글·원문 병기 트랜스크립트(요약이 아니라 충실한 정리). 정보 손실 최소화.",
      items: {
        type: "object",
        properties: {
          timestamp: { type: "string", description: "이 문단 시작 시점 mm:ss(없으면 빈 문자열)" },
          seconds: { type: "integer", description: "문단 시작 시점(초). 모르면 0" },
          original: { type: "string", description: "원문 그대로의 문단(원어)" },
          korean: { type: "string", description: "해당 문단의 한글 번역(맥락 손실 최소화)" },
        },
        required: ["timestamp", "seconds", "original", "korean"],
        additionalProperties: false,
      },
    },
  };

  const META_REQUIRED = [
    "koreanTitle", "originalTitle", "channel", "publishedDate", "sourceLang",
    "oneLiner", "topic", "keyTakeaways", "marketerAngle", "chapters", "keyTerms", "keyQuotes",
  ];
  const FULL_SCHEMA = {
    type: "object",
    properties: Object.assign({}, META_PROPS, TRANSCRIPT_PROP),
    required: META_REQUIRED.concat(["transcript"]),
    additionalProperties: false,
  };
  const STRUCTURE_SCHEMA = {
    type: "object",
    properties: Object.assign({}, META_PROPS),
    required: META_REQUIRED,
    additionalProperties: false,
  };
  const TRANSCRIPT_SCHEMA = {
    type: "object",
    properties: Object.assign({}, TRANSCRIPT_PROP),
    required: ["transcript"],
    additionalProperties: false,
  };

  const SYSTEM = `너는 유튜브 영상의 자막을 한국어로 옮겨 정리하는 전문 에디터다.
독자는 SK하이닉스의 반도체 마케터이며, AI 산업 동향에 관심이 많다. 단, 이 페르소나는 "기본 렌즈"일 뿐이다.

번역·정리 원칙:
- 번역은 원문(음성)의 의도와 뉘앙스에 충실하게, 맥락 손실을 최소화한다. 임의로 줄이거나 왜곡하지 않는다.
- transcript는 "요약"이 아니라 영상 흐름을 따라간 충실한 한글·원문 병기 정리다. original에는 원어 문단을, korean에는 그 번역을 담는다. 중요한 논지·근거·숫자·사례를 빠뜨리지 않는다.
- 자막의 자동 분절(짧은 조각)을 의미 단위 문단으로 자연스럽게 묶는다.
- chapters는 영상의 구조를 한눈에 보여주는 목차다. 자막에 붙은 [초] 타임스탬프를 이용해 각 챕터의 seconds를 정확히 채운다.
- oneLiner와 topic은 영상의 본질을 증류해 한눈에 파악하게 한다.
- 원문에 없는 사실·숫자·고유명사를 절대 지어내지 않는다. 확실하지 않으면 적지 않는다.

인사이트 원칙 (중요):
- keyTakeaways: 영상 자체의 보편적 핵심 시사점. 영상 내용에 근거한 사실 기반 통찰이다.
- marketerAngle: 반도체/AI 마케팅 관점의 연결은 "진짜 연관이 있을 때만" 한다.
  · 영상이 반도체·AI와 직접 관련되면 relevance를 high/medium으로 두고 구체적으로 연결한다.
  · 관련이 약하거나 없으면 relevance를 low/none으로 솔직히 표시하고, notes에 그 점을 밝힌다. 억지로 HBM/칩 수요 등에 끼워 맞추지 마라.
  · notes는 "모델의 해석"이다. 원문 사실로 단정하지 말 것.

- keyQuotes: 영상에서 인상적이거나 핵심을 찌르는 "실제 발언"을 원문 그대로(verbatim) 뽑는다. 자막에 없는 말을 절대 지어내지 말고, 의역·요약하지 말 것(번역은 korean 필드에 따로). 가능하면 [초] 표시로 seconds를 채워 클릭 점프가 되게 한다.

- 전문 용어는 자연스러운 한국어로 옮기되 필요하면 원어를 괄호로 병기한다.
- originalTitle과 transcript의 original, keyQuotes의 original을 제외한 모든 출력은 한국어로 작성한다.`;

  // 독자가 주입한 맥락을 시스템 프롬프트에 덧붙인다. 페르소나(반도체 마케터)는 그대로 고정하고,
  // 이 맥락은 oneLiner·topic·keyTakeaways·marketerAngle을 그 관심사/배경 쪽으로 더 날카롭게 맞추는 데 쓴다.
  function buildSystem() {
    if (!_context) return SYSTEM;
    return (
      SYSTEM +
      `\n\n---\n[독자가 직접 주입한 맥락]\n${_context}\n\n` +
      `위 맥락을 반영해 oneLiner·topic·keyTakeaways·marketerAngle을 이 독자의 관심사·배경에 맞게 더 구체적이고 날카롭게 정리하라. ` +
      `이 맥락은 "초점"을 잡는 용도일 뿐이다 — 원문(영상)에 없는 사실·숫자·고유명사를 지어내지 말고, 영상 근거 안에서 해석하라. ` +
      `맥락과 영상 내용이 실제로 무관하면 억지로 끼워 맞추지 말고 marketerAngle의 relevance를 솔직히 표시하라. ` +
      `이 맥락은 해석·요약 필드에만 반영하고, transcript(충실 번역)는 영향받지 않는다.`
    );
  }

  // ── 유틸 ──────────────────────────────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function buildTimestampedText(segments) {
    const lines = [];
    let buf = "";
    let bufStart = segments.length ? segments[0].start : 0;
    for (const seg of segments) {
      if (buf === "") bufStart = seg.start;
      buf += (buf ? " " : "") + seg.text;
      if (buf.length >= 280) { lines.push(`[${bufStart}] ${buf}`); buf = ""; }
    }
    if (buf) lines.push(`[${bufStart}] ${buf}`);
    return lines.join("\n");
  }

  function estimateOutputTokens(chars) { return Math.ceil(chars * 0.7) + 4000; }

  function downsample(text, maxChars) {
    if (text.length <= maxChars) return text;
    const lines = text.split("\n");
    const step = Math.max(2, Math.ceil(text.length / maxChars));
    const kept = lines.filter((_, i) => i % step === 0);
    let out = kept.join("\n");
    if (out.length > maxChars) out = out.slice(0, maxChars);
    return out;
  }

  function header(meta) {
    return [
      meta.title && `영상 제목: ${meta.title}`,
      meta.channel && `채널: ${meta.channel}`,
      meta.publishedDate && `게재일: ${meta.publishedDate}`,
      meta.url && `출처: ${meta.url}`,
    ].filter(Boolean).join("\n");
  }

  function fmtTimestamp(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(h ? 2 : 1, "0"), ss = String(s).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function describeErr(e) {
    const parts = [];
    if (e && e.status) parts.push("HTTP " + e.status);
    if (e && e.type) parts.push(e.type); // Anthropic 에러 유형
    const msg = (e && e.message) || String(e);
    if (msg) parts.push(msg);
    return parts.join(" · ").slice(0, 300) || "알 수 없는 오류";
  }

  function isTransient(err) {
    return /premature close|terminated|econnreset|fetch failed|failed to fetch|load failed|socket|network|aborted|timeout|overloaded|429|529|500|502|503/i.test(
      describeErr(err),
    );
  }

  function chunkRawText(text, maxChars) {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
      let end = Math.min(i + maxChars, text.length);
      if (end < text.length) {
        const nl = text.lastIndexOf("\n", end);
        const sp = text.lastIndexOf(" ", end);
        const cut = Math.max(nl, sp);
        if (cut > i + maxChars * 0.5) end = cut;
      }
      chunks.push(text.slice(i, end).trim());
      i = end;
    }
    return chunks.filter(Boolean);
  }

  function chunkSegments(segments, maxChars) {
    const chunks = [];
    let cur = [];
    let len = 0;
    for (const seg of segments) {
      cur.push(seg);
      len += seg.text.length + 1;
      if (len >= maxChars) { chunks.push(cur); cur = []; len = 0; }
    }
    if (cur.length) chunks.push(cur);
    return chunks.length ? chunks : [segments];
  }

  async function mapPool(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const idx = next++;
        results[idx] = await fn(items[idx], idx);
      }
    }
    const n = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: n }, worker));
    return results;
  }

  // ── 핵심: 브라우저 fetch + SSE 스트리밍으로 1회 호출 ──────────────────
  async function callJson({ schema, maxTokens, userText, model }) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(API_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": _apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: model || MODEL,
            max_tokens: Math.min(MAX_OUT, Math.max(4000, maxTokens)),
            stream: true,
            system: buildSystem(),
            thinking: { type: "disabled" }, // 번역·정리엔 불필요(출력 과금 절감)
            output_config: { format: { type: "json_schema", schema } },
            messages: [{ role: "user", content: userText }],
          }),
        });

        if (!res.ok) {
          let detail = "";
          let etype = "";
          try {
            const j = await res.json();
            detail = (j && j.error && j.error.message) || "";
            etype = (j && j.error && j.error.type) || "";
          } catch (_) { /* ignore */ }
          const err = new Error(detail || `요청 실패`);
          err.status = res.status;
          err.type = etype;
          throw err;
        }

        // SSE 파싱: text_delta 누적 + stop_reason 감지
        const { text, stopReason } = await readSSE(res);
        try {
          return JSON.parse(text);
        } catch (_) {
          if (stopReason === "max_tokens") {
            throw new Error("결과가 출력 한도를 넘어 잘렸습니다. 잠시 후 다시 시도해 주세요.");
          }
          throw new Error("결과 JSON 파싱에 실패했습니다. 다시 시도해 주세요.");
        }
      } catch (e) {
        lastErr = e;
        if (attempt < MAX_ATTEMPTS && isTransient(e)) {
          _progress(`일시 오류 — 재시도 ${attempt + 1}/${MAX_ATTEMPTS}… (${describeErr(e)})`);
          await sleep(1500 * attempt);
          continue;
        }
        throw new Error(`Claude 호출 실패: ${describeErr(e)}`);
      }
    }
    throw lastErr;
  }

  async function readSSE(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let text = "";
    let stopReason = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let ev;
        try { ev = JSON.parse(data); } catch (_) { continue; }
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
          text += ev.delta.text;
        } else if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason) {
          stopReason = ev.delta.stop_reason;
        } else if (ev.type === "error") {
          const m = (ev.error && ev.error.message) || "스트림 오류";
          const err = new Error(m);
          err.type = ev.error && ev.error.type;
          throw err;
        }
      }
    }
    return { text, stopReason };
  }

  // ── 자유 형식(텍스트) 1회 호출 — 2차 명령·상세 풀이용 ────────────────────
  // callJson과 같지만 output_config(JSON 스키마) 없이 마크다운 텍스트를 그대로 받는다.
  async function callText({ maxTokens, userText, model }) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(API_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": _apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: model || MODEL,
            max_tokens: Math.min(MAX_OUT, Math.max(2000, maxTokens)),
            stream: true,
            system: buildSystem(),
            thinking: { type: "disabled" },
            messages: [{ role: "user", content: userText }],
          }),
        });
        if (!res.ok) {
          let detail = "", etype = "";
          try {
            const j = await res.json();
            detail = (j && j.error && j.error.message) || "";
            etype = (j && j.error && j.error.type) || "";
          } catch (_) { /* ignore */ }
          const err = new Error(detail || "요청 실패");
          err.status = res.status;
          err.type = etype;
          throw err;
        }
        const { text } = await readSSE(res);
        const out = (text || "").trim();
        if (!out) throw new Error("빈 응답입니다. 다시 시도해 주세요.");
        return out;
      } catch (e) {
        lastErr = e;
        if (attempt < MAX_ATTEMPTS && isTransient(e)) {
          _progress(`일시 오류 — 재시도 ${attempt + 1}/${MAX_ATTEMPTS}… (${describeErr(e)})`);
          await sleep(1500 * attempt);
          continue;
        }
        throw new Error(`Claude 호출 실패: ${describeErr(e)}`);
      }
    }
    throw lastErr;
  }

  // ── 2차 명령: 이미 만든 결과(트랜스크립트)를 근거로 추가 요청을 처리 ──────
  // sourceText = 챕터 구간(또는 전체) 한글·원문 병기 트랜스크립트. instruction = 사용자 요청.
  async function followUp({ instruction, sourceText, scope, apiKey, context, onProgress }) {
    onProgress = onProgress || function () {};
    _progress = onProgress;
    if (!apiKey) throw new Error("Anthropic API 키가 필요합니다.");
    if (!instruction || !instruction.trim()) throw new Error("요청 내용을 입력해줘.");
    if (!sourceText || sourceText.trim().length < 20) throw new Error("근거로 쓸 트랜스크립트가 없어.");
    _apiKey = apiKey;
    _context = (context || "").trim().slice(0, 2000);
    const src = sourceText.length > 150000 ? sourceText.slice(0, 150000) : sourceText;
    const scopeLine = scope ? `[대상 구간: ${scope}]\n` : "[대상: 영상 전체]\n";
    const userText =
      `${scopeLine}아래는 이 유튜브 영상의 한글·원문 병기 트랜스크립트다(근거 자료).\n` +
      `이 자료에 근거해서 다음 요청을 처리해줘.\n\n[요청]\n${instruction.trim()}\n\n` +
      `규칙:\n` +
      `- 원문(영상)에 없는 사실·숫자·고유명사를 지어내지 마라. 자료에 없으면 "자료에 없음"이라고 솔직히 밝혀라.\n` +
      `- 반도체 마케터(AI 동향) 관점(고정 페르소나)과, 주입된 맥락이 있으면 그 초점을 살려라. 단 무리한 연결은 금지.\n` +
      `- 한국어로, 읽기 좋은 마크다운(소제목·불릿·굵게)으로 정리해라. 요약이 아니라 깊이 있는 해설로.\n\n---\n${src}`;
    onProgress("작성 중…");
    // 상위 모델(Sonnet)이 과부하(overloaded/529)로 막히면 Haiku로 자동 폴백 — 혼잡해도 결과는 나오게.
    try {
      return await callText({ maxTokens: MAX_OUT, userText, model: STRUCT_MODEL });
    } catch (e) {
      if (/overloaded|overload|429|503|529/i.test((e && e.message) || "")) {
        onProgress("상위 모델이 혼잡해 다른 모델로 재시도…");
        return await callText({ maxTokens: MAX_OUT, userText, model: MODEL });
      }
      throw e;
    }
  }

  // ── 구조 요약(독립 작업) ───────────────────────────────────────────────
  async function runStructure(transcriptText, hdr, isRaw, meta) {
    const structureText = downsample(transcriptText, STRUCTURE_INPUT_CAP);
    const sampledNote = structureText.length < transcriptText.length
      ? "\n(주의: 아래는 긴 영상이라 전체에서 고르게 뽑은 대표 발췌다. 타임스탬프는 전 구간에 퍼져 있으니 목차는 영상 흐름을 대표하도록 작성하고, 발췌 사이 공백을 걱정하지 마라.)"
      : "";
    const userText = isRaw
      ? `${hdr}\n\n아래는 유튜브 영상 페이지에서 자동 추출한 텍스트다(정밀 타임스탬프 없음).${sampledNote} 실제 자막 본문이 있으면 구조 요약(제목·맥락·핵심 시사점·마케터 관점·타임스탬프 목차·핵심 용어·주요 인용)을 작성하고, 메타데이터뿐이면 chapters는 빈 배열로 둬라. (본문 트랜스크립트는 별도 처리하므로 여기선 만들지 마라.)\n\n---\n${structureText}`
      : `${hdr}\n\n아래는 긴 유튜브 영상의 자막이다. 각 줄 앞 [숫자]는 시작 시점(초)이다.${sampledNote}\n구조 요약(제목·맥락·핵심 시사점·마케터 관점·타임스탬프 목차·핵심 용어·주요 인용)을 작성해줘. (본문 트랜스크립트는 별도로 처리하므로 여기서는 만들지 마라.)\n\n---\n${structureText}`;
    try {
      // 구조 요약만 상위 모델(Sonnet)로 — 인사이트 품질↑. 과부하로 막히면 Haiku로 폴백.
      const structure = await callJson({ schema: STRUCTURE_SCHEMA, maxTokens: MAX_OUT, model: STRUCT_MODEL, userText });
      return { structure, structureFailed: false };
    } catch (err) {
      if (/overloaded|overload|429|503|529/i.test((err && err.message) || "")) {
        try {
          _progress("구조 요약 혼잡 — Haiku로 폴백 재시도…");
          const structure = await callJson({ schema: STRUCTURE_SCHEMA, maxTokens: MAX_OUT, model: MODEL, userText });
          return { structure, structureFailed: false };
        } catch (_) { /* 폴백도 실패 → 아래 최소 구조 */ }
      }
      return { structure: minimalStructure(meta, describeErr(err)), structureFailed: true };
    }
  }

  function minimalStructure(meta, reason) {
    return {
      koreanTitle: "",
      originalTitle: meta.title || "",
      channel: meta.channel || "",
      publishedDate: meta.publishedDate || "",
      sourceLang: "",
      oneLiner: "",
      topic: `⚠️ 구조 요약은 일시적 오류로 만들지 못했지만, 아래 전체 트랜스크립트는 정상입니다. (원인: ${reason})`,
      keyTakeaways: [],
      marketerAngle: { relevance: "none", notes: [] },
      chapters: [],
      keyTerms: [],
      keyQuotes: [],
    };
  }

  // ── 메인 ──────────────────────────────────────────────────────────────
  async function distill(source, meta, apiKey, onProgress, context) {
    meta = meta || {};
    onProgress = onProgress || function () {};
    _progress = onProgress;
    if (!apiKey) throw new Error("Anthropic API 키가 필요합니다.");
    _apiKey = apiKey;
    _context = (context || "").trim().slice(0, 2000); // 과한 입력 방지

    const transcriptText = source.segments
      ? buildTimestampedText(source.segments)
      : (source.rawText || "").trim();
    if (transcriptText.length < 40) throw new Error("자막 내용이 너무 짧습니다.");

    const hdr = header(meta);
    const estTokens = estimateOutputTokens(transcriptText.length);
    const isRaw = !source.segments;

    // 단일 패스 (짧은 영상)
    if (estTokens <= SINGLE_PASS_BUDGET) {
      onProgress(`Claude 증류 중… (단일 패스, 번역·구조화) · 본문 ${transcriptText.length.toLocaleString()}자`);
      const userText = isRaw
        ? `${hdr}\n\n아래는 유튜브 영상 페이지에서 자동 추출한 텍스트다(리더 프록시 결과, 정밀 타임스탬프 없음).\n` +
          `- 실제 발화(음성) 자막 본문이 들어 있으면 그것을 문단 단위 한글·원문 병기 트랜스크립트로 충실히 정리하고, timestamp는 ""·seconds는 0으로 둬라.\n` +
          `- 실제 자막 본문이 없고 제목·설명·댓글·관련영상 같은 메타데이터뿐이면, transcript와 chapters는 반드시 빈 배열([])로 두고 변명·설명 문구를 거기에 넣지 마라. 그 경우 oneLiner·topic·keyTakeaways는 확보된 정보 범위에서 작성하되, 내용이 영상 설명 기반임을 topic 끝에 한 문장으로 밝혀라.\n\n---\n${transcriptText}`
        : `${hdr}\n\n아래는 유튜브 영상 자막이다. 각 줄 앞 [숫자]는 시작 시점(초)이다.\n위 원칙에 따라 구조 요약과 한글·원문 병기 트랜스크립트로 정리해줘.\n\n---\n${transcriptText}`;
      return await callJson({ schema: FULL_SCHEMA, maxTokens: MAX_OUT, userText });
    }

    // 긴 영상: 구조 요약 + 트랜스크립트 청크를 동시에(병렬)
    const chunks = source.segments
      ? chunkSegments(source.segments, CHUNK_CHARS).map((segs) => ({
          text: buildTimestampedText(segs),
          startSec: segs.length ? Math.floor(segs[0].start) : 0,
        }))
      : chunkRawText(transcriptText, CHUNK_CHARS).map((text) => ({ text, startSec: 0 }));

    onProgress(`긴 영상 — ${chunks.length}개 구간 분할 + 구조 요약 동시 진행`);
    const structurePromise = runStructure(transcriptText, hdr, isRaw, meta);

    let done = 0;
    let gaps = 0;
    const partResults = await mapPool(chunks, CONCURRENCY, async (chunk, i) => {
      try {
        const part = await callJson({
          schema: TRANSCRIPT_SCHEMA,
          maxTokens: MAX_OUT,
          userText: isRaw
            ? `${hdr}\n\n아래는 긴 영상 텍스트의 ${i + 1}/${chunks.length} 구간이다(정밀 타임스탬프 없음).\n이 구간을 문단 단위 한글·원문 병기 트랜스크립트로 충실히 정리해줘(timestamp는 ""·seconds는 0). 이 구간만, 요약 금지.\n\n---\n${chunk.text}`
            : `${hdr}\n\n아래는 긴 영상 자막의 ${i + 1}/${chunks.length} 구간이다. 각 줄 앞 [숫자]는 시작 시점(초)이다.\n이 구간을 문단 단위 한글·원문 병기 트랜스크립트로 충실히 정리해줘. (이 구간만, 요약 금지.)\n\n---\n${chunk.text}`,
        });
        done++;
        onProgress(`✓ 트랜스크립트 구간 ${done}/${chunks.length} 완료`);
        return Array.isArray(part.transcript) ? part.transcript : [];
      } catch (err) {
        gaps++;
        done++;
        onProgress(`✗ 트랜스크립트 구간 ${i + 1}/${chunks.length} 실패 (${describeErr(err)})`);
        const sec = chunk.startSec;
        return [{
          timestamp: sec ? fmtTimestamp(sec) : "",
          seconds: sec,
          original: "",
          korean: `⚠️ (이 구간 ${i + 1}/${chunks.length}을 가져오지 못했어요: ${describeErr(err)})`,
        }];
      }
    });
    const transcript = partResults.flat();

    onProgress("구조 요약 마무리 중…");
    const { structure, structureFailed } = await structurePromise;
    onProgress(structureFailed ? "✗ 구조 요약 실패 (트랜스크립트는 정상)" : "✓ 구조 요약 완료");

    return Object.assign({}, structure, {
      transcript,
      partial: gaps > 0 || structureFailed,
      gaps,
      parts: chunks.length,
      structureFailed,
    });
  }

  // 붙여넣기 URL → videoId (임베드 플레이어용)
  function parseVideoId(input) {
    if (!input) return null;
    const s = String(input).trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
    let m =
      s.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ||
      s.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ||
      s.match(/\/embed\/([a-zA-Z0-9_-]{11})/) ||
      s.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  window.YTDistill = { distill, parseVideoId, followUp };
})();
