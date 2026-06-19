// 유튜브 자막을 받아 구조 요약 + 한글·원문 병기 트랜스크립트로 증류한다.
// (Claude claude-opus-4-8, 구조화 JSON 강제 출력, 스트리밍)
//
// 처리 전략 (②: 단일 패스 + 자동 폴백):
//  - 대부분 영상은 단일 호출로 전체를 한 번에 (스트리밍, max_tokens 최대 128K).
//  - 출력이 한도(~115K 토큰)를 넘을 것으로 추정되는 초장편만 자동으로
//    "구조 요약(1회) + 트랜스크립트(청크별)"로 분할 처리해 잘림을 방지한다.
//
// 독자 페르소나(반도체 마케터·AI 동향 관심)는 "기본 렌즈"로 쓰되,
// 무관한 영상까지 억지로 반도체와 연결하지 않도록 연관도를 정직하게 표시한다.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-4-8";
const OUTPUT_CAP = 128000; // Opus 4.8 최대 출력 토큰
const SINGLE_PASS_BUDGET = 24000; // 예상 출력이 이 토큰을 넘으면 분할(긴 영상은 작은 호출 여러 번)
const CHUNK_CHARS = 16000; // 분할 시 청크당 원문 자막 문자 수(호출 하나를 작게 → 끊김 위험 최소화)

let _client;
function client() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY 가 설정되지 않았습니다. .env 파일을 확인해주세요.");
  }
  return (_client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
}

// ── 스키마 조각 ───────────────────────────────────────────────────────────
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
  "oneLiner", "topic", "keyTakeaways", "marketerAngle", "chapters", "keyTerms",
];

const FULL_SCHEMA = {
  type: "object",
  properties: { ...META_PROPS, ...TRANSCRIPT_PROP },
  required: [...META_REQUIRED, "transcript"],
  additionalProperties: false,
};

const STRUCTURE_SCHEMA = {
  type: "object",
  properties: { ...META_PROPS },
  required: META_REQUIRED,
  additionalProperties: false,
};

const TRANSCRIPT_SCHEMA = {
  type: "object",
  properties: { ...TRANSCRIPT_PROP },
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

- 전문 용어는 자연스러운 한국어로 옮기되 필요하면 원어를 괄호로 병기한다.
- originalTitle과 transcript의 original을 제외한 모든 출력은 한국어로 작성한다.`;

// ── 유틸 ────────────────────────────────────────────────────────────────
/** 세그먼트를 의미 덩어리(타임스탬프 앵커 포함) 텍스트로 만든다. */
function buildTimestampedText(segments) {
  const lines = [];
  let buf = "";
  let bufStart = segments.length ? segments[0].start : 0;
  for (const seg of segments) {
    if (buf === "") bufStart = seg.start;
    buf += (buf ? " " : "") + seg.text;
    if (buf.length >= 280) {
      lines.push(`[${bufStart}] ${buf}`);
      buf = "";
    }
  }
  if (buf) lines.push(`[${bufStart}] ${buf}`);
  return lines.join("\n");
}

/** 출력 토큰 대략 추정(한글+원문 병기 + JSON 오버헤드 고려). */
function estimateOutputTokens(chars) {
  return Math.ceil(chars * 0.7) + 4000;
}

function header(meta) {
  return [
    meta.title && `영상 제목: ${meta.title}`,
    meta.channel && `채널: ${meta.channel}`,
    meta.publishedDate && `게재일: ${meta.publishedDate}`,
    meta.url && `출처: ${meta.url}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 네트워크 일시 끊김(스트림 조기 종료 등)은 재시도로 복구 가능한 부류.
function isTransient(err) {
  return /premature close|terminated|econnreset|fetch failed|socket|network|aborted|timeout|overloaded|529|500|502|503/i.test(
    String(err?.message || err),
  );
}

/** json_schema를 강제해 호출하고 파싱된 객체를 돌려준다(스트리밍 + 끊김 재시도). */
async function callJson({ schema, maxTokens, userText }) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let message;
    try {
      const stream = client().messages.stream({
        model: MODEL,
        max_tokens: Math.min(OUTPUT_CAP, Math.max(16000, maxTokens)),
        system: SYSTEM,
        thinking: { type: "adaptive" },
        output_config: { format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: userText }],
      });
      message = await stream.finalMessage();
    } catch (e) {
      lastErr = e;
      if (attempt < 3 && isTransient(e)) {
        await sleep(1500 * attempt);
        continue; // 끊겼으면 다시 호출
      }
      throw new Error("Claude 호출이 중간에 끊겼습니다(네트워크). 다시 시도해 주세요.");
    }

    const block = message.content.find((b) => b.type === "text");
    if (!block) throw new Error("Claude 응답에서 결과를 찾지 못했습니다.");
    try {
      return JSON.parse(block.text);
    } catch {
      if (message.stop_reason === "max_tokens") {
        throw new Error("영상이 너무 길어 결과가 출력 한도를 넘어 잘렸습니다. 잠시 후 다시 시도해 주세요.");
      }
      throw new Error("결과 JSON 파싱에 실패했습니다. 다시 시도해 주세요.");
    }
  }
  throw lastErr;
}

// ── 메인 ────────────────────────────────────────────────────────────────
/**
 * @param {{segments?: Array<{start:number,text:string}>, rawText?: string}} source
 * @param {{title?,channel?,publishedDate?,url?}} [meta]
 * @returns {Promise<object>} FULL_SCHEMA 형태의 결과
 */
