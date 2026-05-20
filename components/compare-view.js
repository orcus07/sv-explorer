import { memBadgeHTML } from './memory-badge.js';

const LEVELS_AI = ['cluster', 'rack', 'tray', 'server', 'component'];
const LEVELS_GP = ['cluster', 'rack', 'server', 'component'];
const LEVEL_LABELS = {
  cluster: 'Cluster', rack: 'Rack', tray: 'Tray',
  server: 'Server', component: 'Component',
};

export class CompareView {
  constructor(container) {
    this.el = container;
    this.platformA = null;
    this.platformB = null;
    this.currentLevel = 'cluster';
  }

  show(platformA, platformB) {
    this.platformA = platformA;
    this.platformB = platformB;
    this._render();
  }

  clear() {
    this.platformA = null;
    this.platformB = null;
    this.el.innerHTML = '';
  }

  _levels(p) {
    return p?.category === 'GP_SV' ? LEVELS_GP : LEVELS_AI;
  }

  _render() {
    const a = this.platformA;
    const b = this.platformB;
    if (!a && !b) { this.el.innerHTML = ''; return; }

    const levelsA = this._levels(a);
    const levelsB = this._levels(b);
    const sharedLevels = LEVELS_AI.filter(l => levelsA.includes(l) || levelsB.includes(l));
    const cl = this.currentLevel;

    this.el.innerHTML = `
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
        <span style="font-size:0.82rem;font-weight:600;">플랫폼 비교</span>
        <div style="display:flex;gap:4px;">
          ${sharedLevels.map(l => `
            <button class="btn btn-ghost btn-sm compare-level-btn${l === cl ? ' active' : ''}" data-level="${l}">
              ${LEVEL_LABELS[l]}
            </button>`).join('')}
        </div>
      </div>
      <div class="compare-view" style="padding:12px;gap:10px;">
        ${a ? this._colHTML(a, cl, 'A', '#6366f1') : '<div style="flex:1;"></div>'}
        ${b ? this._colHTML(b, cl, 'B', '#f59e0b') : '<div style="flex:1;"></div>'}
      </div>`;

    this.el.querySelectorAll('.compare-level-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.currentLevel = btn.dataset.level;
        this._render();
      });
    });
  }

  _colHTML(p, level, label, color) {
    const h = p.hierarchy;
    const memDiff = this._checkMemDiff(level);

    return `
      <div class="compare-col">
        <div class="compare-col-header" style="border-top:2px solid ${color};">
          <span class="compare-col-name">${p.display_name}</span>
          <span style="font-size:0.66rem;font-weight:700;color:${color};letter-spacing:0.08em;">${label}</span>
        </div>
        <div class="compare-col-body">
          ${this._levelContentHTML(p, level, memDiff)}
        </div>
      </div>`;
  }

  _checkMemDiff(level) {
    const a = this.platformA;
    const b = this.platformB;
    if (!a || !b || level !== 'component') return false;
    const aHost = a.hierarchy.server?.cpu?.mem_type;
    const bHost = b.hierarchy.server?.cpu?.mem_type;
    const aAccel = (a.hierarchy.server?.gpu || a.hierarchy.server?.accelerator)?.mem_type;
    const bAccel = (b.hierarchy.server?.gpu || b.hierarchy.server?.accelerator)?.mem_type;
    return aHost !== bHost || aAccel !== bAccel;
  }

  _levelContentHTML(p, level, memDiff) {
    const h = p.hierarchy;
    switch (level) {
      case 'cluster': return this._clusterContent(h.cluster);
      case 'rack':    return this._rackContent(h.rack);
      case 'tray':    return p.category === 'GP_SV'
        ? '<p style="color:var(--text-muted);font-size:0.78rem;">GP SV — Tray 없음</p>'
        : this._trayContent(h.tray);
      case 'server':    return this._serverContent(h.server);
      case 'component': return this._componentContent(p, h.server, memDiff);
      default: return '';
    }
  }

  _clusterContent(c) {
    return this._table([
      ['라벨', c.label],
      ['패브릭', c.fabric || '—'],
      ['설명', c.description || '—'],
    ]);
  }

  _rackContent(r) {
    return this._table([
      ['라벨', r.label],
      ['서버 수', r.servers_per_rack],
      ['총 GPU', r.total_gpus || r.total_accelerators || '—'],
      ['총 CPU', r.total_cpus || '—'],
    ]);
  }

  _trayContent(t) {
    if (!t) return '<p style="color:var(--text-muted);font-size:0.78rem;">Tray 정보 없음</p>';
    return this._table([
      ['라벨', t.label],
      ['Rack당 Tray', t.count_per_rack || '—'],
      ['Superchip', t.superchips_per_tray || '—'],
    ]);
  }

  _serverContent(s) {
    const cpu = s.cpu;
    const gpu = s.gpu || s.accelerator;
    const rows = [];
    if (cpu) {
      rows.push(['CPU 모델', cpu.model]);
      rows.push(['CPU 수', cpu.count_per_server + 'S']);
      rows.push(['호스트 메모리', memBadgeHTML(cpu.mem_type) + ` ${cpu.mem_gb_per_cpu || ''}GB`]);
      if (cpu.dimm_count) rows.push(['DIMM 수', cpu.dimm_count]);
    }
    if (gpu) {
      rows.push(['가속기 모델', gpu.model]);
      rows.push(['가속기 수', gpu.count_per_server]);
      rows.push(['가속기 메모리', memBadgeHTML(gpu.mem_type) + ` ${gpu.mem_gb_per_gpu || gpu.mem_gb_per_chip || ''}GB`]);
    }
    return this._table(rows);
  }

  _componentContent(p, s, memDiff) {
    const cpu = s?.cpu;
    const gpu = s?.gpu || s?.accelerator;
    const other = this.platformA?.platform_id === p.platform_id ? this.platformB : this.platformA;
    const otherCpu = other?.hierarchy?.server?.cpu;
    const otherGpu = other?.hierarchy?.server?.gpu || other?.hierarchy?.server?.accelerator;
    const cpuDiff = memDiff && cpu?.mem_type !== otherCpu?.mem_type;
    const gpuDiff = memDiff && gpu?.mem_type !== otherGpu?.mem_type;

    return `
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${cpu ? `
          <div class="component-box${cpuDiff ? ' diff' : ''}">
            <div class="component-box-title">CPU ${cpuDiff ? '<span class="diff-badge">차이</span>' : ''}</div>
            <div class="component-box-name">${cpu.model}</div>
            ${memBadgeHTML(cpu.mem_type)}
            <div class="component-box-spec">${cpu.mem_gb_per_cpu || ''}GB ${cpu.mem_channels ? cpu.mem_channels + 'ch' : ''}</div>
          </div>` : ''}
        ${gpu ? `
          <div class="component-box${gpuDiff ? ' diff' : ''}">
            <div class="component-box-title">가속기 ${gpuDiff ? '<span class="diff-badge">차이</span>' : ''}</div>
            <div class="component-box-name">${gpu.model}</div>
            ${memBadgeHTML(gpu.mem_type)}
            <div class="component-box-spec">${gpu.mem_gb_per_gpu || gpu.mem_gb_per_chip || ''}GB ${gpu.mem_bandwidth_tbps ? gpu.mem_bandwidth_tbps + ' TB/s' : ''}</div>
          </div>` : `
          <div class="component-box">
            <div class="component-box-title">가속기</div>
            <div class="component-box-spec text-muted">해당 없음 (GP SV)</div>
          </div>`}
      </div>`;
  }

  _table(rows) {
    return `<table class="spec-table">
      ${rows.map(([k, v]) => v != null ? `<tr><td>${k}</td><td>${v}</td></tr>` : '').join('')}
    </table>`;
  }
}
