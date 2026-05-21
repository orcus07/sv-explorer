import { FilterPanel }    from './components/filter-panel.js';
import { PlatformGrid }   from './components/platform-grid.js';
import { GenerationNav }  from './components/generation-nav.js';
import { HierarchyView }  from './components/hierarchy-view.js';
import { CompareView }    from './components/compare-view.js';

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  platforms:        [],
  families:         [],
  filtered:         [],
  filters:          { vendors: null, types: null, memTypes: null },
  selectedId:       null,
  compareId:        null,
  compareMode:      false,
  hierarchyLevel:   'cluster',
  highlightMemType: null,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $filterEl    = document.getElementById('filter-panel');
const $gridEl      = document.getElementById('platform-grid');
const $hierarchyEl = document.getElementById('hierarchy-panel');
const $genNavWrap  = document.getElementById('gen-nav-wrapper');
const $genNavEl    = document.getElementById('generation-nav');
const $mainEl      = document.getElementById('app-main');
const $compareEl   = document.getElementById('compare-area');
const $btnCompare  = document.getElementById('btn-compare-mode');
const $btnHlClear  = document.getElementById('btn-highlight-clear');

// ─── Components ──────────────────────────────────────────────────────────────
const filterPanel = new FilterPanel($filterEl, onFilterChange);

const grid = new PlatformGrid($gridEl, {
  onSelect:        onCardSelect,
  onCompareSelect: onCompareCardSelect,
});

const genNav = new GenerationNav($genNavWrap, $genNavEl, {
  onGenSelect: id => { state.selectedId = id; state.compareId = null; applyAll(); },
});

const hierarchyView = new HierarchyView($hierarchyEl, {
  onLevelChange: lvl => { state.hierarchyLevel = lvl; },
});

const compareView = new CompareView($compareEl);

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function init() {
  const [platforms, genData] = await Promise.all([
    fetch('data/platforms.json').then(r => r.json()),
    fetch('data/generations.json').then(r => r.json()),
  ]);

  state.platforms = platforms;
  state.families  = genData.families;

  genNav.setData(state.families);
  applyAll();
}

// ─── Filter logic ─────────────────────────────────────────────────────────────
function applyFilters() {
  // memTypes는 필터가 아닌 하이라이트 전용 — 벤더/카테고리/이미지 필터링
  const { vendors, types, hasImage } = state.filters;
  state.filtered = state.platforms.filter(p => {
    const vendorKey = normalizeVendor(p.vendor);
    if (vendors  && !vendors.includes(vendorKey)) return false;
    if (types    && !types.includes(p.category))  return false;
    if (hasImage && !platformHasOfficialImage(p))  return false;
    return true;
  });
}

function platformHasOfficialImage(p) {
  const h = p.hierarchy;
  return ['cluster', 'rack', 'tray', 'server'].some(lvl => {
    const node = h[lvl];
    return node && node.official_image && node.official_image.status === 'found';
  });
}

function normalizeVendor(v) {
  if (!v) return '';
  const up = v.toUpperCase();
  if (up.includes('NVIDIA')) return 'NVIDIA';
  if (up.includes('AWS'))    return 'AWS';
  if (up.includes('GOOGLE')) return 'Google';
  if (up.includes('AZURE') || up.includes('MICROSOFT')) return 'Azure';
  if (up.includes('META'))   return 'Meta';
  if (up.includes('INTEL'))  return 'Intel';
  if (up.includes('AMD'))    return 'AMD';
  if (up === 'ARM')          return 'Arm';
  if (up === 'OTHER')        return 'Other';
  return v;
}

// ─── Highlight logic ──────────────────────────────────────────────────────────
function applyHighlight() {
  // memTypes filter doubles as highlight selector (first selected type)
  const { memTypes } = state.filters;
  state.highlightMemType = (memTypes && memTypes.length) ? memTypes[0] : null;
}

// ─── Master render ───────────────────────────────────────────────────────────
function applyAll() {
  applyFilters();
  applyHighlight();

  const selected = byId(state.selectedId);
  const compare  = byId(state.compareId);

  // Generation nav
  genNav.show(selected);

  // Grid
  grid.setData(state.filtered);
  grid.setState({
    selectedId:      state.selectedId,
    compareId:       state.compareId,
    highlightMemType: state.highlightMemType,
    compareMode:     state.compareMode,
  });

  // Filter count
  filterPanel.setCount(state.filtered.length, state.platforms.length);

  // Compare / hierarchy panel
  if (state.compareMode && selected && compare) {
    $mainEl.classList.add('compare-active');
    $compareEl.classList.remove('hidden');
    $hierarchyEl.classList.add('hidden');
    compareView.show(selected, compare);
  } else {
    $mainEl.classList.remove('compare-active');
    $compareEl.classList.add('hidden');
    $hierarchyEl.classList.remove('hidden');
    if (selected) {
      hierarchyView.setHighlight(state.highlightMemType);
      hierarchyView.show(selected, state.hierarchyLevel);
    } else {
      hierarchyView.clear();
    }
  }

  // Highlight clear btn
  $btnHlClear.style.display = state.highlightMemType ? '' : 'none';

  // Compare mode btn style & hint
  $btnCompare.classList.toggle('active', state.compareMode);
  const hint = document.getElementById('compare-hint');
  if (hint) hint.style.display = state.compareMode && !state.compareId ? '' : 'none';
}

function byId(id) {
  return id ? state.platforms.find(p => p.platform_id === id) : null;
}

// ─── Event handlers ───────────────────────────────────────────────────────────
function onFilterChange(filters) {
  state.filters = filters;
  applyAll();
}

function onCardSelect(id) {
  if (state.selectedId === id) {
    state.selectedId = null;
    state.compareId  = null;
    state.hierarchyLevel = 'cluster';
  } else {
    if (state.compareMode && state.compareId === id) {
      state.compareId = null;
    } else {
      state.selectedId     = id;
      state.hierarchyLevel = 'cluster';
    }
  }
  applyAll();
}

function onCompareCardSelect(id) {
  state.compareId = (state.compareId === id) ? null : id;
  applyAll();
}

$btnCompare.addEventListener('click', () => {
  state.compareMode = !state.compareMode;
  if (!state.compareMode) state.compareId = null;
  applyAll();
});

$btnHlClear.addEventListener('click', () => {
  filterPanel.filters.memTypes.clear();
  document.querySelectorAll('.chip[data-group="memTypes"]').forEach(c => c.classList.remove('active'));
  state.filters = filterPanel.getFilters();
  applyAll();
});

// ─── Mobile tabs ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $filterEl.classList.toggle('mobile-active',    tab === 'filter');
    $hierarchyEl.classList.toggle('mobile-active', tab === 'detail');
    document.getElementById('content-area').style.display = tab === 'grid' ? '' : 'none';
  });
});

// ─── Boot ────────────────────────────────────────────────────────────────────
init().catch(err => {
  document.getElementById('content-area').innerHTML =
    `<div style="padding:40px;text-align:center;color:#ef4444;">
       데이터 로드 오류: ${err.message}
     </div>`;
});
