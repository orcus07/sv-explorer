// 유튜브 player response에서 스토리보드(스크럽바 미리보기 프레임) 스펙을 가져와 파싱한다.
//
// 왜 필요한가: 임베드 iframe은 cross-origin이라 브라우저가 화면을 캔버스로 캡쳐할 수 없다.
// 하지만 유튜브는 미리보기용 "실제 프레임 스프라이트"(storyboard)를 제공한다. 서버가 스펙을
// 받아(브라우저는 youtube.com에 CORS로 막힘) 파싱해 주면, 브라우저가 특정 타임스탬프의 타일을
// 잘라 한/영 자막을 얹어 캡쳐 이미지를 만들 수 있다. 스프라이트 이미지 자체는 /api/sb-image
// 프록시로 받아 CORS 오염 없이 캔버스에 그린다.
//
// 클라우드 IP는 유튜브가 자주 막으므로(자막과 동일한 사정) 실패할 수 있다 → 그 경우 프론트가
// 썸네일 기반 자막 카드로 폴백한다.

import { parseVideoId } from "./fetchTranscript.js";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Cookie: "CONSENT=YES+cb",
};

/** 여는 중괄호 위치부터 균형 맞는 JSON 객체를 잘라낸다. */
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
    else if (ch === "}") { depth--; if (depth === 0) return str.slice(startIndex, i + 1); }
  }
  return null;
}

function extractPlayerResponse(html) {
  const idx = html.indexOf("ytInitialPlayerResponse");
  if (idx === -1) return null;
  const brace = html.indexOf("{", idx);
  if (brace === -1) return null;
  const json = extractBalancedJson(html, brace);
  try { return json ? JSON.parse(json) : null; } catch { return null; }
}

/** WEB InnerTube player — storyboards 필드를 안정적으로 포함한다. */
async function fetchPlayerWeb(videoId) {
  const res = await fetch(
    "https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": BROWSER_HEADERS["User-Agent"],
        "X-YouTube-Client-Name": "1",
        "X-YouTube-Client-Version": "2.20240101.00.00",
        "Accept-Language": "en-US,en;q=0.9",
      },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: "2.20240101.00.00", hl: "en", gl: "US" } },
        videoId, contentCheckOk: true, racyCheckOk: true,
      }),
    },
  );
  if (!res.ok) throw new Error(`player HTTP ${res.status}`);
  return await res.json();
}

/** watch 페이지 스크레이핑 폴백. */
async function fetchPlayerWatch(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: BROWSER_HEADERS, redirect: "follow",
  });
  if (!res.ok) throw new Error(`watch HTTP ${res.status}`);
  const html = await res.text();
  const player = extractPlayerResponse(html);
  if (!player) throw new Error("player 파싱 실패");
  return player;
}

/**
 * storyboard3 스펙 문자열을 파싱한다.
 * 형식: "BASE|L0#필드|L1#필드|…"  각 레벨 필드(#): width,height,count,cols,rows,intervalMs,name,sigh
 * BASE 예: https://i.ytimg.com/sb/<id>/storyboard3_L$L/$N.jpg?sqp=…  ($L=레벨, $N=name(안에 $M=시트번호))
 */
function parseSpec(spec) {
  const parts = String(spec || "").split("|");
  const base = parts.shift();
  if (!base) return null;
  const levels = parts
    .map((seg, i) => {
      const f = seg.split("#");
      return {
        levelIndex: i,
        width: +f[0], height: +f[1], count: +f[2],
        cols: +f[3], rows: +f[4], intervalMs: +f[5],
        name: f[6] || "", sigh: f[7] || "",
      };
    })
    .filter((l) => l.width > 0 && l.cols > 0 && l.rows > 0);
  if (!levels.length) return null;
  return { base, levels };
}

/** 한 레벨의 시트(스프라이트 이미지) URL들을 만든다. */
function sheetUrls(base, lvl) {
  const perSheet = lvl.cols * lvl.rows;
  const total = lvl.count > 0 ? lvl.count : perSheet;
  const sheets = Math.max(1, Math.ceil(total / perSheet));
  const urls = [];
  for (let m = 0; m < sheets; m++) {
    let u = base
      .replace("$L", String(lvl.levelIndex))
      .replace("$N", lvl.name)
      .replace(/\$M/g, String(m));
    u += (u.includes("?") ? "&" : "?") + "sigh=" + lvl.sigh;
    urls.push(u);
  }
  return urls;
}

/**
 * videoId → 캡쳐용 스토리보드 정보. 실패하면 { ok:false, reason } (throw하지 않음).
 * "그 순간" 프레임을 위해 intervalMs>0인 레벨 중 가장 고해상을 고른다.
 */
export async function getStoryboard(input) {
  const videoId = parseVideoId(input);
  if (!videoId) return { ok: false, reason: "invalid_id" };

  let player = null;
  const errs = [];
  for (const fn of [fetchPlayerWeb, fetchPlayerWatch]) {
    try { player = await fn(videoId); break; } catch (e) { errs.push(e.message); }
  }
  if (!player) return { ok: false, reason: "player_unavailable", detail: errs.join(" / ") };

  const spec = player.storyboards?.playerStoryboardSpecRenderer?.spec;
  if (!spec) return { ok: false, reason: "no_storyboard" };
  const parsed = parseSpec(spec);
  if (!parsed) return { ok: false, reason: "spec_parse_failed" };

  // 순간 단위(interval>0) 레벨 우선, 그 중 가장 고해상. 없으면 아무 레벨.
  const withInterval = parsed.levels.filter((l) => l.intervalMs > 0);
  const pool = withInterval.length ? withInterval : parsed.levels;
  const lvl = pool.reduce((a, b) => (b.width > a.width ? b : a));

  const duration = Number(player.videoDetails?.lengthSeconds || 0) || 0;
  return {
    ok: true,
    videoId,
    tileW: lvl.width,
    tileH: lvl.height,
    cols: lvl.cols,
    rows: lvl.rows,
    intervalMs: lvl.intervalMs,   // 0이면 단일 개요 시트(순간 정밀도 낮음)
    count: lvl.count,
    duration,
    sheets: sheetUrls(parsed.base, lvl),
  };
}
