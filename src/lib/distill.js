// 유튜브 자막을 받아 구조 요약 + 한글·원문 병기 트랜스크립트로 증류한다.
// (Claude Haiku 4.5 — MVP는 가장 저렴한 모델로. 구조화 JSON 강제 출력, non-streaming)
//
// 비용: Haiku 4.5는 입력 $1·출력 $5/1M 토큰으로 Opus(입력 $5·출력 $25)보다 5배 저렴.
// 번역·정리 작업이라 thinking(사고 토큰=출력 과금)도 꺼서 추가로 절감한다.
//
// 처리 전략 (②: 단일 패스 + 자동 폴백):
//  - 대부분 영상은 단일 호출로 전체를 한 번에.
//  - 출력이 한도를 넘을 것으로 추정되는 초장편만 자동으로
//    "구조 요약(1회) + 트랜스크립트(청크별)"로 분할 처리해 잘림을 방지한다.
//
// 독자 페르소나(반도체 마케터·AI 동향 관심)는 "기본 렌즈"로 쓰되,
// 무관한 영상까지 억지로 반도체와 연결하지 않도록 연관도를 정직하게 표시한다.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5";
const NONSTREAM_MAX = 16000; // non-streaming 호출의 max_tokens 안전 상한(이 이상은 HTTP 타임아웃 위험)
const SINGLE_PASS_BUDGET = 14000; // 예상 출력이 이 토큰을 넘으면 분할(단일 패스 출력이 16K 안에 들도록)
const CHUNK_CHARS = 8000; // 분할 시 청크당 원문 자막 문자 수(호출 하나를 작게 → 출력 16K 미만)
const MAX_ATTEMPTS = 5; // callJson 한 호출당 끊김 재시도 횟수
const STRUCTURE_INPUT_CAP = 40000; // 구조 요약 호출에 넣을 입력 상한(초장편은 대표 발췌로 축소)
const CONCURRENCY = 3; // 트랜스크립트 청크 동시 처리 개수(짧은 non-streaming 호출이라 부담 적음)

let _client;
function client() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY 가 설정되지 않았습니다. .env 파일을 확인해주세요.");
  }
  // 긴 호출이 SDK 자체 타임아웃에 걸려 끊기지 않도록 넉넉히(10분) 준다.
  return (_client ??= new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 600000,
    maxRetries: 4,
  }));
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

/**
 * 긴 타임스탬프 텍스트를 maxChars 안으로 "고르게" 축소한다(구조 요약 입력용).
 * 줄을 일정 간격으로 솎아 영상 전체 시점([초] 앵커)이 골고루 남게 한다.
 */
function downsample(text, maxChars) {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  const step = Math.max(2, Math.ceil(text.length / maxChars));
  const kept = lines.filter((_, i) => i % step === 0);
  let out = kept.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars); // 안전 하드캡
  return out;
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
    describeErr(err),
  );
}

/** 에러의 진짜 원인을 사람이 읽을 수 있게 추린다(상태코드·이름·메시지·cause). */
function describeErr(e) {
  const parts = [];
  if (e?.status) parts.push("HTTP " + e.status);
  if (e?.error?.type) parts.push(e.error.type); // Anthropic 에러 유형(overloaded_error 등)
  if (e?.name && e.name !== "Error") parts.push(e.name);
  const msg = e?.message || String(e);
  if (msg) parts.push(msg);
  const cause = e?.cause?.message || e?.cause?.code; // undici 등 하위 원인
  if (cause && !msg.includes(String(cause))) parts.push("(" + cause + ")");
  return parts.join(" · ").slice(0, 300) || "알 수 없는 오류";
}

/** json_schema를 강제해 호출하고 파싱된 객체를 돌려준다(non-streaming + 끊김 재시도).
 *  스트리밍(긴 SSE 연결)은 Render 무료 IP에서 'premature close'로 자주 끊겨,
 *  호출이 작아진 지금은 일반 요청을 쓴다. 연결 끊김은 SDK가 자동 재시도하고,
 *  여기서도 한 번 더 감싸 재시도한다. max_tokens는 non-streaming 안전선(16K)으로 제한. */
