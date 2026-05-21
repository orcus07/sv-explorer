import { memBadgeHTML } from './memory-badge.js';

// NVIDIA superchip platforms (vendor=NVIDIA + hierarchy.tray exists) → 4 tabs
// All others → 3 tabs (Superchip hidden, Tray shows server-level content)
const LEVELS_SUPERCHIP = ['cluster', 'rack', 'tray', 'superchip'];
const LEVELS_STANDARD  = ['cluster', 'rack', 'tray'];

const LEVEL_LABELS = {
  cluster:   'Cluster',
  rack:      'Rack',
  tray:      'Tray',
  superchip: 'Superchip',
};

const SOURCE_TYPE_LABELS = {
  press_kit:     '공식 Press Kit',
  keynote_slide: '키노트 슬라이드',
  datasheet_pdf: '공식 데이터시트',
  product_page:  '공식 제품 페이지',
  official_blog: '공식 블로그',
  official_doc:  '공식 기술 문서',
  oem_manual:    'OEM 사용설명서',
  odm_guide:     'ODM 제품 가이드',
  neocloud_blog: '공식 블로그',
};

export class HierarchyView {
  constructor(container, { onLevelChange }) {
    this.el = container;
    this.onLevelChange = onLevelChange;
    this.platform = null;
    this.currentLevel = 'cluster';
    this.highlightMemType = null;
  }

  show(platform, level) {
    this.platform = platform;
    this.currentLevel = level || 'cluster';
    this._render();
  }

  setHighlight(memType) {
    this.highlightMemType = memType;
    if (this.platform) this._render();
  }

  clear() {
    this.platform = null;
    this._renderEmpty();
  }

  _isNvidiaSuperchip() {
    const p = this.platform;
    return p && p.vendor === 'NVIDIA' && p.hierarchy.tray != null;
  }

  _levels() {
    return this._isNvidiaSuperchip() ? LEVELS_SUPERCHIP : LEVELS_STANDARD;
  }

