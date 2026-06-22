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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`유튜브 트랜스크립트 · 구조 증류 리더가 http://localhost:${PORT} 에서 실행 중입니다.`);
  if (!process.env.SUPADATA_API_KEY) {
    console.warn("⚠️  SUPADATA_API_KEY 가 없으면 링크 자동 자막 추출이 불안정할 수 있습니다.");
  }
});