export async function distill(source, meta = {}) {
  const transcriptText = source.segments
    ? buildTimestampedText(source.segments)
    : (source.rawText || "").trim();

  if (transcriptText.length < 40) {
    throw new Error("자막 내용이 너무 짧습니다.");
  }

  const hdr = header(meta);
  const estTokens = estimateOutputTokens(transcriptText.length);
  const isRaw = !source.segments;

  // 단일 패스 (대부분의 영상)
  if (estTokens <= SINGLE_PASS_BUDGET) {
    const userText = isRaw
      ? `${hdr}\n\n아래는 유튜브 영상 페이지에서 자동 추출한 텍스트다(리더 프록시 결과, 정밀 타임스탬프 없음).\n` +
        `- 실제 발화(음성) 자막 본문이 들어 있으면 그것을 문단 단위 한글·원문 병기 트랜스크립트로 충실히 정리하고, timestamp는 ""·seconds는 0으로 둬라.\n` +
        `- 실제 자막 본문이 없고 제목·설명·댓글·관련영상 같은 메타데이터뿐이면, transcript와 chapters는 반드시 빈 배열([])로 두고 변명·설명 문구를 거기에 넣지 마라. 그 경우 oneLiner·topic·keyTakeaways는 확보된 정보 범위에서 작성하되, 내용이 영상 설명 기반임을 topic 끝에 한 문장으로 밝혀라.\n\n---\n${transcriptText}`
      : `${hdr}\n\n아래는 유튜브 영상 자막이다. 각 줄 앞 [숫자]는 시작 시점(초)이다.\n위 원칙에 따라 구조 요약과 한글·원문 병기 트랜스크립트로 정리해줘.\n\n---\n${transcriptText}`;
    // 출력 상한은 예상치가 아니라 넉넉하게(최대 128K) 준다 — 잘림 방지.
    // (스트리밍이라 실제 사용 토큰만 과금/소요되며, 모델은 end_turn에서 자연 종료된다.)
    return await callJson({ schema: FULL_SCHEMA, maxTokens: OUTPUT_CAP, userText });
  }

  // 긴 영상: 구조 요약(1회) + 트랜스크립트(작은 청크별, 각 호출은 짧고 재시도 가능)
  const structure = await callJson({
    schema: STRUCTURE_SCHEMA,
    maxTokens: 16000,
    userText: isRaw
      ? `${hdr}\n\n아래는 유튜브 영상 페이지에서 자동 추출한 텍스트다(정밀 타임스탬프 없음). 실제 자막 본문이 있으면 구조 요약(제목·맥락·핵심 시사점·마케터 관점·타임스탬프 목차·핵심 용어)을 작성하고, 메타데이터뿐이면 chapters는 빈 배열로 둬라. (본문 트랜스크립트는 별도 처리하므로 여기선 만들지 마라.)\n\n---\n${transcriptText}`
      : `${hdr}\n\n아래는 긴 유튜브 영상의 전체 자막이다. 각 줄 앞 [숫자]는 시작 시점(초)이다.\n구조 요약(제목·맥락·핵심 시사점·마케터 관점·타임스탬프 목차·핵심 용어)을 작성해줘. (본문 트랜스크립트는 별도로 처리하므로 여기서는 만들지 마라.)\n\n---\n${transcriptText}`,
  });

  // 트랜스크립트용 청크(작게): 자막은 세그먼트 묶음(타임스탬프 보존), 붙여넣기는 텍스트 분할.
  const chunkTexts = source.segments
    ? chunkSegments(source.segments, CHUNK_CHARS).map(buildTimestampedText)
    : chunkRawText(transcriptText, CHUNK_CHARS);

  const transcript = [];
  for (let i = 0; i < chunkTexts.length; i++) {
    const part = await callJson({
      schema: TRANSCRIPT_SCHEMA,
      maxTokens: OUTPUT_CAP,
      userText: isRaw
        ? `${hdr}\n\n아래는 긴 영상 텍스트의 ${i + 1}/${chunkTexts.length} 구간이다(정밀 타임스탬프 없음).\n이 구간을 문단 단위 한글·원문 병기 트랜스크립트로 충실히 정리해줘(timestamp는 ""·seconds는 0). 이 구간만, 요약 금지.\n\n---\n${chunkTexts[i]}`
        : `${hdr}\n\n아래는 긴 영상 자막의 ${i + 1}/${chunkTexts.length} 구간이다. 각 줄 앞 [숫자]는 시작 시점(초)이다.\n이 구간을 문단 단위 한글·원문 병기 트랜스크립트로 충실히 정리해줘. (이 구간만, 요약 금지.)\n\n---\n${chunkTexts[i]}`,
    });
    if (Array.isArray(part.transcript)) transcript.push(...part.transcript);
  }

  return { ...structure, transcript };
}

/** 긴 원문 텍스트를 줄/공백 경계에서 maxChars 단위로 분할한다. */
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

/** 세그먼트를 원문 문자 수 기준으로 청크 분할한다. */
function chunkSegments(segments, maxChars) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const seg of segments) {
    cur.push(seg);
    len += seg.text.length + 1;
    if (len >= maxChars) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks.length ? chunks : [segments];
}
