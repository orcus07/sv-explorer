// 유튜브 트랜스크립트 · 구조 증류 리더 — 프론트엔드.
// 링크/붙여넣기 → 서버 증류 → 화면 렌더 + 보관함(IndexedDB, 설정값은 localStorage).
// 타임스탬프 클릭 → sticky 임베드 플레이어 점프 + 해당 트랜스크립트 위치로 스크롤.

const $ = (id) => document.getElementById(id);
const STORE_KEY = "yt-distill-archive";

// 긴 영상은 사용자가 직접 과금되므로 증류 전에 대략 비용을 알리고 확인받는다(개략치).
const COST_CONFIRM_CHARS = 45000; // 대략 30~40분+ 영상
function estimateCostUSD(chars) {
  const tin = chars / 3; // 대략 입력 토큰 수(EN/KO 혼합 평균)
  const haiku = (tin * 1 + tin * 1.3 * 5) / 1e6;         // 트랜스크립트(Haiku $1/$5, 출력≈입력×1.3)
  const sonnet = (Math.min(chars, 40000) / 3 * 2 + 4000 * 10) / 1e6; // 구조요약(Sonnet 인트로 $2/$10)
  const mid = haiku + sonnet;
  return { lo: (mid * 0.7).toFixed(2), hi: (mid * 1.5).toFixed(2) };
}

let archive = []; // loadArchive()가 비동기(IndexedDB)라 초기화에서 채운다
let current = null;
let ytPlayer = null;
let ytReady = false;
let speakerFilter = null; // 화자 필터(null=전체)

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
  expandSection("transcript-block"); // 기본 접힘이므로 먼저 펼친다
  const paras = [...document.querySelectorAll("#r-transcript .tr-para[data-sec]:not(.tr-hide)")];
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

// ── 섹션 접기/펼치기 (트랜스크립트만 기본 접힘, 상태는 브라우저 기억) ──────────
const COLLAPSE_STORE = "yt-distill-collapsed";
const SECTION_LABELS = {
  "topic-block": "이 영상은?",
  "takeaways-block": "💡 시사점",
  "angle-block": "📌 마케터",
  "chapters-block": "🧭 구조",
  "quotes-block": "💬 인용",
  "transcript-block": "📝 트랜스크립트",
  "r-terms-wrap": "🔑 용어",
  "followup-block": "💬 2차 명령",
};
const SECTION_ORDER = Object.keys(SECTION_LABELS);
function getCollapseMap() { try { return JSON.parse(localStorage.getItem(COLLAPSE_STORE) || "{}"); } catch { return {}; } }
function setCollapsed(id, val) { const m = getCollapseMap(); m[id] = val; localStorage.setItem(COLLAPSE_STORE, JSON.stringify(m)); }
function defaultCollapsed(id) { return id === "transcript-block"; } // 제일 길어서 기본 접힘
function isCollapsed(id) { const m = getCollapseMap(); return id in m ? m[id] : defaultCollapsed(id); }

function paintChev(sec, collapsed) {
  const chev = sec.querySelector("h3 .chev");
  if (chev) chev.textContent = collapsed ? "▸" : "▾";
}
function setupCollapsibles() {
  for (const id of SECTION_ORDER) {
    const sec = $(id);
    if (!sec) continue;
    const h = sec.querySelector("h3");
    if (!h) continue;
    if (!h.dataset.collapsible) {
      h.dataset.collapsible = "1";
      h.classList.add("block-toggle");
      const chev = document.createElement("span");
      chev.className = "chev";
      h.insertBefore(chev, h.firstChild);
      h.addEventListener("click", (e) => {
        if (e.target.closest("input,label,a")) return; // 헤더 내 컨트롤은 접기와 구분
        const collapsed = !sec.classList.contains("collapsed");
        sec.classList.toggle("collapsed", collapsed);
        setCollapsed(id, collapsed);
        paintChev(sec, collapsed);
        renderMiniTocState();
      });
    }
    const collapsed = isCollapsed(id);
    sec.classList.toggle("collapsed", collapsed);
    paintChev(sec, collapsed);
  }
}
function expandSection(id) {
  const sec = $(id);
  if (!sec || !sec.classList.contains("collapsed")) return;
  sec.classList.remove("collapsed");
  setCollapsed(id, false);
  paintChev(sec, false);
  renderMiniTocState();
}

// ── 떠 있는 미니 목차(TOC) + 모두 접기/펼치기 ─────────────────────────────
function visibleSections() {
  return SECTION_ORDER.filter((id) => { const s = $(id); return s && !s.classList.contains("hidden"); });
}
function renderMiniToc() {
  const nav = $("mini-toc");
  nav.innerHTML = "";
  for (const id of visibleSections()) {
    const chip = document.createElement("button");
    chip.className = "toc-chip";
    chip.dataset.for = id;
    chip.textContent = SECTION_LABELS[id];
    chip.onclick = () => { expandSection(id); $(id).scrollIntoView({ behavior: "smooth", block: "start" }); };
    nav.appendChild(chip);
  }
  const master = document.createElement("button");
  master.className = "toc-chip toc-master";
  master.id = "toc-master";
  master.onclick = () => {
    const collapseAll = visibleSections().some((id) => !$(id).classList.contains("collapsed"));
    for (const id of visibleSections()) {
      $(id).classList.toggle("collapsed", collapseAll);
      setCollapsed(id, collapseAll);
      paintChev($(id), collapseAll);
    }
    renderMiniTocState();
  };
  nav.appendChild(master);
  renderMiniTocState();
}
function renderMiniTocState() {
  const anyOpen = visibleSections().some((id) => !$(id).classList.contains("collapsed"));
  const master = $("toc-master");
  if (master) master.textContent = anyOpen ? "⤢ 모두 접기" : "⤢ 모두 펼치기";
  for (const chip of document.querySelectorAll("#mini-toc .toc-chip[data-for]")) {
    const sec = $(chip.dataset.for);
    chip.classList.toggle("dim", sec && sec.classList.contains("collapsed"));
  }
}

// ── 트랜스크립트 내 검색(현재 영상 한정) — 문단 필터 + 하이라이트 ────────────
function applyTranscriptSearch() {
  const q = ($("transcript-search").value || "").trim().toLowerCase();
  for (const p of document.querySelectorAll("#r-transcript .tr-para")) {
    const hit = !q || p.textContent.toLowerCase().includes(q);
    p.classList.toggle("tr-hide", !hit);
    p.classList.toggle("tr-hit", !!q && hit);
  }
}

