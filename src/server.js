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

// 긴 증류 동안 연결이 유휴로 끊기지 않게, 처리 중 주기적으로 heartbeat(빈 줄)를 흘려보낸다.
// 응답은 NDJSON: 처리 중에는 "\n"(무시), 마지막 줄에 결과 또는 {error} JSON 한 줄.
async function streamDigest(res, work) {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  const hb = setInterval(() => {
    try { res.write("\n"); } catch {}
  }, 10000);
  try {
    const result = await work();
    clearInterval(hb);
    res.write(JSON.stringify(result) + "\n");
    res.end();
  } catch (err) {
    clearInterval(hb);
    res.write(JSON.stringify({ error: err.message || "처리 중 오류가 발생했습니다." }) + "\n");
    res.end();
  }
}

// 링크 → 자막 fetch → 증류
app.post("/api/digest", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "링크가 없습니다." });
  await streamDigest(res, async () => {
    const t = await fetchTranscript(url.trim());
    const source = t.segments ? { segments: t.segments } : { rawText: t.rawText };
    const result = await distill(source, {
      title: t.title,
      channel: t.channel,
      publishedDate: t.publishedDate,
      url,
    });
    return { videoId: t.videoId, url, via: t.via, ...result };
  });
});

// 자막 직접 붙여넣기 → 증류 (자막이 없거나 차단된 영상 우회용)
app.post("/api/digest-text", async (req, res) => {
  const { text, url = "", title = "" } = req.body || {};
  if (!text || text.trim().length < 100) {
    return res.status(400).json({ error: "자막 텍스트가 너무 짧습니다." });
  }
  await streamDigest(res, async () => {
    const videoId = url ? parseVideoId(url) : null;
    const result = await distill({ rawText: text.trim() }, { title, url });
    return { videoId, url, via: "paste", ...result };
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`유튜브 트랜스크립트 · 구조 증류 리더가 http://localhost:${PORT} 에서 실행 중입니다.`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠️  .env 에 ANTHROPIC_API_KEY 를 설정해야 정상 동작합니다.");
  }
});
