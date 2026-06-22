// 유튜브 트랜스크립트 · 구조 증류 리더 — 프론트엔드.
// 링크/붙여넣기 → 서버 증류 → 화면 렌더 + 보관함(localStorage).
// 타임스탬프 클릭 → sticky 임베드 플레이어 점프 + 해당 트랜스크립트 위치로 스크롤.

const $ = (id) => document.getElementById(id);
const STORE_KEY = "yt-distill-archive";

let archive = loadArchive();
let current = null;
let ytPlayer = null;
let ytReady = false;

// ── YouTube IFrame API ─────────────────────────────────────────────────
(function loadYT() {
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
})();
window.onYouTubeIframeAPIReady = () => { ytReady = true; };

function mountPlayer(videoId) {
  $("player-wrap").classList.remove("hidden");
  $("r-grid").classList.remove("no-player");
  const make = () => {
    $("player").innerHTML = "";
    ytPlayer = new YT.Player("player", { videoId, playerVars: { rel: 0, modestbranding: 1 } });
  };
  if (ytReady && window.YT?.Player) make();
  else {
    const wait = setInterval(() => {
      if (ytReady && window.YT?.Player) { clearInterval(wait); make(); }
    }, 150);
  }
}

function seekTo(seconds) {
  if (ytPlayer?.seekTo) {
    ytPlayer.seekTo(seconds, true);
    ytPlayer.playVideo?.();
  }
}

/** 해당 시점에 가장 가까운 트랜스크립트 문단으로 스크롤(영상 유무와 무관). */
function scrollToTranscript(seconds) {
  const paras = [...document.querySelectorAll("#r-transcript .tr-para[data-sec]")];
  let target = null;
  for (const p of paras) {
    if (Number(p.dataset.sec) <= seconds + 0.5) target = p;
    else break;
  }
  target = target || paras[0];
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1200);
}

// ── 보관함 ──────────────────────────────────────────────────────────────
function loadArchive() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); }
  catch { return []; }
}
function saveArchive() { localStorage.setItem(STORE_KEY, JSON.stringify(archive)); }
function archiveKey(it) { return it.videoId || it.url || it.originalTitle || it.koreanTitle; }

function renderList() {
  const q = $("search").value.trim().toLowerCase();
  const list = $("list");
  list.innerHTML = "";
  const items = archive.filter((it) =>
    !q ||
    (it.koreanTitle || "").toLowerCase().includes(q) ||
    (it.originalTitle || "").toLowerCase().includes(q) ||
    (it.channel || "").toLowerCase().includes(q) ||
    (it.oneLiner || "").toLowerCase().includes(q),
  );
  $("empty-list").classList.toggle("hidden", items.length > 0);
  for (const it of items) {
    const li = document.createElement("li");
    li.className = "list-item" + (current && archiveKey(it) === archiveKey(current) ? " active" : "");
    li.innerHTML = `<strong>${esc(it.koreanTitle || it.originalTitle || "(제목 없음)")}</strong>
      <span class="muted small">${esc(it.channel || "")}</span>`;
    li.onclick = () => { show(it); closeDrawer(); };
    list.appendChild(li);
  }
}

function upsertArchive(item) {
  const key = archiveKey(item);
  archive = archive.filter((it) => archiveKey(it) !== key);
  archive.unshift(item);
  saveArchive();
  renderList();
}