// ── 트랜스크립트 문단 → 속한 챕터로 되돌아가기(양방향 링크) ──────────────────
function chapterIndexForSeconds(item, sec) {
  const chs = item.chapters || [];
  let idx = -1;
  for (let i = 0; i < chs.length; i++) {
    if ((chs[i].seconds || 0) <= sec + 0.5) idx = i; else break;
  }
  return idx;
}
function jumpToChapter(item, sec) {
  const i = chapterIndexForSeconds(item, sec);
  if (i < 0) return;
  expandSection("chapters-block");
  const li = document.getElementById("ch-" + i);
  if (!li) return;
  li.scrollIntoView({ behavior: "smooth", block: "center" });
  li.classList.add("flash");
  setTimeout(() => li.classList.remove("flash"), 1200);
}

// ── 자막 캡쳐 (트랜스크립트 원문 클릭 → 그 시점 프레임 + 한/영 자막을 사진처럼) ──
// 임베드 iframe은 캡쳐 불가(cross-origin)라, 유튜브 "스토리보드"(미리보기 프레임 스프라이트)를
// 서버 프록시로 받아 해당 시점 타일을 잘라 캔버스에 그리고 한/영 자막을 구워 넣는다.
// 스토리보드가 없으면(짧은 영상·라이브·붙여넣기) 썸네일 자막 카드로 폴백한다.
const sbCache = new Map(); // videoId → /api/storyboard 응답(캐시)
let _capBlob = null;       // 현재 캡쳐 PNG(다운로드/복사용)

function proxyImg(ytUrl) {
  const t = getAppToken(); // <img> 는 헤더를 못 붙이므로 토큰은 쿼리로
  return "/api/sb-image?u=" + encodeURIComponent(ytUrl) + (t ? "&token=" + encodeURIComponent(t) : "");
}

async function getStoryboardFor(videoId) {
  if (!videoId) return { ok: false, reason: "no_video" };
  if (sbCache.has(videoId)) return sbCache.get(videoId);
  try {
    const r = await fetch("/api/storyboard?v=" + encodeURIComponent(videoId), { headers: appTokenHeaders() });
    const j = await r.json();
    sbCache.set(videoId, j);
    return j;
  } catch {
    const f = { ok: false, reason: "fetch_error" };
    sbCache.set(videoId, f);
    return f;
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("이미지 로드 실패"));
    img.src = src;
  });
}

/** 스토리보드 정보 + 시점(초) → { img, sx, sy, sw, sh } (그릴 타일). 실패 시 null. */
async function storyboardTile(sb, sec) {
  if (!sb || !sb.ok || !Array.isArray(sb.sheets) || !sb.sheets.length) return null;
  const per = sb.cols * sb.rows;
  const total = sb.count > 0 ? sb.count : per * sb.sheets.length;
  let idx;
  if (sb.intervalMs > 0) idx = Math.floor((sec * 1000) / sb.intervalMs);
  else if (sb.duration > 0) idx = Math.floor((sec / sb.duration) * total);
  else idx = 0;
  idx = Math.max(0, Math.min(total - 1, idx));
  const sheet = Math.min(sb.sheets.length - 1, Math.floor(idx / per));
  const within = idx % per;
  const row = Math.floor(within / sb.cols);
  const col = within % sb.cols;
  const img = await loadImage(proxyImg(sb.sheets[sheet]));
  return { img, sx: col * sb.tileW, sy: row * sb.tileH, sw: sb.tileW, sh: sb.tileH };
}

function wrapLines(ctx, text, maxW) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; }
    else cur = t;
  }
  if (cur) lines.push(cur);
  // CJK 등 공백 없는 긴 한 덩어리는 글자 단위로 강제 줄바꿈
  const out = [];
  for (const ln of lines) {
    if (ctx.measureText(ln).width <= maxW) { out.push(ln); continue; }
    let seg = "";
    for (const ch of ln) {
      if (ctx.measureText(seg + ch).width > maxW && seg) { out.push(seg); seg = ch; }
      else seg += ch;
    }
    if (seg) out.push(seg);
  }
  return out.length ? out : [""];
}

/** 자막 밴드(검은 배경 강조) 한 줄 묶음을 그린다. y는 밴드 상단, 반환은 다음 y. */
function drawCaption(ctx, lines, y, W, opt) {
  const { font, pad = 10, lh, bg = "rgba(0,0,0,0.78)", color = "#fff", weight = "700" } = opt;
  ctx.font = `${weight} ${font}px "Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  for (const ln of lines) {
    const w = ctx.measureText(ln).width;
    const boxW = Math.min(W - 24, w + pad * 2);
    const boxH = lh;
    ctx.fillStyle = bg;
    ctx.fillRect((W - boxW) / 2, y, boxW, boxH);
    ctx.fillStyle = color;
    ctx.fillText(ln, W / 2, y + boxH / 2);
    y += boxH + 4;
  }
  return y;
}

async function drawCaptureCanvas(item, para) {
  const canvas = $("cap-canvas");
  const ctx = canvas.getContext("2d");
  const sec = para.seconds || 0;
  const korean = (para.korean && para.korean.trim() && para.korean !== para.original) ? para.korean.trim() : "";
  const orig = (para.original || "").trim();
  // 한국어 원본 영상이면 original이 한국어 본문 → 그것만. 아니면 한글(위)·원문(아래).
  const koLine = korean || orig;
  const enLine = korean ? orig : "";

  const W = 720;
  let tile = null;
  let noteKind = "";
  try {
    const sb = await getStoryboardFor(item.videoId);
    tile = await storyboardTile(sb, sec);
    if (tile) noteKind = "frame";
  } catch { /* 폴백으로 진행 */ }

  // 프레임(또는 폴백 썸네일/다크) 그리기 영역 계산
  let frameImg = null, fsx = 0, fsy = 0, fsw = 0, fsh = 0, aspect = 16 / 9;
  if (tile) {
    frameImg = tile.img; fsx = tile.sx; fsy = tile.sy; fsw = tile.sw; fsh = tile.sh;
    aspect = fsw / fsh || 16 / 9;
  } else if (item.videoId) {
    try {
      frameImg = await loadImage(proxyImg(`https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`));
      // hqdefault(480x360)은 좌우 검은 여백 포함 → 중앙 480x270만 사용
      fsx = 0; fsy = 45; fsw = 480; fsh = 270; aspect = 16 / 9;
      noteKind = "thumb";
    } catch { noteKind = "dark"; }
  } else {
    noteKind = "dark";
  }

  const frameH = Math.round(W / aspect);
  // 자막 높이 선계산
  const tmp = canvas.getContext("2d");
  const koFont = 30, enFont = 22, koLh = 44, enLh = 34;
  tmp.font = `700 ${koFont}px sans-serif`;
  const koLines = wrapLines(tmp, koLine, W - 48);
  tmp.font = `400 ${enFont}px sans-serif`;
  const enLines = enLine ? wrapLines(tmp, enLine, W - 48) : [];
  const capH = 18 + koLines.length * (koLh + 4) + (enLines.length ? 10 + enLines.length * (enLh + 4) : 0) + 12;

  canvas.width = W;
  canvas.height = frameH + capH;

  // 배경 프레임
  if (frameImg) ctx.drawImage(frameImg, fsx, fsy, fsw, fsh, 0, 0, W, frameH);
  else { ctx.fillStyle = "#15181f"; ctx.fillRect(0, 0, W, frameH); }
  // 자막 밴드가 얹힐 하단을 살짝 어둡게
  const grad = ctx.createLinearGradient(0, frameH * 0.55, 0, frameH);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, Math.round(frameH * 0.55), W, frameH - Math.round(frameH * 0.55));

  // 자막 영역(프레임 아래, 검은 바탕)
  ctx.fillStyle = "#0b0d12";
  ctx.fillRect(0, frameH, W, capH);
  let y = frameH + 18;
  y = drawCaption(ctx, koLines, y, W, { font: koFont, lh: koLh, weight: "700", bg: "rgba(0,0,0,0.9)" });
  if (enLines.length) {
    y += 10;
    drawCaption(ctx, enLines, y, W, { font: enFont, lh: enLh, weight: "400", bg: "rgba(255,255,255,0.12)", color: "#e8eaf0" });
  }
  // 시간 배지
  ctx.font = `700 16px sans-serif`;
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  const tlabel = para.timestamp || fmtTime(sec);
  const tw = ctx.measureText(tlabel).width + 16;
  ctx.fillRect(12, 12, tw, 26);
  ctx.fillStyle = "#fff";
  ctx.fillText(tlabel, 20, 18);

  // 다운로드/복사용 blob
  _capBlob = await new Promise((res) => canvas.toBlob(res, "image/png"));

  const note = $("cap-note");
  if (noteKind === "frame") note.textContent = "유튜브 미리보기 프레임(스토리보드) 기반 — 화질은 낮지만 그 시점의 실제 화면이에요.";
  else if (noteKind === "thumb") note.textContent = "이 영상은 시점별 프레임을 못 가져와 대표 썸네일 위에 자막을 얹었어요(그 순간 화면은 아님).";
  else note.textContent = "영상 프레임을 가져오지 못해 자막만 카드로 만들었어요.";
}

async function openCapture(item, para) {
  _capBlob = null;
  const modal = $("cap-modal");
  modal.classList.remove("hidden");
  const canvas = $("cap-canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = 720; canvas.height = 240;
  ctx.fillStyle = "#15181f"; ctx.fillRect(0, 0, 720, 240);
  ctx.fillStyle = "#9aa0ab"; ctx.font = "500 18px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("⏳ 그 시점 프레임을 가져오는 중…", 360, 120);
  $("cap-note").textContent = "";
  // 그 시점 영상 열기 버튼 배선
  const sec = para.seconds || 0;
  $("cap-open").onclick = () => {
    if (ytPlayer && item.videoId) { seekTo(sec); }
    else if (item.videoId) { window.open(`https://www.youtube.com/watch?v=${item.videoId}&t=${Math.floor(sec)}s`, "_blank", "noopener"); }
  };
  try {
    await drawCaptureCanvas(item, para);
  } catch (e) {
    $("cap-note").textContent = "⚠️ 캡쳐를 만들지 못했어요: " + (e.message || e);
  }
}

