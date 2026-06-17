// 유튜브 트랜스크립트 · 구조 증류 리더 — 프론트엔드.
// 링크/붙여넣기 → 서버 증류 → 화면 렌더 + 보관함(localStorage).
// 챕터 타임스탬프 클릭 시 임베드 플레이어를 해당 시점으로 점프.

const $ = (id) => document.getElementById(id);
const STORE_KEY = "yt-distill-archive";

let archive = loadArchive();
let current = null; // 현재 표시 중인 결과
let ytPlayer = null;
let ytReady = false;
let pendingSeek = null;

// ── YouTube IFrame API ─────────────────────────────────────────────────
(function loadYT() {
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
})();
window.onYouTubeIframeAPIReady = () => {
  ytReady = true;
};

function mountPlayer(videoId) {
  $("player-wrap").classList.remove("hidden");
  const make = () => {
    ytPlayer = new YT.Player("player", {
      videoId,
      playerVars: { rel: 0 },
    });
  };
  if (ytReady && window.YT && YT.Player) {
    // 기존 플레이어 제거 후 재생성
    $("player").innerHTML = "";
    make();
  } else {
    const wait = setInterval(() => {
      if (ytReady && window.YT && YT.Player) {
        clearInterval(wait);
        make();
      }
    }, 150);
  }
}

function seekTo(seconds) {
  if (ytPlayer && ytPlayer.seekTo) {
    ytPlayer.seekTo(seconds, true);
    ytPlayer.playVideo?.();
    $("player-wrap").scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

// ── 보관함 ──────────────────────────────────────────────────────────────
function loadArchive() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveArchive() {
  localStorage.setItem(STORE_KEY, JSON.stringify(archive));
}
function archiveKey(item) {
  return item.videoId || item.url || item.originalTitle || item.koreanTitle;
}

function renderList() {
  const q = $("search").value.trim().toLowerCase();
  const list = $("list");
  list.innerHTML = "";
  const items = archive.filter((it) => {
    if (!q) return true;
    return (
      (it.koreanTitle || "").toLowerCase().includes(q) ||
      (it.originalTitle || "").toLowerCase().includes(q) ||
      (it.channel || "").toLowerCase().includes(q) ||
      (it.oneLiner || "").toLowerCase().includes(q)
    );
  });
  $("empty-list").classList.toggle("hidden", items.length > 0);
  for (const it of items) {
    const li = document.createElement("li");
    li.className = "list-item";
    li.innerHTML = `<strong>${esc(it.koreanTitle || it.originalTitle || "(제목 없음)")}</strong>
      <span class="muted small">${esc(it.channel || "")}</span>`;
    li.onclick = () => show(it);
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

// ── 렌더링 ──────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function show(item) {
  current = item;
  $("result").classList.remove("hidden");

  $("r-source").textContent =
    { caption: "자막", "auto-caption": "자동 자막", paste: "붙여넣기" }[item.via] || item.via || "";
  $("r-title").textContent = item.koreanTitle || item.originalTitle || "(제목 없음)";
  $("r-original").textContent = item.originalTitle || "";
  $("r-meta").textContent = [item.channel, item.publishedDate, item.sourceLang && `원어: ${item.sourceLang}`]
    .filter(Boolean)
    .join(" · ");

  // 플레이어
  if (item.videoId) {
    mountPlayer(item.videoId);
    $("r-link").href = `https://www.youtube.com/watch?v=${item.videoId}`;
    $("r-link").classList.remove("hidden");
  } else {
    $("player-wrap").classList.add("hidden");
    if (item.url) {
      $("r-link").href = item.url;
      $("r-link").classList.remove("hidden");
    } else {
      $("r-link").classList.add("hidden");
    }
  }

  $("r-oneliner").textContent = item.oneLiner || "";
  $("r-topic").textContent = item.topic || "";

  fillList("r-takeaways", item.keyTakeaways || []);

  // 마케터 관점
  const rel = item.marketerAngle?.relevance || "none";
  const relLabel = { high: "연관 높음", medium: "연관 보통", low: "연관 낮음", none: "연관 없음" }[rel];
  const relEl = $("r-relevance");
  relEl.textContent = relLabel;
  relEl.className = `relevance rel-${rel}`;
  const notes = item.marketerAngle?.notes || [];
  fillList("r-angle", notes);
  $("r-angle-none").classList.toggle("hidden", notes.length > 0);

  // 챕터(구조 요약)
  const chEl = $("r-chapters");
  chEl.innerHTML = "";
  for (const ch of item.chapters || []) {
    const li = document.createElement("li");
    li.className = "chapter";
    const ts = document.createElement("button");
    ts.className = "ts" + (item.videoId ? "" : " ts-static");
    ts.textContent = ch.timestamp || fmtTime(ch.seconds);
    if (item.videoId) ts.onclick = () => seekTo(ch.seconds);
    const body = document.createElement("div");
    body.innerHTML = `<strong>${esc(ch.heading)}</strong><div class="muted small">${esc(ch.summary)}</div>`;
    li.append(ts, body);
    chEl.appendChild(li);
  }

  renderTranscript(item);

  // 핵심 용어
  const dl = $("r-terms");
  dl.innerHTML = "";
  const terms = item.keyTerms || [];
  $("r-terms-wrap").classList.toggle("hidden", terms.length === 0);
  for (const t of terms) {
    const dt = document.createElement("dt");
    dt.textContent = t.term;
    const dd = document.createElement("dd");
    dd.textContent = t.note;
    dl.append(dt, dd);
  }

  $("delete-btn").classList.toggle("hidden", !archive.some((it) => archiveKey(it) === archiveKey(item)));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderTranscript(item) {
  const el = $("r-transcript");
  el.innerHTML = "";
  const showOrig = $("show-original").checked;
  for (const p of item.transcript || []) {
    const div = document.createElement("div");
    div.className = "tr-para";
    const head = document.createElement("div");
    head.className = "tr-time";
    if (p.timestamp || p.seconds) {
      const btn = document.createElement("button");
      btn.className = "ts" + (item.videoId ? "" : " ts-static");
      btn.textContent = p.timestamp || fmtTime(p.seconds);
      if (item.videoId) btn.onclick = () => seekTo(p.seconds);
      head.appendChild(btn);
    }
    const ko = document.createElement("p");
    ko.className = "tr-ko";
    ko.textContent = p.korean || "";
    div.append(head, ko);
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
async function run(endpoint, payload) {
  setStatus("증류 중… 영상이 길면 1~2분 걸릴 수 있어요.", true);
  $("run-btn").disabled = true;
  $("paste-run").disabled = true;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "처리 실패");
    upsertArchive(data);
    show(data);
    setStatus("완료 · 보관함에 저장됨", false);
  } catch (e) {
    setStatus("⚠️ " + e.message, false);
  } finally {
    $("run-btn").disabled = false;
    $("paste-run").disabled = false;
  }
}

function setStatus(msg, busy) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("busy", !!busy);
}

// ── 이벤트 ──────────────────────────────────────────────────────────────
$("run-btn").onclick = () => {
  const url = $("url").value.trim();
  if (!url) return setStatus("⚠️ 링크를 입력해주세요.", false);
  run("/api/digest", { url });
};
$("url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("run-btn").click();
});
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
