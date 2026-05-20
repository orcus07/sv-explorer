import { memBadgeHTML } from './memory-badge.js';

const LEVELS_AI = ['cluster', 'rack', 'tray', 'server', 'component'];
const LEVELS_GP = ['cluster', 'rack', 'server', 'component'];

const LEVEL_LABELS = {
  cluster:   'Cluster',
  rack:      'Rack',
  tray:      'Tray',
  server:    'Server (2S)',
  component: 'Component',
};

const SOURCE_TYPE_LABELS = {
  press_kit:     '공식 Press Kit',
  keynote_slide: '키노트 슬라이드',
  datasheet_pdf: '공식 데이터시트',
  product_page:  '공식 제품 페이지',
  official_blog: '공식 블로그',
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

  _levels() {
    return this.platform?.category === 'GP_SV' ? LEVELS_GP : LEVELS_AI;
  }

  _render() {
    const p = this.platform;
    if (!p) { this._renderEmpty(); return; }

    const levels = this._levels();
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
    switch (level) {
      case 'cluster':   return this._clusterHTML(p, h.cluster);
      case 'rack':      return this._rackHTML(p, h.rack);
      case 'tray':      return p.category === 'GP_SV' ? '' : this._trayHTML(p, h.tray);
      case 'server':    return this._serverHTML(p, h.server);
      case 'component': return this._componentHTML(p, h.server);
      default:          return '';
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
          ${officialImageHTML(c.official_image)}
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
          ${officialImageHTML(r.official_image)}
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
          ${officialImageHTML(t.official_image)}
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

  _serverHTML(p, s) {
    const cpu = s.cpu;
    const gpu = s.gpu || s.accelerator;
    const hl  = this.highlightMemType;

    return `
      <div class="level-card">
        <div class="level-card-header">
          <span class="level-label">Server (2S)</span>
          <span class="level-name">${s.form_factor}</span>
        </div>
        <div class="level-card-body">
          ${officialImageHTML(s.official_image)}
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

  _componentHTML(p, s) {
    const cpu = s?.cpu;
    const gpu = s?.gpu || s?.accelerator;
    const hl  = this.highlightMemType;

    const cpuDiff = hl && cpu?.mem_type !== hl;
    const gpuDiff = hl && gpu?.mem_type !== hl;

    return `
      <div class="level-card">
        <div class="level-card-header">
          <span class="level-label">Component</span>
          <span class="level-name">CPU / Accelerator 상세</span>
        </div>
        <div class="level-card-body">
          <div class="component-grid">
            ${cpu ? `
              <div class="component-box">
                <div class="component-box-title">CPU</div>
                <div class="component-box-name">${cpu.model}</div>
                <div class="component-box-spec">${cpu.arch || ''} · ${cpu.cores ? cpu.cores + '코어' : ''}</div>
                ${memBadgeHTML(cpu.mem_type, hl === cpu.mem_type ? 'pulsing' : '')}
                <div class="component-box-spec">
                  ${cpu.mem_gb_per_cpu ? cpu.mem_gb_per_cpu + ' GB' : ''}
                  ${cpu.mem_bandwidth_gbps ? '· ' + cpu.mem_bandwidth_gbps + ' GB/s' : ''}
                </div>
                <div class="component-box-spec">${cpu.mem_channels ? cpu.mem_channels + '채널' : ''} ${cpu.dimm_count ? cpu.dimm_count + ' DIMM' : ''}</div>
              </div>` : ''}
            ${gpu ? `
              <div class="component-box${hl && gpu.mem_type !== hl && !cpuDiff ? ' diff' : ''}">
                <div class="component-box-title">가속기</div>
                <div class="component-box-name">${gpu.model}</div>
                <div class="component-box-spec">${gpu.count_per_server}× per 서버</div>
                ${memBadgeHTML(gpu.mem_type, hl === gpu.mem_type ? 'pulsing' : '')}
                <div class="component-box-spec">
                  ${gpu.mem_gb_per_gpu ? gpu.mem_gb_per_gpu + ' GB' : gpu.mem_gb_per_chip ? gpu.mem_gb_per_chip + ' GB' : ''}
                  ${gpu.mem_bandwidth_tbps ? '· ' + gpu.mem_bandwidth_tbps + ' TB/s' : ''}
                </div>
              </div>` : `
              <div class="component-box">
                <div class="component-box-title">가속기</div>
                <div class="component-box-spec" style="color:var(--text-muted)">해당 없음 (GP SV)</div>
              </div>`}
          </div>
        </div>
      </div>`;
  }
}

function officialImageHTML(img) {
  if (!img) {
    return placeholderHTML('이미지 정보 없음');
  }
  if (img.status === 'not_found' || !img.file) {
    return placeholderHTML(img.note || '공식 발표 자료에서 확인된 이미지가 없습니다.');
  }

  const sourceLabel = attributionLabel(img);
  return `
    <div class="official-image-wrap">
      <img src="${img.file}" alt="공식 이미지" loading="lazy">
      <div class="image-attribution">
        <span>출처: ${sourceLabel}</span>
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