function closeCapture() { $("cap-modal").classList.add("hidden"); _capBlob = null; }

function capFileName() {
  const t = (current && (current.koreanTitle || current.originalTitle)) || "capture";
  return t.replace(/[^\w가-힣ぁ-ヿ㐀-鿿 -]/g, "").trim().slice(0, 40).replace(/\s+/g, "_") || "capture";
}
async function downloadCapture() {
  if (!_capBlob) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(_capBlob);
  a.download = capFileName() + ".png";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function copyCapture() {
  if (!_capBlob) return;
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": _capBlob })]);
    $("cap-note").textContent = "✅ 이미지를 클립보드에 복사했어요. 붙여넣기(Ctrl/Cmd+V) 하세요.";
  } catch {
    $("cap-note").textContent = "⚠️ 이 브라우저는 이미지 복사를 지원하지 않아요 — 다운로드를 이용하세요.";
  }
}

// ── 보관함 저장 (IndexedDB — localStorage 5MB 한도·쓰기 증폭 해소) ──────────
// in-memory `archive` 배열이 진실의 원천(동기 읽기 유지). 영속화만 IndexedDB로 옮긴다.
// 기존 localStorage 보관함은 첫 로드 때 자동 이관. IDB 불가 브라우저는 localStorage 폴백.
const DB_NAME = "yt-distill", DB_STORE = "items";
let _db = null;
let _useIDB = true; // IDB 열기 실패(구형·프라이빗 모드) 시 false → localStorage 폴백

function archiveKey(it) { return it.videoId || it.url || it.originalTitle || it.koreanTitle; }
function keyFor(it) { return archiveKey(it) || ("ord-" + (it._ord || 0)); } // IDB 키(빈 키 방지)

