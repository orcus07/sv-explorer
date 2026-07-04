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
  const STRUCT_MODEL = "claude-sonnet-5"; // 구조 요약(시사점·마케터 관점·챕터)만 상위 모델로 — 인사이트 품질↑
  const MAX_OUT = 16000; // 호출당 max_tokens 상한
  const SINGLE_PASS_BUDGET = 12000; // 예상 출력이 이 토큰을 넘으면 분할
  const CHUNK_CHARS = 8000; // 분할 시 청크당 원문 문자 수(라틴 기준 상한; CJK는 더 작게 자동 조정)
  const CHUNK_OUT_BUDGET = 11000; // 청크당 목표 출력 토큰(16000 상한 대비 여유)
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
          summary: {
            type: "string",
            description:
              "이 구간을 그 자체로 파악할 수 있게 정리한 3~5문장 요약(한글). 티저·한 줄 예고가 아니라 " +
              "핵심 논지 + 근거·논리 전개 + 등장한 핵심 사례·숫자·고유명사를 담아 완결되게 쓴다.",
          },
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
          korean: { type: "string", description: "그 인용의 한글 번역. 단, original이 이미 한국어면 중복하지 말고 빈 문자열로 둔다." },
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
          speaker: { type: "string", description: "이 문단의 화자. 인터뷰·대담 등 화자가 여럿이면 누구 말인지 구분해 채운다(이름을 알면 실제 이름, 모르면 '진행자'/'게스트' 또는 '화자 A'/'화자 B'로 일관되게). 단독 발화·내레이션이면 빈 문자열." },
          original: { type: "string", description: "원문 그대로의 문단(원어)" },
          korean: { type: "string", description: "해당 문단의 한글 번역(맥락 손실 최소화). 단, original이 이미 한국어면 똑같은 말을 중복하지 말고 빈 문자열로 둔다." },
        },
        required: ["timestamp", "seconds", "speaker", "original", "korean"],
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
- 원문이 이미 한국어인 영상(원어=한국어)은 번역이 필요 없다. 이 경우 original에 한국어 본문을 담고 korean은 빈 문자열("")로 둔다. 같은 한국어를 korean에 또 적어 중복시키지 마라(keyQuotes도 동일).
- 자막의 자동 분절(짧은 조각)을 의미 단위 문단으로 자연스럽게 묶는다.
- 화자 구분: 인터뷰·대담·여러 명이 등장하는 영상이면 각 문단의 speaker를 채워 누구의 말인지 구분한다. 영상 제목·채널·맥락에서 이름을 알 수 있으면 실제 이름(예: 진행자명, 게스트명)을, 모르면 '진행자'/'게스트' 또는 '화자 A'·'화자 B'로 **전체에서 일관되게** 표기한다. 이름을 지어내지 말 것. 단독 발화·내레이션처럼 화자 구분이 무의미하면 speaker는 빈 문자열로 둔다.
- chapters는 영상의 구조를 한눈에 보여주는 목차다. 자막에 붙은 [초] 타임스탬프를 이용해 각 챕터의 seconds를 정확히 채운다. 영상 흐름의 전환점마다 챕터를 나눠 너무 성기지 않게 하되, 자잘하게 쪼개지도 마라.
- 각 챕터의 summary는 "한 줄 예고(티저)"가 아니라 그 구간만 읽어도 내용이 파악되는 3~5문장 요약이다. 핵심 논지·근거·논리 전개와 그 구간에 나온 핵심 사례·숫자·고유명사를 담아 충실히 쓴다(단, 원문에 없는 것을 지어내지 말 것). 더 깊은 해설은 별도 기능이 담당하니 여기서는 '충실한 요약' 수준을 목표로 한다.
- oneLiner와 topic은 영상의 본질을 증류해 한눈에 파악하게 한다.
- 원문에 없는 사실·숫자·고유명사를 절대 지어내지 않는다. 확실하지 않으면 적지 않는다.

