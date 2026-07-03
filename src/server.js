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
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(ROOT, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ supadata: Boolean(process.env.SUPADATA_API_KEY) });
});

// 링크 → 자막 추출 (동기 응답; Claude 호출은 브라우저가 직접 함)
app.post("/api/transcript", async (req, res) => {
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
app.get("/api/storyboard", async (req, res) => {
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
app.get("/api/sb-image", async (req, res) => {
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