function openDB() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("no-indexeddb"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("idb open failed"));
  });
}
function idbGetAll() {
  return new Promise((resolve, reject) => {
    const r = _db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}
function idbPut(item) {
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(item, keyFor(item));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function idbDelete(key) {
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function idbBulk(items) {
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(DB_STORE, "readwrite");
    const s = tx.objectStore(DB_STORE);
    s.clear();
    for (const it of items) s.put(it, keyFor(it));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function readLegacyArchive() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); } catch { return []; }
}
function legacySaveAll() { localStorage.setItem(STORE_KEY, JSON.stringify(archive)); }

async function loadArchive() {
  try {
    _db = await openDB();
    _useIDB = true;
    let items = await idbGetAll();
    if (!items.length) {
      // 최초 1회: 기존 localStorage 보관함을 IDB로 이관하고 원본 키는 비워 공간을 확보한다.
      const legacy = readLegacyArchive();
      if (legacy.length) {
        legacy.forEach((it, i) => { if (it._ord == null) it._ord = legacy.length - i; });
        await idbBulk(legacy);
        try { localStorage.removeItem(STORE_KEY); } catch {}
        items = legacy;
      }
    }
    items.sort((a, b) => (b._ord || 0) - (a._ord || 0)); // 최신(높은 _ord)이 앞
    return items;
  } catch (e) {
    _useIDB = false; // IDB 불가 → localStorage 폴백(기존 동작 유지)
    return readLegacyArchive();
  }
}

function warnStorageFull() {
  setStatus("⚠️ 저장에 실패했어요(저장공간 부족일 수 있음). '보관함 백업(내보내기)' 후 오래된 영상을 삭제해줘.", false);
  const note = $("storage-note");
  if (note) { note.textContent = "⚠️ 저장 실패 — 백업 후 정리 필요"; note.style.color = "var(--accent)"; }
}
// 단일 항목 저장(핫패스: 새 증류·챕터 상세·2차 명령) — 전체 재직렬화 없이 그 항목만 쓴다(쓰기 증폭 해소).
async function saveItem(item) {
  try { if (_useIDB) await idbPut(item); else legacySaveAll(); updateStorageNote(); }
  catch (e) { warnStorageFull(); }
}
async function removeItem(key) {
  try { if (_useIDB) await idbDelete(key); else legacySaveAll(); updateStorageNote(); }
  catch (e) { warnStorageFull(); }
}
// 전체 저장(가져오기 등 대량 변경 시). 기존 saveArchive 호출부 호환용 별칭.
async function saveArchive() {
  try { if (_useIDB) await idbBulk(archive); else legacySaveAll(); updateStorageNote(); }
  catch (e) { warnStorageFull(); }
}

// ── 보관함 백업(내보내기/가져오기) + 저장공간 표시 ────────────────────────
function bytesFmt(n) {
  return n < 1024 ? n + "B" : n < 1048576 ? (n / 1024).toFixed(0) + "KB" : (n / 1048576).toFixed(1) + "MB";
}
async function updateStorageNote() {
  const note = $("storage-note");
  if (!note) return;
  let extra = "";
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est && est.usage != null) extra = ` · 약 ${bytesFmt(est.usage)} 사용`;
    }
  } catch {}
  note.style.color = "";
  note.textContent = `보관함 ${archive.length}개${extra}` + (_useIDB ? "" : " (localStorage 폴백)");
}
function exportArchive() {
  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `yt-distill-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  setStatus(`✅ 보관함 ${archive.length}개를 백업 파일로 내려받았어요.`, false);
}
function importArchive(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data)) throw new Error("형식이 올바르지 않아요(영상 배열이 아님).");
      const map = new Map(archive.map((it) => [archiveKey(it), it]));
      let added = 0;
      for (const it of data) {
        if (!it || typeof it !== "object") continue;
        const k = archiveKey(it);
        if (!map.has(k)) added++;
        map.set(k, it); // 중복 key는 가져온 것으로 갱신
      }
      archive = [...map.values()];
      const base = Date.now();
      archive.forEach((it, i) => { it._ord = base - i; }); // 현재 배열 순서를 재로드 후에도 유지
      saveArchive();
      renderList();
      setStatus(`✅ 가져오기 완료 — 새로 ${added}개 추가(중복은 갱신).`, false);
    } catch (e) {
      setStatus("⚠️ 가져오기 실패: " + e.message, false);
    }
  };
  reader.readAsText(file);
}

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
  item._ord = Date.now(); // 최신 → 맨 앞(재로드 후에도 유지)
  archive.unshift(item);
  saveItem(item); // 그 항목만 저장(전체 재직렬화 없음)
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
  $("transcript-search").value = ""; // 새 영상 → 이전 검색어 초기화(트랜스크립트 렌더 전에)
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

  // 구조 요약(챕터) — 각 챕터에 "🔍 자세히"(2차 상세) 버튼 포함
  renderChapters(item);
  renderQuotes(item);

  speakerFilter = null; // 새 영상 표시 때 화자 필터 초기화
  renderSpeakerFilter(item);
  renderTranscript(item);
  renderFollowups(item);
  $("followup-input").value = "";

  // 빈 섹션 숨김 + 자막 미수집 안내
  const hasChapters = (item.chapters || []).length > 0;
  const hasTranscript = (item.transcript || []).length > 0;
  $("chapters-block").classList.toggle("hidden", !hasChapters);
  $("quotes-block").classList.toggle("hidden", (item.keyQuotes || []).length === 0);
  $("transcript-block").classList.toggle("hidden", !hasTranscript);
  $("followup-block").classList.toggle("hidden", !hasTranscript); // 근거(트랜스크립트)가 있어야 2차 명령 가능
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

  // 섹션 접기 상태 적용 + 미니 목차(빈 섹션 제외) — 위 hidden 토글 이후에 실행
  setupCollapsibles();
  renderMiniToc();

  renderList();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderTranscript(item) {
  const el = $("r-transcript");
  el.innerHTML = "";
  const showOrig = $("show-original").checked;
  const hasVideo = !!item.videoId;
  const hasChapters = (item.chapters || []).length > 0;
  for (const p of item.transcript || []) {
    if (speakerFilter && (p.speaker || "") !== speakerFilter) continue; // 화자 필터
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
      // 양방향 링크: 이 문단이 속한 챕터로 되돌아가기
      if (hasChapters) {
        const back = document.createElement("button");
        back.className = "tr-mini";
        back.textContent = "⤴ 챕터";
        back.title = "이 부분이 속한 구조 요약 챕터로";
        back.onclick = () => jumpToChapter(item, p.seconds || 0);
        head.appendChild(back);
      }
      // 자막 캡쳐: 그 시점 프레임 + 한/영 자막(사진처럼)
      const cap = document.createElement("button");
      cap.className = "tr-mini";
      cap.textContent = "📸 캡쳐";
      cap.title = "이 시점 화면 + 한/영 자막을 사진으로";
      cap.onclick = () => openCapture(item, p);
      head.appendChild(cap);
      div.appendChild(head);
    }
    // 원문이 한국어면 korean이 비어 있다 → original(한국어)을 본문으로 보여준다(중복 방지).
    const main = (p.korean && p.korean.trim()) ? p.korean : (p.original || "");
    const ko = document.createElement("p");
    ko.className = "tr-ko";
    ko.textContent = main;
    div.appendChild(ko);
    // 원문 병기: 번역이 따로 있어 본문과 다를 때만 원문을 덧붙인다(한국어 영상은 병기 없음).
    if (showOrig && p.original && p.original !== main) {
      const orig = document.createElement("p");
      orig.className = "tr-orig cap-trigger";
      orig.textContent = p.original;
      orig.title = "클릭 → 이 시점 자막 캡쳐";
      orig.onclick = () => openCapture(item, p);
      div.appendChild(orig);
    } else {
      // 한국어 원본 등 원문이 본문일 때 → 본문 클릭으로도 캡쳐(원문 클릭 요구 반영)
      ko.classList.add("cap-trigger");
      ko.title = "클릭 → 이 시점 자막 캡쳐";
      ko.onclick = () => openCapture(item, p);
    }
    el.appendChild(div);
  }
  applyTranscriptSearch(); // 렌더 후 현재 검색어 반영
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

/** 화자가 둘 이상이면 "전체 + 화자별" 칩을 띄워 특정 화자만 보게 한다. */
function renderSpeakerFilter(item) {
  const wrap = $("speaker-filter");
  wrap.innerHTML = "";
  const speakers = [];
  for (const p of item.transcript || []) {
    const s = (p.speaker || "").trim();
    if (s && !speakers.includes(s)) speakers.push(s);
  }
  if (speakers.length < 2) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");

  const hint = document.createElement("span");
  hint.className = "spk-hint";
  hint.textContent = "화자:";
  wrap.appendChild(hint);

  const mk = (label, val) => {
    const b = document.createElement("button");
    b.className = "spk-chip" + (speakerFilter === val ? " active" : "");
    b.textContent = label;
    b.onclick = () => { speakerFilter = val; renderSpeakerFilter(item); renderTranscript(item); };
    return b;
  };
  wrap.appendChild(mk("전체", null));
  for (const s of speakers) wrap.appendChild(mk(s, s));
}

// ── 2차 명령 (A: 챕터별 상세 / B: 자유 명령) ─────────────────────────────
// 둘 다 "이미 만든 트랜스크립트"를 근거로 Claude를 한 번 더 부른다(재추출 없음).
const DETAIL_INSTRUCTION =
  "이 구간을 더 상세하게 풀어줘. 핵심 논지와 근거, 등장한 숫자·사례·고유명사·인용을 빠짐없이 정리하고, " +
  "반도체 마케터(AI 동향) 관점에서 의미 있는 시사점이 있으면 덧붙여줘. 요약이 아니라 깊이 있는 해설로.";

/** 트랜스크립트에서 [startSec, endSec) 구간의 한글·원문 텍스트를 모아준다. endSec=null이면 끝까지. */
function buildSliceText(transcript, startSec, endSec) {
  return (transcript || [])
    .filter((p) => {
      const s = p.seconds || 0;
      return s >= startSec && (endSec == null || s < endSec);
    })
    .map((p) => {
      const t = p.timestamp || fmtTime(p.seconds || 0);
      const o = p.original || "";
      const k = p.korean || "";
      // 한국어 원문은 번역이 비어 있다 → "(번역)" 줄을 붙이지 않는다.
      const trans = (k && k !== o) ? `${o ? "\n" : ""}(번역) ${k}` : "";
      return `[${t}] ${o}${trans}`;
    })
    .join("\n\n");
}
function buildFullText(transcript) { return buildSliceText(transcript || [], 0, null); }

/** 아주 작은 마크다운 → HTML (소제목/불릿·번호목록/인용/구분선/굵게/코드).
 *  esc로 먼저 이스케이프한 뒤 우리 태그만 주입하므로 XSS 안전. */
function renderMarkdown(md) {
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  let html = "";
  let list = null; // "ul" | "ol" | null
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of String(md || "").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    let m;
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeList(); html += "<hr>"; continue; }
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) { closeList(); html += `<p class="md-h">${inline(m[1])}</p>`; continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { closeList(); html += `<p class="md-q">${inline(m[1])}</p>`; continue; }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (list !== "ol") { closeList(); html += "<ol>"; list = "ol"; }
      html += `<li>${inline(m[1])}</li>`; continue;
    }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; }
      html += `<li>${inline(m[1])}</li>`; continue;
    }
    closeList(); html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return html;
}

/** 요약을 "첫 문장(리드) + 나머지"로 나눈다 — 리드를 별도 문단으로 앞세워 훑어볼 때
 *  TL;DR이 먼저 들어오고, 부연은 뒤에 놓이게 한다.
 *  리드가 아주 길면(120자 초과) 나누는 의미가 없으므로 통짜 본문으로 둔다.
 *  마침표 뒤 공백을 요구해 소수점("1.5배")에서 잘못 끊기지 않게 한다. */
function splitLead(text) {
  const t = (text || "").trim();
  if (!t) return { lead: "", rest: "" };
  const m = t.match(/^([\s\S]{15,120}?[.!?])\s+([\s\S]+)$/);
  return m ? { lead: m[1], rest: m[2] } : { lead: t, rest: "" };
}

/** 구조 요약(챕터) 렌더 + 각 챕터의 "🔍 자세히"(2차 상세) 버튼. */
function renderChapters(item) {
  const chEl = $("r-chapters");
  chEl.innerHTML = "";
  const chapters = item.chapters || [];
  const hasVideo = !!item.videoId;
  // 타임스탬프가 있어야 구간 slice가 의미 있다(붙여넣기/프록시는 seconds=0뿐 → 버튼 숨김).
  const canDetail = (item.transcript || []).some((p) => (p.seconds || 0) > 0);
  item.chapterDetails = item.chapterDetails || {};

  chapters.forEach((ch, i) => {
    const li = document.createElement("li");
    li.className = "chapter";
    li.id = "ch-" + i; // 트랜스크립트 → 챕터 역방향 점프 대상
    // 헤더 줄: 타임스탬프 칩 + 제목. 요약은 그 아래 전체 폭으로 → 좁은 화면에서 칩 폭만큼
    // 들여쓰기되어 줄폭을 버리던 문제 해소(상세 박스와 같은 왼쪽 기준선).
    const head = document.createElement("div");
    head.className = "c-head";
    const ts = document.createElement("button");
    ts.className = "ts";
    ts.textContent = ch.timestamp || fmtTime(ch.seconds);
    ts.onclick = () => { if (hasVideo) seekTo(ch.seconds); scrollToTranscript(ch.seconds); };
    const title = document.createElement("strong");
    title.className = "c-title";
    title.textContent = ch.heading || "";
    head.append(ts, title);

    // 요약: 첫 문장을 리드 문단으로 앞세우고, 부연은 그 아래 별도 문단으로 — 요약 먼저, 상세 뒤.
    const { lead, rest } = splitLead(ch.summary || "");
    let leadEl = null, sum = null;
    if (lead) {
      leadEl = document.createElement("p");
      leadEl.className = "c-lead";
      leadEl.textContent = lead;
    }
    if (rest) {
      sum = document.createElement("p");
      sum.className = "c-sum";
      sum.textContent = rest;
    }

    // 상세는 요약 뒤에 전체 폭으로 — 요약(리드)이 먼저, 깊은 내용은 접힌 채 뒤에.
    const detail = canDetail ? document.createElement("div") : null;
    const btn = canDetail ? document.createElement("button") : null;
    if (canDetail) {
      const startSec = ch.seconds || 0;
      const endSec = i + 1 < chapters.length ? (chapters[i + 1].seconds || null) : null;
      detail.className = "chapter-detail md hidden";
      btn.className = "link-btn detail-btn";

      const paint = () => {
        const cached = item.chapterDetails[i];
        if (cached) {
          detail.innerHTML = renderMarkdown(cached);
          detail.classList.remove("hidden");
          btn.textContent = "🔼 접기";
        } else { detail.classList.add("hidden"); btn.textContent = "🔍 자세히"; }
      };
      btn.onclick = async () => {
        if (item.chapterDetails[i]) { // 이미 받아둠 → 토글
          detail.classList.toggle("hidden");
          btn.textContent = detail.classList.contains("hidden") ? "🔍 자세히" : "🔼 접기";
          return;
        }
        const apiKey = getApiKey();
        if (!apiKey) { openDrawer(); return setStatus("⚠️ 먼저 API 키를 넣어줘 (왼쪽 ☰)", false); }
        const src = buildSliceText(item.transcript, startSec, endSec);
        if (src.trim().length < 20) { detail.innerHTML = '<p class="muted">이 구간 원문이 비어 있어요.</p>'; detail.classList.remove("hidden"); return; }
        // 진행 상황을 클릭한 그 자리(펼친 박스 안)에 바로 표시 — 상단 status에 의존하지 않음.
        detail.innerHTML = '<p class="muted">⏳ 이 구간 상세 작성 중…</p>';
        detail.classList.remove("hidden");
        btn.disabled = true; btn.textContent = "⏳ 작성 중…";
        try {
          const ans = await YTDistill.followUp({
            instruction: DETAIL_INSTRUCTION, sourceText: src, scope: ch.heading,
            apiKey, context: getContext(),
          });
          item.chapterDetails[i] = ans;
          saveItem(item);
          paint();
        } catch (e) {
          detail.innerHTML = `<p class="muted">⚠️ ${esc(e.message)}<br>버튼을 다시 누르면 재시도해요.</p>`;
          btn.textContent = "🔁 다시 시도";
        } finally { btn.disabled = false; }
      };
      paint();
    }

    li.append(head);
    if (leadEl) li.append(leadEl);
    if (sum) li.append(sum);
    if (canDetail) li.append(btn);
    if (detail) li.append(detail);
    chEl.appendChild(li);
  });
}

/** 주요 인용(원문 그대로) — 타임스탬프 클릭 시 영상·본문 점프. */
function renderQuotes(item) {
  const el = $("r-quotes");
  el.innerHTML = "";
  const hasVideo = !!item.videoId;
  for (const q of item.keyQuotes || []) {
    const li = document.createElement("li");
    li.className = "quote";

    if (q.timestamp || q.seconds) {
      const ts = document.createElement("button");
      ts.className = "ts";
      ts.textContent = q.timestamp || fmtTime(q.seconds);
      ts.onclick = () => { if (hasVideo) seekTo(q.seconds || 0); scrollToTranscript(q.seconds || 0); };
      if (!hasVideo && !(item.transcript || []).length) ts.style.cursor = "default";
      li.appendChild(ts);
    }

    const body = document.createElement("blockquote");
    body.className = "q-body";
    const orig = document.createElement("p");
    orig.className = "q-orig";
    orig.textContent = q.original || "";
    body.append(orig);
    // 원문이 한국어면 korean이 비어 있다 → 같은 한국어를 또 보여주지 않는다.
    if (q.korean && q.korean.trim() && q.korean !== q.original) {
      const ko = document.createElement("p");
      ko.className = "q-ko";
      ko.textContent = q.korean;
      body.append(ko);
    }
    if (q.speaker) {
      const sp = document.createElement("span");
      sp.className = "q-speaker";
      sp.textContent = "— " + q.speaker;
      body.appendChild(sp);
    }
    li.appendChild(body);
    el.appendChild(li);
  }
}

/** B: 저장된 자유 2차 명령 답변들을 렌더. */
function renderFollowups(item) {
  const wrap = $("followup-answers");
  wrap.innerHTML = "";
  for (const f of item.followups || []) {
    const card = document.createElement("div");
    card.className = "followup-card";
    const q = document.createElement("div");
    q.className = "followup-q";
    q.textContent = "💬 " + f.q;
    const a = document.createElement("div");
    a.className = "followup-a md";
    a.innerHTML = renderMarkdown(f.a);
    const del = document.createElement("button");
    del.className = "link-btn";
    del.textContent = "삭제";
    del.onclick = () => {
      item.followups = (item.followups || []).filter((x) => x !== f);
      saveItem(item);
      renderFollowups(item);
    };
    card.append(q, a, del);
    wrap.appendChild(card);
  }
}

async function runFollowup() {
  if (!current) return;
  const input = $("followup-input");
  const instruction = input.value.trim();
  if (!instruction) return setStatus("⚠️ 요청 내용을 입력해줘.", false);
  const apiKey = getApiKey();
  if (!apiKey) { openDrawer(); return setStatus("⚠️ 먼저 API 키를 넣어줘 (왼쪽 ☰)", false); }
  const src = buildFullText(current.transcript);
  if (src.trim().length < 20) return setStatus("⚠️ 근거로 쓸 트랜스크립트가 없어요.", false);
  const btn = $("followup-run");
  btn.disabled = true;
  logReset("💬 2차 명령 로그");
  logPush("시작 — " + instruction);
  try {
    const ans = await YTDistill.followUp({
      instruction, sourceText: src, apiKey, context: getContext(),
      onProgress: (m) => logPush(m),
    });
    current.followups = current.followups || [];
    current.followups.unshift({ q: instruction, a: ans });
    saveItem(current);
    renderFollowups(current);
    input.value = "";
    logPush("완료 · 결과를 추가했어요", "done");
  } catch (e) {
    logPush("✗ 실패: " + e.message, "err");
  } finally { btn.disabled = false; }
}

// ── API 키 (브라우저에만 저장; 서버로 보내지 않음) ───────────────────────
const KEY_STORE = "yt-distill-anthropic-key";
function getApiKey() { return (localStorage.getItem(KEY_STORE) || "").trim(); }
function setApiKey(k) { localStorage.setItem(KEY_STORE, (k || "").trim()); refreshKeyUI(); }
function refreshKeyUI() {
  const has = !!getApiKey();
  const w = $("key-warning");
  if (w) {
    w.textContent = has ? "" :
      "⚠️ Anthropic API 키가 필요합니다. 왼쪽 ☰ 를 열어 키를 넣어주세요 (브라우저에만 저장돼요).";
    w.classList.toggle("hidden", has);
  }
  const f = $("api-key");
  if (f && document.activeElement !== f) f.value = getApiKey();
  const st = $("key-state");
  if (st) st.textContent = has ? "✅ 키 저장됨 (이 브라우저)" : "키가 아직 없습니다";
}

// ── 앱 접근 토큰 (선택; 서버가 APP_ACCESS_TOKEN 설정 시 서버 자막 수집에 필요) ──
const APP_TOKEN_STORE = "yt-distill-app-token";
function getAppToken() { return (localStorage.getItem(APP_TOKEN_STORE) || "").trim(); }
function setAppToken(t) { localStorage.setItem(APP_TOKEN_STORE, (t || "").trim()); refreshAppTokenUI(); }
function appTokenHeaders() { const t = getAppToken(); return t ? { "x-app-token": t } : {}; }
function refreshAppTokenUI() {
  const has = !!getAppToken();
  const f = $("app-token");
  if (f && document.activeElement !== f) f.value = getAppToken();
  const st = $("apptoken-state");
  if (st) st.textContent = has ? "✅ 토큰 저장됨 (이 브라우저)" : "토큰 없음";
}
// 서버가 토큰을 요구하면 입력칸을 노출한다(요구 안 하면 숨김 유지).
async function checkServerAuth() {
  try {
    const r = await fetch("/api/health");
    const j = await r.json();
    if (j && j.tokenRequired) $("apptoken-box").classList.remove("hidden");
  } catch { /* 서버 미응답 시 조용히 무시 */ }
}

// ── 맥락 주입 (브라우저에만 저장; 반도체 마케터 페르소나에 더해 관심사·배경을 주입) ──
const CONTEXT_STORE = "yt-distill-context";
function getContext() { return (localStorage.getItem(CONTEXT_STORE) || "").trim(); }
function setContext(c) { localStorage.setItem(CONTEXT_STORE, (c || "").trim()); refreshContextUI(); }
function refreshContextUI() {
  const has = !!getContext();
  const f = $("context-text");
  if (f && document.activeElement !== f) f.value = getContext();
  const st = $("context-state");
  if (st) st.textContent = has ? "✅ 맥락 저장됨 (다음 영상에도 적용)" : "맥락 없음 (기본 반도체 마케터 관점)";
  const btn = $("toggle-context");
  if (btn) btn.textContent = has ? "🎯 맥락 적용됨" : "🎯 맥락 추가";
}

// ── 내 프로필 자동 정의 (읽은 글 요약 → "나는 누구인가" → 관점에 반영) ──────
const PROFILE_LAST_STORE = "yt-distill-profile-last";       // 마지막 자동 생성값(수동편집 감지 기준)
const PROFILE_AUTO_STORE = "yt-distill-profile-autoupdate"; // 글 추가 시 자동 갱신 on/off
function getLastAutoProfile() { return localStorage.getItem(PROFILE_LAST_STORE) || ""; }
function setLastAutoProfile(v) { localStorage.setItem(PROFILE_LAST_STORE, v || ""); }
function getProfileAuto() { return localStorage.getItem(PROFILE_AUTO_STORE) === "1"; }
function setProfileAuto(b) { localStorage.setItem(PROFILE_AUTO_STORE, b ? "1" : "0"); refreshProfileUI(); }
function refreshProfileUI() { const t = $("profile-auto"); if (t) t.checked = getProfileAuto(); }

function archiveSummaries() {
  return archive.map((it) => ({
    title: it.koreanTitle || it.originalTitle || "",
    oneLiner: it.oneLiner || "",
    topic: it.topic || "",
  }));
}

// explicit=true: 사용자가 버튼을 직접 누름(현재 관점 덮어쓰기 OK)
// explicit=false: 자동 갱신 — 사용자가 손수 고친 관점이면 보존(덮어쓰지 않음)
async function defineProfileNow(explicit) {
  const apiKey = getApiKey();
  if (!apiKey) {
    if (explicit) { openDrawer(); setTimeout(() => $("api-key") && $("api-key").focus(), 250); setStatus("⚠️ 먼저 API 키를 넣어줘 (왼쪽 ☰)", false); }
    return;
  }
  const sums = archiveSummaries();
  if (!sums.length) { if (explicit) setStatus("⚠️ 먼저 영상을 1개 이상 정리해줘.", false); return; }
  if (!explicit) {
    const cur = getContext();
    if (cur && cur !== getLastAutoProfile()) return; // 수동 편집된 관점 → 보존
  }
  const btn = $("profile-define");
  if (btn) btn.disabled = true;
  setStatus("🧠 내 글들로 프로필 추론 중…", true);
  try {
    const profile = await YTDistill.defineProfile(sums, apiKey);
    setContext(profile);          // 관점(맥락)에 반영 + UI 갱신
    setLastAutoProfile(profile);  // 자동값 기록(이후 수동편집 감지 기준)
    setStatus("✅ 프로필을 관점에 반영했어요.", false);
  } catch (e) {
    setStatus("⚠️ " + e.message, false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── 요청: 서버는 자막만, Claude 호출은 브라우저가 직접 ────────────────────
async function run(kind, payload) {
  const apiKey = getApiKey();
  if (!apiKey) {
    openDrawer();
    setTimeout(() => $("api-key") && $("api-key").focus(), 250);
    return setStatus("⚠️ 먼저 Anthropic API 키를 넣어줘 (왼쪽 ☰)", false);
  }
  logReset("⚙️ 진행 로그");
  logPush(kind === "url" ? "시작 — 링크 처리" : "시작 — 붙여넣은 자막 처리");
  $("run-btn").disabled = true;
  $("paste-run").disabled = true;
  try {
    let source, meta, videoId = null, via = "paste";
    if (kind === "url") {
      logPush("자막 가져오는 중… (서버)");
      const res = await fetch("/api/transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...appTokenHeaders() },
        body: JSON.stringify({ url: payload.url }),
      });
      const t = await res.json();
      if (res.status === 401) { $("apptoken-box").classList.remove("hidden"); openDrawer(); setTimeout(() => $("app-token") && $("app-token").focus(), 250); }
      if (!res.ok || t.error) throw new Error(t.error || "자막을 가져오지 못했습니다.");
      source = t.segments ? { segments: t.segments } : { rawText: t.rawText };
      meta = { title: t.title, channel: t.channel, publishedDate: t.publishedDate, url: payload.url };
      videoId = t.videoId;
      via = t.via;
      const amount = t.segments ? `${t.segments.length.toLocaleString()}구간` : `${(t.rawText || "").length.toLocaleString()}자`;
      logPush(`✓ 자막 확보 (${via}, ${amount}) → 증류 시작`, "ok");
    } else {
      source = { rawText: payload.text };
      meta = { title: payload.title, url: payload.url };
      videoId = payload.url ? YTDistill.parseVideoId(payload.url) : null;
      via = "paste";
      logPush(`✓ 붙여넣은 자막 확보 (${payload.text.length.toLocaleString()}자) → 증류 시작`, "ok");
    }
    // 긴 영상은 네 API 비용이 커질 수 있어 미리 대략치를 알리고 확인받는다.
    const approxChars = source.segments
      ? source.segments.reduce((a, s) => a + (s.text || "").length, 0)
      : (source.rawText || "").length;
    if (approxChars > COST_CONFIRM_CHARS) {
      const est = estimateCostUSD(approxChars);
      const ok = window.confirm(
        `이 영상은 길어요 (약 ${approxChars.toLocaleString()}자).\n` +
        `증류에 대략 $${est.lo}~$${est.hi} 정도의 네 Anthropic API 비용이 들 수 있어요(개략 추정).\n\n계속할까요?`,
      );
      if (!ok) { logPush("사용자가 취소했어요(긴 영상 비용 확인).", "warn"); return; }
    }
    // 무거운 Claude 호출은 브라우저가 본인 키로 직접 (Render→Anthropic 끊김 우회)
    const result = await YTDistill.distill(
      source, meta, apiKey,
      (m) => logPush(m),
      getContext(),
    );
    finishRun({ videoId, url: meta.url || "", via, ...result });
  } catch (e) {
    logPush("✗ 실패: " + e.message, "err");
  } finally {
    $("run-btn").disabled = false;
    $("paste-run").disabled = false;
  }
}

function finishRun(data) {
  upsertArchive(data);
  show(data);
  logPush("완료 · 보관함에 저장됨", "done");
  // 자동 갱신이 켜져 있으면 새 글을 포함해 프로필 재추론(수동 편집 관점은 보존). 본 흐름은 막지 않음.
  if (getProfileAuto()) defineProfileNow(false);
}
// 상태 메시지는 다크 콘솔로 일원화한다(별도 상태창 제거).
// 진행 중이 아니면(콘솔이 숨겨졌으면) 새로 띄워 단독 한 줄로 보여준다.
function setStatus(msg, _busy) {
  if (!msg) return;
  if ($("log-console").classList.contains("hidden")) logReset("⚙️ 상태");
  logPush(msg);
}

// ── 진행 로그 콘솔(다크) — 각 단계를 +경과초와 함께 누적 표시 ───────────────
const now = () => (window.performance && performance.now ? performance.now() : Date.now());
let _logStart = 0;
function logReset(title) {
  _logStart = now();
  $("log-lines").innerHTML = "";
  $("log-title").textContent = title || "⚙️ 진행 로그";
  $("log-console").classList.remove("hidden");
}
function logPush(msg, kind) {
  if (!msg) return;
  const lines = $("log-lines");
  if (!lines || $("log-console").classList.contains("hidden")) return;
  let cls = kind || "";
  if (!cls) {
    if (/✗|실패|오류|에러/.test(msg)) cls = "err";
    else if (/완료|성공|✓/.test(msg)) cls = "ok";
    else if (/재시도|혼잡|끊김|일시|폴백/.test(msg)) cls = "warn";
  }
  const line = document.createElement("div");
  line.className = "log-line" + (cls ? " " + cls : "");
  const ts = document.createElement("span");
  ts.className = "log-t";
  ts.textContent = "+" + Math.max(0, (now() - _logStart) / 1000).toFixed(1) + "s";
  const m = document.createElement("span");
  m.className = "log-msg";
  m.textContent = msg;
  line.append(ts, m);
  lines.appendChild(line);
  lines.scrollTop = lines.scrollHeight;
}

// ── 서랍 ────────────────────────────────────────────────────────────────
function openDrawer() { $("drawer").classList.add("open"); $("scrim").classList.remove("hidden"); }
function closeDrawer() { $("drawer").classList.remove("open"); $("scrim").classList.add("hidden"); }

// ── 이벤트 ──────────────────────────────────────────────────────────────
$("url-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("url").value.trim();
  if (!url) return setStatus("⚠️ 링크를 입력해주세요.", false);
  run("url", { url });
});
$("menu-btn").onclick = openDrawer;
$("drawer-close").onclick = closeDrawer;
$("scrim").onclick = closeDrawer;
$("toggle-paste").onclick = () => $("paste-box").classList.toggle("hidden");
$("toggle-context").onclick = () => $("context-box").classList.toggle("hidden");
$("paste-run").onclick = () => {
  const text = $("paste-text").value.trim();
  if (text.length < 100) return setStatus("⚠️ 자막 텍스트가 너무 짧습니다.", false);
  run("paste", {
    text,
    title: $("paste-title").value.trim(),
    url: $("paste-url").value.trim(),
  });
};

// API 키 저장/삭제
$("key-save").onclick = () => {
  setApiKey($("api-key").value);
  setStatus(getApiKey() ? "✅ API 키를 저장했어요." : "키를 비웠어요.", false);
};
$("key-clear").onclick = () => {
  $("api-key").value = "";
  setApiKey("");
  setStatus("API 키를 삭제했어요.", false);
};

// 맥락 저장/비우기
$("context-save").onclick = () => {
  setContext($("context-text").value);
  setStatus(getContext() ? "✅ 맥락을 저장했어요. 다음 증류부터 반영됩니다." : "맥락을 비웠어요.", false);
};
$("context-clear").onclick = () => {
  $("context-text").value = "";
  setContext("");
  setStatus("맥락을 비웠어요. 기본 반도체 마케터 관점으로 돌아갑니다.", false);
};

// 앱 접근 토큰 저장
$("apptoken-save").onclick = () => {
  setAppToken($("app-token").value);
  setStatus(getAppToken() ? "✅ 앱 접근 토큰을 저장했어요." : "토큰을 비웠어요.", false);
};

// 보관함 백업/가져오기
$("export-btn").onclick = exportArchive;
$("import-btn").onclick = () => $("import-file").click();
$("import-file").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) importArchive(f);
  e.target.value = ""; // 같은 파일 다시 선택 가능하게
});

// 내 프로필 자동 정의
$("profile-define").onclick = () => defineProfileNow(true);
$("profile-auto").onchange = (e) => {
  setProfileAuto(e.target.checked);
  setStatus(e.target.checked ? "✅ 글 추가 시 프로필을 자동 갱신합니다." : "자동 갱신을 껐어요.", false);
};

// 진행 로그 콘솔 닫기
$("log-hide").onclick = () => $("log-console").classList.add("hidden");

// 2차 명령(B): 버튼 또는 Ctrl/Cmd+Enter
$("followup-run").onclick = runFollowup;
$("followup-input").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runFollowup(); }
});
$("search").addEventListener("input", renderList);
$("show-original").addEventListener("change", () => current && renderTranscript(current));
$("transcript-search").addEventListener("input", applyTranscriptSearch);

// 자막 캡쳐 모달
$("cap-close").onclick = closeCapture;
$("cap-modal").querySelector(".cap-scrim").onclick = closeCapture;
$("cap-download").onclick = downloadCapture;
$("cap-copy").onclick = copyCapture;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("cap-modal").classList.contains("hidden")) closeCapture();
});

// 맨 위로 버튼 — 스크롤 내려가면 노출
window.addEventListener("scroll", () => {
  $("to-top").classList.toggle("hidden", window.scrollY < 400);
}, { passive: true });
$("to-top").onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });
$("delete-btn").onclick = () => {
  if (!current) return;
  const key = archiveKey(current);
  archive = archive.filter((it) => archiveKey(it) !== key);
  removeItem(key); // 그 항목만 삭제
  renderList();
  $("result").classList.add("hidden");
  $("empty-state").classList.remove("hidden");
  current = null;
};

// ── 초기화 ──────────────────────────────────────────────────────────────
refreshKeyUI();
refreshContextUI();
refreshProfileUI();
refreshAppTokenUI();
checkServerAuth();
// 보관함은 IndexedDB에서 비동기 로드(최초 1회 localStorage 자동 이관) 후 렌더.
(async function initArchive() {
  archive = await loadArchive();
  renderList();
  updateStorageNote();
})();