  _render() {
    const p = this.platform;
    if (!p) { this._renderEmpty(); return; }

    const levels = this._levels();
    // Guard: if stored level no longer exists (e.g. old 'server'/'component'), reset
    if (!levels.includes(this.currentLevel)) this.currentLevel = 'cluster';
    const curIdx = levels.indexOf(this.currentLevel);

    this.el.innerHTML = `
      <div class="hierarchy-header">
        <div class="hierarchy-title">${p.display_name}</div>
        <nav class="breadcrumb" aria-label="계층 탐색">
          ${levels.map((lvl, i) => `
            <button class="breadcrumb-item${lvl === this.currentLevel ? ' active' : ''}" data-level="${lvl}">
              ${LEVEL_LABELS[lvl]}
            </button>
            ${i < levels.length - 1 ? '<span class="breadcrumb-sep">›</span>' : ''}
          `).join('')}
        </nav>
      </div>
      <div class="hierarchy-body">
        ${this._levelHTML(p, this.currentLevel)}
        ${curIdx < levels.length - 1
          ? `<button class="drill-down-btn" data-next="${levels[curIdx + 1]}">
              ${LEVEL_LABELS[levels[curIdx + 1]]} 보기 →
             </button>`
          : ''}
      </div>`;

    this.el.querySelectorAll('.breadcrumb-item:not(.active)').forEach(btn => {
      btn.addEventListener('click', () => {
        this.currentLevel = btn.dataset.level;
        this.onLevelChange(this.currentLevel);
        this._render();
      });
    });

    const nextBtn = this.el.querySelector('.drill-down-btn[data-next]');
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        this.currentLevel = nextBtn.dataset.next;
        this.onLevelChange(this.currentLevel);
        this._render();
      });
    }
  }

  _renderEmpty() {
    this.el.innerHTML = `
      <div class="hierarchy-empty">
        <div class="hierarchy-empty-icon">⬡</div>
        <div class="hierarchy-empty-text">
          플랫폼을 선택하면<br>계층 구조를 드릴다운할 수 있습니다.
        </div>
      </div>`;
  }

  _levelHTML(p, level) {
    const h = p.hierarchy;
    const nvSuperchip = this._isNvidiaSuperchip();
    switch (level) {
      case 'cluster':
        return this._clusterHTML(p, h.cluster);
      case 'rack':
        return this._rackHTML(p, h.rack);
      case 'tray':
        // NVIDIA superchip platforms: show physical compute tray
        // All others: repurpose Tray tab to show server/node specs
        return nvSuperchip ? this._trayHTML(p, h.tray) : this._serverHTML(p, h.server, 'Server Node');
      case 'superchip':
        // NVIDIA only — Grace+GPU superchip detail
        return this._superchipHTML(p, h.server);
      default:
        return '';
    }
  }

  _clusterHTML(p, c) {
    return `
      <div class="level-card">
        <div class="level-card-header">
          <span class="level-label">Cluster</span>
          <span class="level-name">${c.label}</span>
        </div>
        <div class="level-card-body">
          ${levelImagesHTML(p, 'cluster')}
          <table class="spec-table">
            <tr><td>인터커넥트</td><td>${c.fabric || '—'}</td></tr>
            <tr><td>설명</td><td>${c.description || '—'}</td></tr>
          </table>
        </div>
      </div>`;
  }

  _rackHTML(p, r) {
    return `
      <div class="level-card">
        <div class="level-card-header">
          <span class="level-label">Rack</span>
          <span class="level-name">${r.label}</span>
        </div>
        <div class="level-card-body">
          ${levelImagesHTML(p, 'rack')}
          <table class="spec-table">
            ${r.trays_per_rack != null ? `<tr><td>Tray 수</td><td>${r.trays_per_rack}</td></tr>` : ''}
            ${r.total_gpus != null ? `<tr><td>총 GPU 수</td><td>${r.total_gpus}</td></tr>` : ''}
            ${r.total_accelerators != null ? `<tr><td>총 가속기 수</td><td>${r.total_accelerators}</td></tr>` : ''}
            ${r.total_cpus != null ? `<tr><td>총 CPU 수</td><td>${r.total_cpus}</td></tr>` : ''}
            ${r.servers_per_rack != null ? `<tr><td>서버 수</td><td>${r.servers_per_rack}</td></tr>` : ''}
            ${r.power_kw != null ? `<tr><td>소비전력</td><td>${r.power_kw} kW</td></tr>` : ''}
          </table>
        </div>
      </div>`;
  }

  _trayHTML(p, t) {
    if (!t) return '';
    return `
      <div class="level-card">
        <div class="level-card-header">
          <span class="level-label">Tray</span>
          <span class="level-name">${t.label}</span>
        </div>
        <div class="level-card-body">
          ${levelImagesHTML(p, 'tray')}
          <table class="spec-table">
            ${t.count_per_rack != null ? `<tr><td>Rack당 Tray 수</td><td>${t.count_per_rack}</td></tr>` : ''}
            ${t.superchips_per_tray != null ? `<tr><td>Superchip 수</td><td>${t.superchips_per_tray}</td></tr>` : ''}
            ${t.chips_per_host != null ? `<tr><td>칩 수</td><td>${t.chips_per_host}</td></tr>` : ''}
            ${t.chips_per_node != null ? `<tr><td>칩 수 (노드당)</td><td>${t.chips_per_node}</td></tr>` : ''}
            <tr><td>설명</td><td>${t.description || '—'}</td></tr>
          </table>
        </div>
      </div>`;
  }

  // label: display tab name; imgLevel: which level to pull images from
  _serverHTML(p, s, label = 'Server Node', imgLevel = 'tray') {
    if (!s) return '';
    const cpu = s.cpu;
    const gpu = s.gpu || s.accelerator;
    const hl  = this.highlightMemType;

    return `
      <div class="level-card">
        <div class="level-card-header">
          <span class="level-label">${label}</span>
          <span class="level-name">${s.form_factor || '—'}</span>
        </div>
        <div class="level-card-body">
          ${levelImagesHTML(p, imgLevel)}
          <table class="spec-table">
            ${cpu ? `
              <tr><td>CPU 모델</td><td>${cpu.model}</td></tr>
              <tr><td>CPU 수</td><td>${cpu.count_per_server}S</td></tr>
              <tr><td>호스트 메모리</td><td>${memBadgeHTML(cpu.mem_type, hl === cpu.mem_type ? 'pulsing' : '')} ${cpu.mem_gb_per_cpu ? cpu.mem_gb_per_cpu + 'GB' : ''}</td></tr>
              ${cpu.dimm_count != null ? `<tr><td>DIMM 수</td><td>${cpu.dimm_count}</td></tr>` : ''}
              ${cpu.mem_speed_mt != null ? `<tr><td>메모리 속도</td><td>${cpu.mem_speed_mt} MT/s</td></tr>` : ''}
              ${cpu.mem_bandwidth_gbps != null ? `<tr><td>메모리 BW</td><td>${cpu.mem_bandwidth_gbps} GB/s</td></tr>` : ''}
            ` : ''}
            ${gpu ? `
              <tr><td colspan="2" style="padding-top:6px;color:var(--text-muted);font-size:0.7rem;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">가속기</td></tr>
              <tr><td>모델</td><td>${gpu.model}</td></tr>
              <tr><td>수량</td><td>${gpu.count_per_server}</td></tr>
              <tr><td>가속기 메모리</td><td>${memBadgeHTML(gpu.mem_type, hl === gpu.mem_type ? 'pulsing' : '')} ${gpu.mem_gb_per_gpu ? gpu.mem_gb_per_gpu + 'GB' : gpu.mem_gb_per_chip ? gpu.mem_gb_per_chip + 'GB' : ''}</td></tr>
              ${gpu.mem_bandwidth_tbps != null ? `<tr><td>HBM BW</td><td>${gpu.mem_bandwidth_tbps} TB/s</td></tr>` : ''}
              ${gpu.interconnect ? `<tr><td>인터커넥트</td><td>${gpu.interconnect}</td></tr>` : ''}
            ` : ''}
          </table>
        </div>
      </div>`;
  }

  // NVIDIA Superchip tab — Grace + GPU Superchip detail
  _superchipHTML(p, s) {
    return this._serverHTML(p, s, 'Superchip', 'superchip');
  }
}