자연스러운 우리말 원칙 (번역투를 버리고 한국어답게 — 『이렇게 해야 바로 쓴다』 기준):
- 조사 '의'를 남발하지 말 것. 명사를 '의'로 잇기보다 풀어서 서술한다. (예: "시민의 권리" → "시민이 지닌 권리")
- 영어식 번역투를 버린다. 'have'를 "갖고 있다"로 옮기지 말고 "있다/~가 있다"로. (예: "나는 아이 셋을 갖고 있다" → "나에게는 아이가 셋이 있다")
- 무생물 주어(물주 구문)를 피하고 사람·상황을 주어로 세운다. (예: "거센 바람이 집을 흔들었다" → "거센 바람에 집이 흔들렸다")
- '-이다'로 끝나는 명사문이나 "~을 한다/~이 있었다" 식 명사 표현을 동사·형용사문으로 푼다. (예: "진지한 설명이 있었다" → "진지하게 설명했다")
- 불필요한 '것'과 명사화('~음/~기')를 줄여 서술 어미로 푼다. (예: "계획해 보아야 할 것이다" → "계획해 보아야 한다")
- 복수 접미사 '-들'을 습관적으로 붙이지 않는다(문맥으로 복수를 알 수 있으면 생략).
- 한 문장에 한 가지만 담아 짧게 끊는다. 긴 관형절은 연결어미로 풀어 순서대로 서술한다. 수식어는 꾸밈 받는 말 가까이 둔다.
- 이중 부정·에두르는 문장 끝을 피하고 곧바로 말한다. (예: "얼마나 고마운지 모르겠다" → "정말 고맙다")
- 다만 화자의 말투·존댓말/반말·어조는 그대로 살린다. 객관화를 핑계로 억지로 해라체로 바꾸거나 의미를 줄이지 말 것(자연스러움이 충실함보다 앞서지 않는다).

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

  // 시스템 프롬프트를 프롬프트 캐싱(cache_control) 블록으로 감싼다.
  // 같은 시스템 프롬프트를 청크 병렬·재시도·2차 명령에서 반복 전송하므로, 캐시되면
  // 그 부분 입력비가 크게 줄고 응답도 빨라진다. (임계 토큰 미만이면 API가 캐싱을 무시할 뿐 안전)
  function systemParam(sys) {
    return [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }];
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

  // 한·중·일(CJK)·한글 문자 비율. 한국어 자막은 출력이 (원문+한글번역) 두 벌인 데다
  // 문자당 토큰 밀도가 높아, 같은 글자 수라도 영어보다 출력 토큰이 훨씬 많다.
  function cjkRatio(text) {
    if (!text) return 0;
    const m = text.match(/[぀-ヿ㐀-鿿가-힯]/g);
    return m ? m.length / text.length : 0;
  }

  // 입력 문자당 예상 출력 토큰 배수. 출력은 original + korean 두 벌이라 기본부터 배가된다.
  // 라틴(r≈0)≈0.8, 한국어(r≈1)≈2.4 — 8000자 한글 청크가 16000 토큰을 넘겨 잘리던 현상을 반영.
  function outTokPerChar(text) { return 0.8 + cjkRatio(text) * 1.6; }

  function estimateOutputTokens(text) { return Math.ceil(text.length * outTokPerChar(text)) + 2000; }

  // 언어(토큰 밀도)에 맞춰 청크당 원문 문자 수를 정한다. 한국어처럼 출력이 큰 언어는 더 잘게.
  function chunkCharsFor(text) {
    const target = Math.floor(CHUNK_OUT_BUDGET / outTokPerChar(text));
    return Math.max(2500, Math.min(CHUNK_CHARS, target));
  }

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

  // 모델 ID가 유효하지 않을 때(리네임·디프리케이트) — 폴백 모델로 강등하기 위한 판별.
  function isModelError(err) {
    const t = ((err && err.type) || "").toLowerCase();
    if (t === "not_found_error") return true;
    const m = ((err && err.message) || "").toLowerCase();
    return /model/.test(m) && /(not found|not_found|does not exist|invalid|unknown|deprecat)/.test(m);
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
            system: systemParam(buildSystem()),
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
            // 출력이 max_tokens에 닿아 JSON이 잘림. 재시도해도 같은 결과 → 호출부가 더 잘게 쪼개도록 표시.
            const oe = new Error("결과가 출력 한도를 넘어 잘렸습니다. 더 작은 구간으로 다시 시도합니다.");
            oe.overflow = true;
            throw oe;
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
        const wrapped = new Error(`Claude 호출 실패: ${describeErr(e)}`);
        if (e && e.overflow) wrapped.overflow = true; // 출력 한도 초과 표시는 보존
        throw wrapped;
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
  async function callText({ maxTokens, userText, content, model, system }) {
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
            max_tokens: Math.min(MAX_OUT, Math.max(300, maxTokens)),
            stream: true,
            system: systemParam(system || buildSystem()), // system 지정 시 페르소나 대신 그것을 사용(프로필 추론 등)
            thinking: { type: "disabled" },
            messages: [{ role: "user", content: content || userText }],
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
    // 프롬프트 캐싱: 트랜스크립트+규칙(영상마다 고정, 큰 덩어리)을 캐시 블록으로 앞에 두고,
    // 매번 바뀌는 [요청]만 뒤에 둔다 → 같은 영상에 2차 명령을 반복해도 트랜스크립트가 재과금되지 않는다.
    const stableText =
      `${scopeLine}아래는 이 유튜브 영상의 한글·원문 병기 트랜스크립트다(근거 자료). 이 자료에 근거해 요청을 처리한다.\n` +
      `규칙:\n` +
      `- 원문(영상)에 없는 사실·숫자·고유명사를 지어내지 마라. 자료에 없으면 "자료에 없음"이라고 솔직히 밝혀라.\n` +
      `- 반도체 마케터(AI 동향) 관점(고정 페르소나)과, 주입된 맥락이 있으면 그 초점을 살려라. 단 무리한 연결은 금지.\n` +
      `- 한국어로, 읽기 좋은 마크다운(소제목·불릿·굵게)으로 정리해라. 요약이 아니라 깊이 있는 해설로.\n\n---\n${src}`;
    const content = [
      { type: "text", text: stableText, cache_control: { type: "ephemeral" } },
      { type: "text", text: `\n\n[요청]\n${instruction.trim()}` },
    ];
    onProgress("작성 중…");
    // 상위 모델(Sonnet)이 과부하(529)로 막히거나 모델 ID가 유효하지 않으면 Haiku로 자동 폴백.
    try {
      return await callText({ maxTokens: MAX_OUT, content, model: STRUCT_MODEL });
    } catch (e) {
      if (/overloaded|overload|429|503|529/i.test((e && e.message) || "") || isModelError(e)) {
        onProgress(isModelError(e) ? "상위 모델 ID가 유효하지 않아 다른 모델로 재시도…" : "상위 모델이 혼잡해 다른 모델로 재시도…");
        return await callText({ maxTokens: MAX_OUT, content, model: MODEL });
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
      if (/overloaded|overload|429|503|529/i.test((err && err.message) || "") || isModelError(err)) {
        try {
          _progress(isModelError(err) ? "구조 요약 모델 ID 오류 — Haiku로 폴백 재시도…" : "구조 요약 혼잡 — Haiku로 폴백 재시도…");
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

  // ── 트랜스크립트 한 구간 처리 (출력 한도 초과 시 더 잘게 쪼개 재귀) ───────
  // 한국어처럼 출력(원문+번역 두 벌)이 큰 경우, 예상보다 커서 max_tokens에 잘리면
  // 구간을 절반으로 나눠 각각 다시 처리한다. 실패를 빈 구간으로 떨구지 않고 끝까지 살린다.
  async function transcribeChunk(text, isRaw, hdr, label, depth) {
    try {
      const part = await callJson({
        schema: TRANSCRIPT_SCHEMA,
        maxTokens: MAX_OUT,
        userText: isRaw
          ? `${hdr}\n\n아래는 긴 영상 텍스트의 ${label} 구간이다(정밀 타임스탬프 없음).\n이 구간을 문단 단위 한글·원문 병기 트랜스크립트로 충실히 정리해줘(timestamp는 ""·seconds는 0). 이 구간만, 요약 금지.\n\n---\n${text}`
          : `${hdr}\n\n아래는 긴 영상 자막의 ${label} 구간이다. 각 줄 앞 [숫자]는 시작 시점(초)이다.\n이 구간을 문단 단위 한글·원문 병기 트랜스크립트로 충실히 정리해줘. (이 구간만, 요약 금지.)\n\n---\n${text}`,
      });
      return Array.isArray(part.transcript) ? part.transcript : [];
    } catch (err) {
      if (err && err.overflow && depth < 3 && text.length > 1500) {
        const halves = chunkRawText(text, Math.ceil(text.length / 2));
        if (halves.length > 1) {
          _progress(`… ${label} 구간 출력이 커서 ${halves.length}조각으로 더 나눠 재처리`);
          const out = [];
          for (let h = 0; h < halves.length; h++) {
            const sub = await transcribeChunk(halves[h], isRaw, hdr, `${label}-${h + 1}`, depth + 1);
            out.push(...sub);
          }
          return out;
        }
      }
      throw err;
    }
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
    const estTokens = estimateOutputTokens(transcriptText);
    const isRaw = !source.segments;

    // 단일 패스 (짧은 영상). 예상이 빗나가 출력 한도를 넘으면 아래 분할 방식으로 자동 전환.
    if (estTokens <= SINGLE_PASS_BUDGET) {
      onProgress(`Claude 증류 중… (단일 패스, 번역·구조화) · 본문 ${transcriptText.length.toLocaleString()}자`);
      const userText = isRaw
        ? `${hdr}\n\n아래는 유튜브 영상 페이지에서 자동 추출한 텍스트다(리더 프록시 결과, 정밀 타임스탬프 없음).\n` +
          `- 실제 발화(음성) 자막 본문이 들어 있으면 그것을 문단 단위 한글·원문 병기 트랜스크립트로 충실히 정리하고, timestamp는 ""·seconds는 0으로 둬라.\n` +
          `- 실제 자막 본문이 없고 제목·설명·댓글·관련영상 같은 메타데이터뿐이면, transcript와 chapters는 반드시 빈 배열([])로 두고 변명·설명 문구를 거기에 넣지 마라. 그 경우 oneLiner·topic·keyTakeaways는 확보된 정보 범위에서 작성하되, 내용이 영상 설명 기반임을 topic 끝에 한 문장으로 밝혀라.\n\n---\n${transcriptText}`
        : `${hdr}\n\n아래는 유튜브 영상 자막이다. 각 줄 앞 [숫자]는 시작 시점(초)이다.\n위 원칙에 따라 구조 요약과 한글·원문 병기 트랜스크립트로 정리해줘.\n\n---\n${transcriptText}`;
      try {
        return await callJson({ schema: FULL_SCHEMA, maxTokens: MAX_OUT, userText });
      } catch (err) {
        if (!err || !err.overflow) throw err;
        onProgress("단일 패스 출력이 한도를 넘어 — 구간 분할 방식으로 전환…");
        // 아래 분할 경로로 떨어진다.
      }
    }

    // 긴 영상: 구조 요약 + 트랜스크립트 청크를 동시에(병렬).
    // 청크 크기는 언어(토큰 밀도)에 맞춰 정한다 — 한국어 자막은 출력이 커서 더 잘게 자른다.
    const chunkChars = chunkCharsFor(transcriptText);
    const chunks = source.segments
      ? chunkSegments(source.segments, chunkChars).map((segs) => ({
          text: buildTimestampedText(segs),
          startSec: segs.length ? Math.floor(segs[0].start) : 0,
        }))
      : chunkRawText(transcriptText, chunkChars).map((text) => ({ text, startSec: 0 }));

    onProgress(`긴 영상 — ${chunks.length}개 구간 분할 + 구조 요약 동시 진행`);
    const structurePromise = runStructure(transcriptText, hdr, isRaw, meta);

    let done = 0;
    let gaps = 0;
    const partResults = await mapPool(chunks, CONCURRENCY, async (chunk, i) => {
      try {
        const items = await transcribeChunk(chunk.text, isRaw, hdr, `${i + 1}/${chunks.length}`, 0);
        done++;
        onProgress(`✓ 트랜스크립트 구간 ${done}/${chunks.length} 완료`);
        return items;
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

  // ── 내 프로필 자동 정의: 읽은 글들의 요약만으로 "이 독자는 누구인가"를 추론 ──
  // 전체 본문이 아니라 {title, oneLiner, topic} 요약만 보내 저비용(Haiku, max 600, thinking off).
  async function defineProfile(summaries, apiKey) {
    if (!apiKey) throw new Error("Anthropic API 키가 필요합니다.");
    if (!summaries || !summaries.length) throw new Error("프로필을 만들 읽은 글이 없어요.");
    _apiKey = apiKey;
    _progress = function () {};
    const list = summaries
      .slice(0, 40)
      .map((s, i) => `${i + 1}. ${s.title || "(제목 없음)"}\n   한줄: ${s.oneLiner || ""}\n   주제: ${s.topic || ""}`)
      .join("\n");
    const system =
      "너는 독자 프로파일러다. 아래는 한 독자가 읽고 정리한 영상들의 제목·한줄요약·주제 목록이다. " +
      "이 목록만 근거로 '이 독자는 누구이고 무엇에 관심이 많은가'를 한국어 한 문단(3~5문장)으로 담백하게 추론하라. " +
      "관심 주제·산업·관점·역할을 구체적으로 적되, 목록에 없는 사실을 지어내거나 과장하지 마라. " +
      "출력은 그 문단 텍스트만(머리말·불릿·따옴표 없이).";
    const userText = `독자가 읽고 정리한 글 목록(요약):\n\n${list}`;
    const out = await callText({ maxTokens: 600, userText, model: MODEL, system });
    return out.trim();
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

  window.YTDistill = { distill, parseVideoId, followUp, defineProfile };
})();
