// 유튜브 링크에서 자막(트랜스크립트) + 메타데이터를 가져온다.
//
// 클라우드(데이터센터) IP에서 watch 페이지가 403/429로 막히는 경우가 많아,
// 여러 전략을 순서대로 시도한다:
//   1) InnerTube player API (ANDROID → IOS 클라이언트)  — watch 페이지보다 덜 막힘
//   2) watch 페이지의 ytInitialPlayerResponse 스크레이핑   — 폴백
// 환경변수 YT_PROXY 가 설정되면 모든 외부 요청을 그 프록시로 보낸다(주거용 프록시 권장).
// 모두 막히면 에러를 던지고 화면에서 "자막 직접 붙여넣기"로 우회한다.

// (선택) 외부 프록시 — 데이터센터 IP 차단 우회용. 예: http://user:pass@host:port
if (process.env.YT_PROXY) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(process.env.YT_PROXY));
    console.log("[fetchTranscript] YT_PROXY 사용 중");
  } catch (e) {
    console.warn("[fetchTranscript] YT_PROXY 설정 실패:", e.message);
  }
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Cookie: "CONSENT=YES+cb",
};

// InnerTube 클라이언트(공개 키). ANDROID/IOS 는 자막 트랙을 반환하며 봇 차단이 약하다.
const INNERTUBE_CLIENTS = [
  {
    key: "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
    userAgent: "com.google.android.youtube/19.44.38 (Linux; U; Android 14) gzip",
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: "19.44.38",
        androidSdkVersion: 34,
        hl: "en",
        gl: "US",
      },
    },
    name: "3",
  },
  {
    key: "AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc",
    userAgent:
      "com.google.ios.youtube/19.44.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)",
    context: {
      client: {
        clientName: "IOS",
        clientVersion: "19.44.4",
        deviceModel: "iPhone16,2",
        hl: "en",
        gl: "US",
      },
    },
    name: "5",
  },
];

/** 다양한 유튜브 URL 형태에서 11자리 video ID를 추출한다. */
export function parseVideoId(input) {
  const s = (input || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const patterns = [
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /\/shorts\/([\w-]{11})/,
    /\/embed\/([\w-]{11})/,
    /\/live\/([\w-]{11})/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

/** 문자열의 startIndex 위치(여는 중괄호)부터 균형 맞는 JSON 객체를 잘라낸다. */
function extractBalancedJson(str, startIndex) {
  let depth = 0, inStr = false, escaped = false;
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

function extractPlayerResponse(html) {
  const idx = html.indexOf("ytInitialPlayerResponse");
  if (idx === -1) return null;
  const brace = html.indexOf("{", idx);
  if (brace === -1) return null;
  const json = extractBalancedJson(html, brace);
  try {
    return json ? JSON.parse(json) : null;
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
    const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    segments.push({ start: Math.floor((ev.tStartMs || 0) / 1000), text });
  }
  return segments;
}

/** 플레이어 응답에서 메타·자막트랙을 꺼내 세그먼트를 받아온다. */
async function segmentsFromPlayer(player, lang, userAgent) {
  const status = player.playabilityStatus?.status;
  if (status && status !== "OK" && status !== "LIVE_STREAM_OFFLINE") {
    throw new Error(`재생 불가 상태(${player.playabilityStatus?.reason || status})`);
  }
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const track = pickTrack(tracks, lang);
  if (!track?.baseUrl) throw new Error("자막 트랙 없음");

  const ttUrl = track.baseUrl + (track.baseUrl.includes("fmt=") ? "" : "&fmt=json3");
  const ttRes = await fetch(ttUrl.replace(/&fmt=\w+/, "&fmt=json3"), {
    headers: { "User-Agent": userAgent, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!ttRes.ok) throw new Error(`자막 다운로드 실패 (HTTP ${ttRes.status})`);
  const tt = await ttRes.json();
  const segments = parseJson3(tt.events);
  if (segments.length === 0) throw new Error("자막이 비어 있음");

  const details = player.videoDetails || {};
  const micro = player.microformat?.playerMicroformatRenderer || {};
  return {
    title: details.title || micro.title?.simpleText || "",
    channel: details.author || micro.ownerChannelName || "",
    publishedDate: micro.publishDate || micro.uploadDate || "",
    trackLang: track.languageCode || "",
    segments,
    via: track.kind === "asr" ? "auto-caption" : "caption",
  };
}

/** 전략 1: InnerTube player API (ANDROID → IOS). */
async function tryInnertube(videoId, lang) {
  let lastErr;
  for (const c of INNERTUBE_CLIENTS) {
    try {
      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${c.key}&prettyPrint=false`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": c.userAgent,
            "X-YouTube-Client-Name": c.name,
            "X-YouTube-Client-Version": c.context.client.clientVersion,
            "Accept-Language": "en-US,en;q=0.9",
          },
          body: JSON.stringify({
            context: c.context,
            videoId,
            contentCheckOk: true,
            racyCheckOk: true,
          }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const player = await res.json();
      return await segmentsFromPlayer(player, lang, c.userAgent);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`InnerTube 실패 (${lastErr?.message || "unknown"})`);
}

/** 전략 2: watch 페이지 스크레이핑. */
async function tryWatchPage(videoId, lang) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`watch 페이지 HTTP ${res.status}`);
  const html = await res.text();
  const player = extractPlayerResponse(html);
  if (!player) throw new Error("플레이어 정보 파싱 실패");
  return await segmentsFromPlayer(player, lang, BROWSER_HEADERS["User-Agent"]);
}

/**
 * 유튜브 URL/ID에서 자막과 메타데이터를 가져온다.
 * @param {string} input - 유튜브 링크 또는 video ID
 * @param {{lang?: string}} [opts] - 선호 자막 언어 (기본 ko, 없으면 en→기타)
 */
export async function fetchTranscript(input, { lang = "ko" } = {}) {
  const videoId = parseVideoId(input);
  if (!videoId) {
    throw new Error("유효한 유튜브 링크가 아닙니다. (watch?v=, youtu.be, shorts 등 지원)");
  }

  const errors = [];
  for (const strategy of [tryInnertube, tryWatchPage]) {
    try {
      const out = await strategy(videoId, lang);
      return { videoId, ...out };
    } catch (e) {
      errors.push(e.message);
    }
  }

  throw new Error(
    `이 영상의 자막을 가져오지 못했습니다 (${errors.join(" / ")}). ` +
      `유튜브가 이 서버 IP를 차단했을 수 있어요. "자막 직접 붙여넣기"로 처리하거나, ` +
      `서버에 YT_PROXY(주거용 프록시)를 설정해 보세요.`,
  );
}