async function callJson({ schema, maxTokens, userText }) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let message;
    try {
      message = await client().messages.create({
        model: MODEL,
        max_tokens: Math.min(NONSTREAM_MAX, Math.max(4000, maxTokens)),
        system: SYSTEM,
        // 번역·정리 작업이라 thinking은 끈다(출력으로 과금되는 사고 토큰 절감).
        thinking: { type: "disabled" },
        output_config: { format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: userText }],
      });
    } catch (e) {
      lastErr = e;
      // 진짜 원인을 서버 로그에 남긴다(Render 로그에서 확인 가능).
      console.error(`[distill] callJson 시도 ${attempt}/${MAX_ATTEMPTS} 실패:`, e);
      if (attempt < MAX_ATTEMPTS && isTransient(e)) {
        await sleep(1500 * attempt); // 1.5s → 3 → 4.5 → 6s 백오프
        continue; // 끊겼으면 다시 호출
      }
      // 더는 가리지 않고 진짜 원인을 그대로 드러낸다.
      throw new Error(`Claude 호출 실패: ${describeErr(e)}`);
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
 * @param {(msg:string)=>void} [onProgress] - 진행 상황 콜백
 * @returns {Promise<object>} FULL_SCHEMA 형태의 결과
 */
export async function distill(source, meta = {}, onProgress = () => {}) {
  const transcriptText = source.segments
    ? buildTimestampedText(source.segments)
    : (source.rawText || "").trim();

  if (transcriptText.length < 40) {
    throw new Error("자막 내용이 너무 짧습니다.");
  }

  const hdr = header(meta);
  const estTokens = estimateOutputTokens(transcriptText.length);
  const isRaw = !source.segments;

  // 단일 패스 (짧은 영상)
  if (estTokens <= SINGLE_PASS_BUDGET) {
    onProgress("증류 중…");
    const userText = isRaw
      ? `${hdr}\n\n아래는 유튜브 영상 페이지에서 자동 추출한 텍스트다(리더 프록시 결과, 정밀 타임스탬프 없음).\n` +
        `- 실제 발화(음성) 자막 본문이 들어 있으면 그것을 문단 단위 한글·원문 병기 트랜스크립트로 충실히 정리하고, timestamp는 ""·seconds는 0으로 둬라.\n` +
        `- 실제 자막 본문이 없고 제목·설명·댓글·관련영상 같은 메타데이터뿐이면, transcript와 chapters는 반드시 빈 배열([])로 두고 변명·설명 문구를 거기에 넣지 마라. 그 경우 oneLiner·topic·keyTakeaways는 확보된 정보 범위에서 작성하되, 내용이 영상 설명 기반임을 topic 끝에 한 문장으로 밝혀라.\n\n---\n${transcriptText}`
      : `${hdr}\n\n아래는 유튜브 영상 자막이다. 각 줄 앞 [숫자]는 시작 시점(초)이다.\n위 원칙에 따라 구조 요약과 한글·원문 병기 트랜스크립트로 정리해줘.\n\n---\n${transcriptText}`;
    // 단일 패스는 SINGLE_PASS_BUDGET(≤14K 예상)일 때만 → 출력이 16K 안에 들어 non-streaming 안전.
    return await callJson({ schema: FULL_SCHEMA, maxTokens: NONSTREAM_MAX, userText });
  }

  // 긴 영상: 구조 요약과 트랜스크립트 청크를 "동시에" 처리한다(시간 단축).
  //  - 청크들은 동시 CONCURRENCY개씩 병렬로(순서는 보존). 순차 처리 대비 시간이 크게 준다.
  //  - 구조 요약은 청크와 독립이라 같이 진행. 둘 다 끝내 실패해도 나머지는 살린다.
  // (병렬은 시간만 줄일 뿐 토큰량=비용은 동일하다.)

  // 트랜스크립트용 청크(작게): 자막은 세그먼트 묶음(타임스탬프 보존), 붙여넣기는 텍스트 분할.
  // 각 청크는 { text, startSec } — 실패 시 빈자리 표시에 시작 시점을 쓴다.
  const chunks = source.segments
    ? chunkSegments(source.segments, CHUNK_CHARS).map((segs) => ({
        text: buildTimestampedText(segs),
        startSec: segs.length ? Math.floor(segs[0].start) : 0,
      }))
    : chunkRawText(transcriptText, CHUNK_CHARS).map((text) => ({ text, startSec: 0 }));

  // 구조 요약(독립 작업)을 먼저 띄워 트랜스크립트와 겹쳐 진행한다.
  const structurePromise = runStructure(transcriptText, hdr, isRaw, meta);

  // 트랜스크립트 청크 — 동시 CONCURRENCY개씩, 순서 보존, 부분 실패 허용.
  let done = 0;
  let gaps = 0;
  const onProgressTr = () => onProgress(`트랜스크립트 정리 중… (${done}/${chunks.length}, 병렬)`);
  onProgressTr();
  const partResults = await mapPool(chunks, CONCURRENCY, async (chunk, i) => {
    try {
      const part = await callJson({
        schema: TRANSCRIPT_SCHEMA,
        maxTokens: NONSTREAM_MAX,
        userText: isRaw
          ? `${hdr}\n\n아래는 긴 영상 텍스트의 ${i + 1}/${chunks.length} 구간이다(정밀 타임스탬프 없음).\n이 구간을 문단 단위 한글·원문 병기 트랜스크립트로 충실히 정리해줘(timestamp는 ""·seconds는 0). 이 구간만, 요약 금지.\n\n---\n${chunk.text}`
          : `${hdr}\n\n아래는 긴 영상 자막의 ${i + 1}/${chunks.length} 구간이다. 각 줄 앞 [숫자]는 시작 시점(초)이다.\n이 구간을 문단 단위 한글·원문 병기 트랜스크립트로 충실히 정리해줘. (이 구간만, 요약 금지.)\n\n---\n${chunk.text}`,
      });
      return Array.isArray(part.transcript) ? part.transcript : [];
    } catch (err) {
      // 한 구간이 끝내 실패해도 전체를 버리지 않는다 — 그 구간만 빈자리로 표시.
      gaps++;
      const sec = chunk.startSec;
      return [{
        timestamp: sec ? fmtTimestamp(sec) : "",
        seconds: sec,
        original: "",
        korean: `⚠️ (이 구간 ${i + 1}/${chunks.length}을 가져오지 못했어요: ${describeErr(err)})`,
      }];
    } finally {
      done++;
      onProgressTr();
    }
  });
  const transcript = partResults.flat(); // 순서 보존(mapPool이 인덱스 순서로 반환)

  onProgress("구조 요약 마무리 중…");
  const { structure, structureFailed } = await structurePromise;

  return {
    ...structure,
    transcript,
    partial: gaps > 0 || structureFailed,
    gaps,
    parts: chunks.length,
    structureFailed,
  };
}

/**
 * 동시 실행 개수를 limit로 제한하며 items를 fn으로 매핑한다(결과는 입력 순서 보존).
 * 트랜스크립트 청크를 병렬 처리해 시간을 줄이되, 레이트리밋을 넘지 않게 동시성을 묶는다.
 */
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

/**
 * 구조 요약 1회 호출(전체를 통째로 넣지 않고 영상 전체에서 고르게 뽑은 대표 발췌만 보냄).
 * 끝내 실패해도 최소 메타로 채워 트랜스크립트는 보존되도록 {structure, structureFailed} 반환.
 */
async function runStructure(transcriptText, hdr, isRaw, meta) {
  const structureText = downsample(transcriptText, STRUCTURE_INPUT_CAP);
  const sampledNote = structureText.length < transcriptText.length
    ? "\n(주의: 아래는 긴 영상이라 전체에서 고르게 뽑은 대표 발췌다. 타임스탬프는 전 구간에 퍼져 있으니 목차는 영상 흐름을 대표하도록 작성하고, 발췌 사이 공백을 걱정하지 마라.)"
    : "";
  try {
    const structure = await callJson({
      schema: STRUCTURE_SCHEMA,
      maxTokens: 16000,
      userText: isRaw
        ? `${hdr}\n\n아래는 유튜브 영상 페이지에서 자동 추출한 텍스트다(정밀 타임스탬프 없음).${sampledNote} 실제 자막 본문이 있으면 구조 요약(제목·맥락·핵심 시사점·마케터 관점·타임스탬프 목차·핵심 용어)을 작성하고, 메타데이터뿐이면 chapters는 빈 배열로 둬라. (본문 트랜스크립트는 별도 처리하므로 여기선 만들지 마라.)\n\n---\n${structureText}`
        : `${hdr}\n\n아래는 긴 유튜브 영상의 자막이다. 각 줄 앞 [숫자]는 시작 시점(초)이다.${sampledNote}\n구조 요약(제목·맥락·핵심 시사점·마케터 관점·타임스탬프 목차·핵심 용어)을 작성해줘. (본문 트랜스크립트는 별도로 처리하므로 여기서는 만들지 마라.)\n\n---\n${structureText}`,
    });
    return { structure, structureFailed: false };
  } catch (err) {
    console.error("[distill] 구조 요약 실패(트랜스크립트는 유지):", err);
    return { structure: minimalStructure(meta, describeErr(err)), structureFailed: true };
  }
}

/** 구조 요약 호출이 실패했을 때 쓰는 최소 메타(트랜스크립트는 보존). */
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
  };
}

/** 초 → mm:ss / h:mm:ss */
function fmtTimestamp(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
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
