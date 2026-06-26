// 유튜브 트랜스크립트 · 구조 증류 리더 — 프론트엔드.
// 링크/붙여넣기 → 서버 증류 → 화면 렌더 + 보관함(localStorage).
// 타임스탬프 클릭 → sticky 임베드 플레이어 점프 + 해당 트랜스크립트 위치로 스크롤.

const $ = (id) => document.getElementById(id);
const STORE_KEY = "yt-distill-archive";

let archive = loadArchive();
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
  renderList();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderTranscript(item) {
  const el = $("r-transcript");
  el.innerHTML = "";
  const showOrig = $("show-original").checked;
  const hasVideo = !!item.videoId;
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
      return `[${t}] ${o}${o ? "\n" : ""}(번역) ${p.korean || ""}`;
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
    const ts = document.createElement("button");
    ts.className = "ts";
    ts.textContent = ch.timestamp || fmtTime(ch.seconds);
    ts.onclick = () => { if (hasVideo) seekTo(ch.seconds); scrollToTranscript(ch.seconds); };

    const body = document.createElement("div");
    body.className = "c-body";
    const head = document.createElement("strong"); head.textContent = ch.heading || "";
    const sum = document.createElement("span"); sum.className = "muted small"; sum.textContent = ch.summary || "";
    body.append(head, sum);

    // 상세 박스는 챕터 행(칩+본문) 밖, 전체 폭으로 빼서 가독성 확보(아래 li.append).
    const detail = canDetail ? document.createElement("div") : null;
    if (canDetail) {
      const startSec = ch.seconds || 0;
      const endSec = i + 1 < chapters.length ? (chapters[i + 1].seconds || null) : null;
      detail.className = "chapter-detail md hidden";
      const btn = document.createElement("button");
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
          saveArchive();
          paint();
        } catch (e) {
          detail.innerHTML = `<p class="muted">⚠️ ${esc(e.message)}<br>버튼을 다시 누르면 재시도해요.</p>`;
          btn.textContent = "🔁 다시 시도";
        } finally { btn.disabled = false; }
      };
      body.append(btn);
      paint();
    }

    li.append(ts, body);
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
    const ko = document.createElement("p");
    ko.className = "q-ko";
    ko.textContent = q.korean || "";
    body.append(orig, ko);
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
      saveArchive();
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
  setStatus("⏳ 2차 명령 처리 중…", true);
  logReset("💬 2차 명령 로그");
  logPush("시작 — " + instruction);
  try {
    const ans = await YTDistill.followUp({
      instruction, sourceText: src, apiKey, context: getContext(),
      onProgress: (m) => { setStatus("⏳ " + m, true); logPush(m); },
    });
    current.followups = current.followups || [];
    current.followups.unshift({ q: instruction, a: ans });
    saveArchive();
    renderFollowups(current);
    input.value = "";
    setStatus("완료 · 2차 명령 결과를 추가했어요", false);
    logPush("완료 · 결과를 추가했어요", "done");
  } catch (e) {
    setStatus("⚠️ " + e.message, false);
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
  setStatus("시작하는 중…", true);
  logReset("⚙️ 진행 로그");
  logPush(kind === "url" ? "시작 — 링크 처리" : "시작 — 붙여넣은 자막 처리");
  $("run-btn").disabled = true;
  $("paste-run").disabled = true;
  try {
    let source, meta, videoId = null, via = "paste";
    if (kind === "url") {
      setStatus("⏳ 자막 가져오는 중…", true);
      logPush("자막 가져오는 중… (서버)");
      const res = await fetch("/api/transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: payload.url }),
      });
      const t = await res.json();
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
    // 무거운 Claude 호출은 브라우저가 본인 키로 직접 (Render→Anthropic 끊김 우회)
    const result = await YTDistill.distill(
      source, meta, apiKey,
      (m) => { setStatus("⏳ " + m, true); logPush(m); },
      getContext(),
    );
    finishRun({ videoId, url: meta.url || "", via, ...result });
  } catch (e) {
    setStatus("⚠️ " + e.message, false);
    logPush("✗ 실패: " + e.message, "err");
  } finally {
    $("run-btn").disabled = false;
    $("paste-run").disabled = false;
  }
}

function finishRun(data) {
  upsertArchive(data);
  show(data);
  setStatus("완료 · 보관함에 저장됨", false);
  logPush("완료 · 보관함에 저장됨", "done");
  // 자동 갱신이 켜져 있으면 새 글을 포함해 프로필 재추론(수동 편집 관점은 보존). 본 흐름은 막지 않음.
  if (getProfileAuto()) defineProfileNow(false);
}
function setStatus(msg, busy) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("busy", !!busy);
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
refreshKeyUI();
refreshContextUI();
refreshProfileUI();
renderList();