// ── 유틸 ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ── 렌더링 ──────────────────────────────────────────────────────────────
function show(item) {
  current = item;
  $("empty-state").classList.add("hidden");
  $("result").classList.remove("hidden");
  const hasVideo = !!item.videoId;

  $("r-source").textContent =
    { supadata: "자동 추출", caption: "자막", "auto-caption": "자동 자막", proxy: "자동(프록시)", paste: "붙여넣기" }[item.via] ||
    item.via || "";
  $("r-title").textContent = item.koreanTitle || item.originalTitle || "(제목 없음)";
  $("r-original").textContent = item.originalTitle || "";
  $("r-meta").textContent = [item.channel, item.publishedDate, item.sourceLang && `원어: ${item.sourceLang}`]
    .filter(Boolean).join("  ·  ");

  // 영상 / 레일
  if (hasVideo) {
    mountPlayer(item.videoId);
    $("r-link").href = `https://www.youtube.com/watch?v=${item.videoId}`;
    $("r-link").classList.remove("hidden");
  } else {
    $("player-wrap").classList.add("hidden");
    $("r-grid").classList.add("no-player");
    if (item.url) { $("r-link").href = item.url; $("r-link").classList.remove("hidden"); }
    else $("r-link").classList.add("hidden");
  }

  $("r-oneliner").textContent = item.oneLiner || "";
  $("r-topic").textContent = item.topic || "";
  fillList("r-takeaways", item.keyTakeaways || []);

  // 마케터 관점
  const rel = item.marketerAngle?.relevance || "none";
  const relEl = $("r-relevance");
  relEl.textContent = { high: "연관 높음", medium: "연관 보통", low: "연관 낮음", none: "연관 없음" }[rel];
  relEl.className = `relevance rel-${rel}`;
  const notes = item.marketerAngle?.notes || [];
  fillList("r-angle", notes);
  $("r-angle-none").classList.toggle("hidden", notes.length > 0);

  // 구조 요약(챕터)
  const chEl = $("r-chapters");
  chEl.innerHTML = "";
  for (const ch of item.chapters || []) {
    const li = document.createElement("li");
    li.className = "chapter";
    const ts = document.createElement("button");
    ts.className = "ts";
    ts.textContent = ch.timestamp || fmtTime(ch.seconds);
    ts.onclick = () => { if (hasVideo) seekTo(ch.seconds); scrollToTranscript(ch.seconds); };
    const body = document.createElement("div");
    body.className = "c-body";
    body.innerHTML = `<strong>${esc(ch.heading)}</strong><span class="muted small">${esc(ch.summary)}</span>`;
    li.append(ts, body);
    chEl.appendChild(li);
  }

  renderTranscript(item);

  // 빈 섹션 숨김 + 자막 미수집 안내
  const hasChapters = (item.chapters || []).length > 0;
  const hasTranscript = (item.transcript || []).length > 0;
  $("chapters-block").classList.toggle("hidden", !hasChapters);
  $("transcript-block").classList.toggle("hidden", !hasTranscript);
  const notice = $("thin-notice");
  if (!hasTranscript) {
    notice.innerHTML =
      "⚠️ 이 영상은 <b>자막 본문</b>을 자동으로 가져오지 못해 영상 설명 기반으로만 요약했어요. " +
      "전체 한글·원문 트랜스크립트가 필요하면 위 <b>“자막 직접 붙여넣기”</b>로 다시 처리해 주세요.";
    notice.classList.remove("hidden");
  } else if (item.structureFailed) {
    notice.innerHTML =
      "⚠️ <b>전체 트랜스크립트는 정상</b>으로 정리됐지만, 위쪽 <b>구조 요약(목차·핵심 시사점 등)</b>은 일시적 오류로 만들지 못했어요. " +
      "요약이 필요하면 잠시 후 같은 링크로 다시 돌려보세요. 트랜스크립트는 아래에 그대로 있습니다.";
    notice.classList.remove("hidden");
  } else if (item.partial) {
    notice.innerHTML =
      `⚠️ 긴 영상이라 <b>${item.parts}개 구간</b> 중 <b>${item.gaps}개</b>를 가져오지 못했어요. ` +
      "구조 요약과 나머지 구간은 그대로 보여드려요. 빈 구간(⚠️ 표시)이 필요하면 잠시 후 같은 링크로 다시 돌리면 채워집니다.";
    notice.classList.remove("hidden");
  } else {
    notice.classList.add("hidden");
  }

  // 핵심 용어
  const dl = $("r-terms");
  dl.innerHTML = "";
  const terms = item.keyTerms || [];
  $("r-terms-wrap").classList.toggle("hidden", terms.length === 0);
  for (const t of terms) {
    const dt = document.createElement("dt"); dt.textContent = t.term;
    const dd = document.createElement("dd"); dd.textContent = t.note;
    dl.append(dt, dd);
  }

  $("delete-btn").classList.toggle("hidden", !archive.some((it) => archiveKey(it) === archiveKey(item)));
  renderList();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderTranscript(item) {
  const el = $("r-transcript");
  el.innerHTML = "";
  const showOrig = $("show-original").checked;
  const hasVideo = !!item.videoId;
  for (const p of item.transcript || []) {
    const div = document.createElement("div");
    div.className = "tr-para";
    div.dataset.sec = p.seconds || 0;
    div.id = "t-" + (p.seconds || 0);
    if (p.timestamp || p.seconds || p.speaker) {
      const head = document.createElement("div");
      head.className = "tr-time";
      if (p.timestamp || p.seconds) {
        const btn = document.createElement("button");
        btn.className = "ts";
        btn.textContent = p.timestamp || fmtTime(p.seconds);
        btn.onclick = () => hasVideo && seekTo(p.seconds);
        if (!hasVideo) btn.style.cursor = "default";
        head.appendChild(btn);
      }
      if (p.speaker) {
        const sp = document.createElement("span");
        sp.className = "tr-speaker";
        sp.textContent = p.speaker;
        head.appendChild(sp);
      }
      div.appendChild(head);
    }
    const ko = document.createElement("p");
    ko.className = "tr-ko";
    ko.textContent = p.korean || "";
    div.appendChild(ko);
    if (showOrig && p.original) {
      const orig = document.createElement("p");
      orig.className = "tr-orig";
      orig.textContent = p.original;
      div.appendChild(orig);
    }
    el.appendChild(div);
  }
}

function fillList(id, arr) {
  const el = $(id);
  el.innerHTML = "";
  for (const x of arr) {
    const li = document.createElement("li");
    li.textContent = x;
    el.appendChild(li);
  }
}

// ── 요청 ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(endpoint, payload) {
  setStatus("시작하는 중…", true);
  $("run-btn").disabled = true;
  $("paste-run").disabled = true;
  try {
    // 1) 작업 시작 → jobId 즉시 수신
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const start = await res.json();
    if (!res.ok || start.error) throw new Error(start.error || "시작 실패");
    // 2) 진행 상황 폴링 (각 요청은 짧아 타임아웃에 안 걸림)
    const data = await pollJob(start.jobId);
    finishRun(data);
  } catch (e) {
    setStatus("⚠️ " + e.message, false);
  } finally {
    $("run-btn").disabled = false;
    $("paste-run").disabled = false;
  }
}

