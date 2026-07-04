// 유튜브 트랜스크립트 · 구조 증류 리더 — 서버.
//
// 역할이 가벼워졌다: 서버는 "자막 가져오기"만 한다(Supadata 등, 작고 빠름).
// 무거운 Claude 호출(구조 요약·트랜스크립트)은 브라우저가 사용자 본인 API 키로
// api.anthropic.com에 직접 한다 → Render(무료) → Anthropic 연결 끊김 문제를 우회.
//
//   POST /api/transcript  → { url }  → 자막을 가져와 { segments|rawText, meta } 반환
//   GET  /api/health      → { supadata } (자막 자동 추출 키 설정 여부)
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { fetchTranscript } from "./lib/fetchTranscript.js";
import { getStoryboard } from "./lib/storyboard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const app = express();
app.set("trust proxy", 1); // Render 등 프록시 뒤 → req.ip 가 실제 클라이언트 IP가 되게(레이트리밋 정확도)

// Content-Security-Policy — XSS/키 유출 표면 축소. 핵심은 connect-src: 스크립트가 오염돼도
// 데이터를 api.anthropic.com·자기 서버 외 임의 호스트로 보낼 수 없게 한다. 유튜브 임베드에
// 필요한 script/frame 출처는 허용. 혹시 임베드/증류가 깨지면 DISABLE_CSP=1 로 즉시 끌 수 있다.
if (process.env.DISABLE_CSP !== "1") {
  const CSP = [
    "default-src 'self'",
    "script-src 'self' https://www.youtube.com https://s.ytimg.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "media-src 'self' blob: https:",
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
    "connect-src 'self' https://api.anthropic.com",
    "font-src 'self' data:",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
  app.use((_req, res, next) => { res.set("Content-Security-Policy", CSP); next(); });
}

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(ROOT, "public")));

// (선택) 접근 토큰 게이트 — 공개 URL에서 남이 서버 자막 수집(내 Supadata 쿼터)을
// 함부로 못 쓰게 막는다. APP_ACCESS_TOKEN 이 설정된 경우에만 활성화되며,
// 없으면(로컬·기존 배포) 그대로 열려 있어 하위호환. 클라이언트는 x-app-token 헤더(이미지는 ?token=)로 보낸다.
const ACCESS_TOKEN = (process.env.APP_ACCESS_TOKEN || "").trim();
function requireToken(req, res, next) {
  if (!ACCESS_TOKEN) return next(); // 미설정 → 공개(기존 동작)
  const given = (req.get("x-app-token") || req.query.token || "").toString();
  if (given === ACCESS_TOKEN) return next();
  return res.status(401).json({ error: "앱 접근 토큰이 필요합니다(또는 틀림). 화면 ☰ 에서 입력하세요." });
}

// 초경량 인메모리 레이트리밋(의존성 없음) — IP당 고정 창. 서버 남용·대역폭 소진 방어용.
function rateLimiter({ windowMs, max }) {
  const hits = new Map(); // ip → { count, reset }
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    if (hits.size > 5000) { for (const [k, v] of hits) if (now > v.reset) hits.delete(k); } // 가끔 청소
    let e = hits.get(ip);
    if (!e || now > e.reset) { e = { count: 0, reset: now + windowMs }; hits.set(ip, e); }
    e.count++;
    if (e.count > max) {
      res.set("Retry-After", String(Math.ceil((e.reset - now) / 1000)));
      return res.status(429).json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해줘." });
    }
    next();
  };
}
const limitTranscript = rateLimiter({ windowMs: 60000, max: 30 }); // 무거움·Supadata 소모 → 빡세게
const limitStoryboard = rateLimiter({ windowMs: 60000, max: 60 });
const limitImage = rateLimiter({ windowMs: 60000, max: 120 });     // 캡쳐당 소수 이미지 → 넉넉히

app.get("/api/health", (_req, res) => {
  res.json({ supadata: Boolean(process.env.SUPADATA_API_KEY), tokenRequired: Boolean(ACCESS_TOKEN) });
});

// 링크 → 자막 추출 (동기 응답; Claude 호출은 브라우저가 직접 함)
app.post("/api/transcript", limitTranscript, requireToken, async (req, res) => {
  const { url } = req.body || {};
  if (!url || !url.trim()) {
    return res.status(400).json({ error: "링크가 없습니다." });
  }
  try {
    const t = await fetchTranscript(url.trim());
    res.json({
      videoId: t.videoId,
      title: t.title || "",
      channel: t.channel || "",
      publishedDate: t.publishedDate || "",
      via: t.via,
      ...(t.segments ? { segments: t.segments } : { rawText: t.rawText }),
    });
  } catch (err) {
    res.status(502).json({ error: err.message || "자막을 가져오지 못했습니다." });
  }
});

// 링크 → 스토리보드(미리보기 프레임) 스펙. 브라우저가 특정 시점 타일을 잘라 자막을 얹어 캡쳐한다.
// 실패해도 200 + { ok:false }로 응답 → 프론트가 썸네일 자막 카드로 폴백한다.
app.get("/api/storyboard", limitStoryboard, requireToken, async (req, res) => {
  const v = (req.query.v || "").toString().trim();
  if (!v) return res.json({ ok: false, reason: "no_video" });
  try {
    const sb = await getStoryboard(v);
    res.json(sb);
  } catch (err) {
    res.json({ ok: false, reason: "error", detail: err.message || "" });
  }
});

// 스토리보드/썸네일 이미지 프록시 — i.ytimg.com 만 허용(SSRF 방지). CORS 헤더를 붙여
// 브라우저 캔버스가 오염 없이 그려 PNG로 뽑을 수 있게 한다.
// <img> 로딩이라 헤더를 못 붙이므로 토큰은 ?token= 쿼리로 검증(requireToken이 지원). 레이트리밋 적용.
app.get("/api/sb-image", limitImage, requireToken, async (req, res) => {
  const u = (req.query.u || "").toString();
  let target;
  try { target = new URL(u); } catch { return res.status(400).send("bad url"); }
  if (target.protocol !== "https:" || target.hostname !== "i.ytimg.com") {
    return res.status(403).send("host not allowed");
  }
  try {
    const upstream = await fetch(target.href, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "image/jpeg,image/*" },
    });
    if (!upstream.ok) return res.status(502).send(`upstream ${upstream.status}`);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (err) {
    res.status(502).send("fetch failed");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`유튜브 트랜스크립트 · 구조 증류 리더가 http://localhost:${PORT} 에서 실행 중입니다.`);
  if (!process.env.SUPADATA_API_KEY) {
    console.warn("⚠️  SUPADATA_API_KEY 가 없으면 링크 자동 자막 추출이 불안정할 수 있습니다.");
  }
});
