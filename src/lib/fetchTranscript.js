// 유튜브 링크에서 자막(트랜스크립트) + 메타데이터를 가져온다.
// 의존성 없이 watch 페이지의 ytInitialPlayerResponse를 파싱해 자막 트랙을 찾고,
// timedtext(json3)로 타임스탬프가 붙은 세그먼트를 받아온다.
// 자막이 없거나 차단되면 에러를 던지고, 화면에서 "붙여넣기"로 우회한다.

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  // EU 동의(consent) 페이지 우회
  Cookie: "CONSENT=YES+cb",
};

/** 다양한 유튜브 URL 형태에서 11자리 video ID를 추출한다. */
export function parseVideoId(input) {
  const s = (input || "").trim();
  // 이미 11자리 ID만 들어온 경우
  if (/^[\w-]{11}$/.test(s)) return s;
  const patterns = [
    /[?&]v=([\w-]{11})/, // watch?v=
    /youtu\.be\/([\w-]{11})/, // youtu.be/
    /\/shorts\/([\w-]{11})/, // /shorts/
    /\/embed\/([\w-]{11})/, // /embed/
    /\/live\/([\w-]{11})/, // /live/
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

/** 문자열의 startIndex 위치(여는 중괄호)부터 균형 맞는 JSON 객체를 잘라낸다. */
function extractBalancedJson(str, startIndex) {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = startIndex; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return str.slice(startIndex, i + 1);
    }
  }
  return null;
}

/** watch 페이지 HTML에서 ytInitialPlayerResponse 객체를 파싱한다. */
function extractPlayerResponse(html) {
  const marker = "ytInitialPlayerResponse";
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const brace = html.indexOf("{", idx);
  if (brace === -1) return null;
  const json = extractBalancedJson(html, brace);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** 자막 트랙 목록에서 선호 트랙을 고른다(수동 자막 우선, 요청 언어 우선). */
function pickTrack(tracks, preferLang) {
  if (!tracks || tracks.length === 0) return null;
  const manual = tracks.filter((t) => t.kind !== "asr");
  const order = [
    manual.find((t) => t.languageCode?.startsWith(preferLang)),
    manual.find((t) => t.languageCode?.startsWith("en")),
    manual[0],
    tracks.find((t) => t.languageCode?.startsWith(preferLang)),
    tracks.find((t) => t.languageCode?.startsWith("en")),
    tracks[0],
  ];
  return order.find(Boolean) || null;
}

/** timedtext json3 응답을 { start, text } 세그먼트 배열로 변환한다. */
function parseJson3(events) {
  const segments = [];
  for (const ev of events || []) {
    if (!ev.segs) continue;
    const text = ev.segs
      .map((s) => s.utf8 || "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    segments.push({ start: Math.floor((ev.tStartMs || 0) / 1000), text });
  }
  return segments;
}

/**
 * 유튜브 URL/ID에서 자막과 메타데이터를 가져온다.
 * @param {string} input - 유튜브 링크 또는 video ID
 * @param {{lang?: string}} [opts] - 선호 자막 언어 (기본 ko, 없으면 en→기타)
 * @returns {Promise<{videoId,title,channel,publishedDate,trackLang,segments,via}>}
 */
export async function fetchTranscript(input, { lang = "ko" } = {}) {
  const videoId = parseVideoId(input);
  if (!videoId) {
    throw new Error("유효한 유튜브 링크가 아닙니다. (watch?v=, youtu.be, shorts 등 지원)");
  }

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}&hl=en`;
  const res = await fetch(watchUrl, { headers: BROWSER_HEADERS, redirect: "follow" });
  if (!res.ok) throw new Error(`유튜브 페이지를 불러오지 못했습니다 (HTTP ${res.status}).`);
  const html = await res.text();

  const player = extractPlayerResponse(html);
  if (!player) {
    throw new Error("영상 정보를 파싱하지 못했습니다. 자막을 직접 붙여넣어 주세요.");
  }

  const status = player.playabilityStatus?.status;
  if (status && status !== "OK") {
    const reason = player.playabilityStatus?.reason || status;
    throw new Error(`이 영상은 자동 처리가 어렵습니다 (${reason}). 자막을 직접 붙여넣어 주세요.`);
  }

  const details = player.videoDetails || {};
  const micro = player.microformat?.playerMicroformatRenderer || {};
  const title = details.title || micro.title?.simpleText || "";
  const channel = details.author || micro.ownerChannelName || "";
  const publishedDate = micro.publishDate || micro.uploadDate || "";

  const tracks =
    player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const track = pickTrack(tracks, lang);
  if (!track?.baseUrl) {
    throw new Error("이 영상에는 가져올 수 있는 자막이 없습니다. 자막을 직접 붙여넣어 주세요.");
  }

  const ttUrl = track.baseUrl + "&fmt=json3";
  const ttRes = await fetch(ttUrl, { headers: BROWSER_HEADERS });
  if (!ttRes.ok) throw new Error(`자막을 불러오지 못했습니다 (HTTP ${ttRes.status}).`);
  const tt = await ttRes.json();
  const segments = parseJson3(tt.events);
  if (segments.length === 0) {
    throw new Error("자막이 비어 있습니다. 자막을 직접 붙여넣어 주세요.");
  }

  return {
    videoId,
    title,
    channel,
    publishedDate,
    trackLang: track.languageCode || "",
    segments,
    via: track.kind === "asr" ? "auto-caption" : "caption",
  };
}