async function pollJob(jobId) {
  let misses = 0;
  while (true) {
    await sleep(2000);
    let res;
    try {
      res = await fetch("/api/job/" + jobId, { cache: "no-store" });
    } catch {
      if (++misses > 20) throw new Error("네트워크가 불안정합니다. 다시 시도해 주세요.");
      continue; // 일시적 네트워크 — 계속 폴링
    }
    misses = 0;
    if (res.status === 404) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || "작업을 찾을 수 없습니다. 다시 시도해 주세요.");
    }
    const j = await res.json();
    if (j.status === "running") {
      setStatus("⏳ " + (j.progress || "처리 중…"), true);
      continue;
    }
    if (j.status === "error") throw new Error(j.error || "처리 실패");
    if (j.status === "done") return j.result;
  }
}

function finishRun(data) {
  upsertArchive(data);
  show(data);
  setStatus("완료 · 보관함에 저장됨", false);
}
function setStatus(msg, busy) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("busy", !!busy);
}

// ── 서랍 ────────────────────────────────────────────────────────────────
function openDrawer() { $("drawer").classList.add("open"); $("scrim").classList.remove("hidden"); }
function closeDrawer() { $("drawer").classList.remove("open"); $("scrim").classList.add("hidden"); }

// ── 이벤트 ──────────────────────────────────────────────────────────────
$("url-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("url").value.trim();
  if (!url) return setStatus("⚠️ 링크를 입력해주세요.", false);
  run("/api/digest", { url });
});
$("menu-btn").onclick = openDrawer;
$("drawer-close").onclick = closeDrawer;
$("scrim").onclick = closeDrawer;
$("toggle-paste").onclick = () => $("paste-box").classList.toggle("hidden");
$("paste-run").onclick = () => {
  const text = $("paste-text").value.trim();
  if (text.length < 100) return setStatus("⚠️ 자막 텍스트가 너무 짧습니다.", false);
  run("/api/digest-text", {
    text,
    title: $("paste-title").value.trim(),
    url: $("paste-url").value.trim(),
  });
};
$("search").addEventListener("input", renderList);
$("show-original").addEventListener("change", () => current && renderTranscript(current));
$("delete-btn").onclick = () => {
  if (!current) return;
  archive = archive.filter((it) => archiveKey(it) !== archiveKey(current));
  saveArchive();
  renderList();
  $("result").classList.add("hidden");
  $("empty-state").classList.remove("hidden");
  current = null;
};

// ── 초기화 ──────────────────────────────────────────────────────────────
fetch("/api/health")
  .then((r) => r.json())
  .then((h) => {
    if (!h.anthropic) {
      const w = $("key-warning");
      w.textContent = "⚠️ 서버에 ANTHROPIC_API_KEY 가 설정되지 않았습니다. .env 를 확인하세요.";
      w.classList.remove("hidden");
    }
  })
  .catch(() => {});

renderList();