// Renders all images for a given hierarchy level from the platform's flat images[]
function levelImagesHTML(p, level) {
  const imgs = (p.images || []).filter(img => img.level === level && img.file);
  if (imgs.length === 0) return placeholderHTML('공식 발표 자료에서 확인된 이미지가 없습니다.');
  return imgs.map(img => singleImageHTML(img)).join('');
}

function singleImageHTML(img) {
  const sourceLabel = attributionLabel(img);
  const captionPart = img.caption ? `<strong>${img.caption}</strong> — ` : '';
  return `
    <div class="official-image-wrap">
      <img src="${img.file}" alt="${img.caption || '공식 이미지'}" loading="lazy">
      <div class="image-attribution">
        <span>${captionPart}출처: ${sourceLabel}</span>
        ${img.source_url ? `<a href="${img.source_url}" target="_blank" rel="noopener">원본 링크 ↗</a>` : ''}
      </div>
    </div>`;
}

function placeholderHTML(note) {
  return `
    <div class="official-image-wrap">
      <div class="image-placeholder">
        <span class="placeholder-bracket">[ 공식 이미지 없음 ]</span>
        <span class="placeholder-note">${note}</span>
      </div>
    </div>`;
}

function attributionLabel(img) {
  let base = SOURCE_TYPE_LABELS[img.source_type] || img.source_type || '출처 불명';
  if (img.source_type === 'keynote_slide' && img.event) base += ` (${img.event})`;
  if (img.capture_date) base += ` · ${img.capture_date}`;
  return base;
}
