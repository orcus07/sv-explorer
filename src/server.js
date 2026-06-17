// 유튜브 트랜스크립트 · 구조 증류 리더 — 서버.
// 링크를 받으면 자막을 가져와 구조 요약 + 한글·원문 병기 트랜스크립트로 증류해 돌려준다.
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { fetchTranscript, parseVideoId } from "./lib/fetchTranscript.js";
import { distill } from "./lib/distill.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(ROOT, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ anthropic: Boolean(process.env.ANTHROPIC_API_KEY) });
});

// 링크 → 자막 fetch → 증류
app.post("/api/digest", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "링크가 없습니다." });
  try {
    const t = await fetchTranscript(url.trim());
    const result = await distill(
      { segments: t.segments },
      { title: t.title, channel: t.channel, publishedDate: t.publishedDate, url },
    );
    res.json({ videoId: t.videoId, url, via: t.via, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message || "처리 중 오류가 발생했습니다." });
  }
});

// 자막 직접 붙여넣기 → 증류 (자막이 없거나 차단된 영상 우회용)
app.post("/api/digest-text", async (req, res) => {
  const { text, url = "", title = "" } = req.body || {};
  if (!text || text.trim().length < 100) {
    return res.status(400).json({ error: "자막 텍스트가 너무 짧습니다." });
  }
  try {
    const videoId = url ? parseVideoId(url) : null;
    const result = await distill({ rawText: text.trim() }, { title, url });
    res.json({ videoId, url, via: "paste", ...result });
  } catch (err) {
    res.status(500).json({ error: err.message || "처리 중 오류가 발생했습니다." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`유튜브 트랜스크립트 · 구조 증류 리더가 http://localhost:${PORT} 에서 실행 중입니다.`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠️  .env 에 ANTHROPIC_API_KEY 를 설정해야 정상 동작합니다.");
  }
});
