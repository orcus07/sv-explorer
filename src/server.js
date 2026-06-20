// 유튜브 트랜스크립트 · 구조 증류 리더 — 서버.
// 링크를 받으면 자막을 가져와 구조 요약 + 한글·원문 병기 트랜스크립트로 증류해 돌려준다.
//
// 긴 영상은 처리에 수 분이 걸려, 하나의 긴 HTTP 요청은 모바일/프록시 타임아웃으로 끊긴다.
// 그래서 백그라운드 작업 + 폴링 구조를 쓴다:
//   POST /api/digest      → 작업 시작, jobId 즉시 반환(백그라운드 처리)
//   GET  /api/job/:id     → 진행 상황/결과 조회 (클라이언트가 몇 초마다 폴링)
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

// ── 작업(job) 저장소 (인메모리) ──────────────────────────────────────────
const jobs = new Map(); // id -> { status, progress, result?, error?, ts }
const JOB_TTL = 30 * 60 * 1000;

function newJob() {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  jobs.set(id, { status: "running", progress: "시작하는 중…", ts: Date.now() });
  return id;
}
function setProgress(id, msg) {
  const j = jobs.get(id);
  if (j) { j.progress = msg; j.ts = Date.now(); }
}
function finishJob(id, result) {
  const j = jobs.get(id);
  if (j) { j.status = "done"; j.result = result; j.ts = Date.now(); }
}
function failJob(id, msg) {
  const j = jobs.get(id);
  if (j) { j.status = "error"; j.error = msg; j.ts = Date.now(); }
}
// 오래된 작업 정리
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.ts > JOB_TTL) jobs.delete(id);
}, 5 * 60 * 1000).unref?.();

// 링크 → 자막 fetch → 증류 (백그라운드)
app.post("/api/digest", (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "링크가 없습니다." });
  const id = newJob();
  res.json({ jobId: id });
  (async () => {
    try {
      setProgress(id, "자막 가져오는 중…");
      const t = await fetchTranscript(url.trim());
      const source = t.segments ? { segments: t.segments } : { rawText: t.rawText };
      const result = await distill(
        source,
        { title: t.title, channel: t.channel, publishedDate: t.publishedDate, url },
        (m) => setProgress(id, m),
      );
      finishJob(id, { videoId: t.videoId, url, via: t.via, ...result });
    } catch (err) {
      failJob(id, err.message || "처리 중 오류가 발생했습니다.");
    }
  })();
});

// 자막 직접 붙여넣기 → 증류 (백그라운드)
app.post("/api/digest-text", (req, res) => {
  const { text, url = "", title = "" } = req.body || {};
  if (!text || text.trim().length < 100) {
    return res.status(400).json({ error: "자막 텍스트가 너무 짧습니다." });
  }
  const id = newJob();
  res.json({ jobId: id });
  (async () => {
    try {
      const videoId = url ? parseVideoId(url) : null;
      const result = await distill(
        { rawText: text.trim() },
        { title, url },
        (m) => setProgress(id, m),
      );
      finishJob(id, { videoId, url, via: "paste", ...result });
    } catch (err) {
      failJob(id, err.message || "처리 중 오류가 발생했습니다.");
    }
  })();
});

// 작업 상태/결과 조회 (폴링)
app.get("/api/job/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) {
    return res
      .status(404)
      .json({ error: "작업을 찾을 수 없습니다(만료되었을 수 있어요). 다시 시도해 주세요." });
  }
  if (j.status === "done") return res.json({ status: "done", result: j.result });
  if (j.status === "error") return res.json({ status: "error", error: j.error });
  return res.json({ status: "running", progress: j.progress });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`유튜브 트랜스크립트 · 구조 증류 리더가 http://localhost:${PORT} 에서 실행 중입니다.`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠️  .env 에 ANTHROPIC_API_KEY 를 설정해야 정상 동작합니다.");
  }
});
