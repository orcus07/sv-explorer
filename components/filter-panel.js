import { memColor } from './memory-badge.js';

const VENDORS = ['NVIDIA', 'AWS', 'Google', 'Azure', 'Meta', 'Intel', 'AMD', 'Arm', 'Other'];
const TYPES   = ['AI_SV', 'GP_SV'];
const MEM_TYPES = ['DDR5_RDIMM', 'DDR4_RDIMM', 'LPDDR5X_SOCAMM2', 'HBM3e', 'HBM3', 'HBM2e', 'HBM2', 'GDDR6', 'SRAM'];

export class FilterPanel {
  constructor(container, onFilterChange) {
    this.el = container;
    this.onChange = onFilterChange;
    this.filters = {
      vendors:  new Set(),
      types:    new Set(),
      memTypes: new Set(),
    };
    this.render();
    this._bind();
  }

  render() {
    this.el.innerHTML = `
      <div class="filter-section">
        <div class="filter-section-title">벤더</div>
        <div class="filter-chips" id="fp-vendors">
          ${VENDORS.map(v => `
            <button class="chip" data-group="vendors" data-val="${v}">
              <span class="chip-dot" style="background:${vendorColor(v)}"></span>
              ${v}
            </button>`).join('')}
        </div>
      </div>

      <div class="filter-divider"></div>

      <div class="filter-section">
        <div class="filter-section-title">서버 타입</div>
        <div class="filter-chips" id="fp-types">
          <button class="chip" data-group="types" data-val="AI_SV">AI SV</button>
          <button class="chip" data-group="types" data-val="GP_SV">GP SV</button>
        </div>
      </div>

      <div class="filter-divider"></div>

      <div class="filter-section">
        <div class="filter-section-title">메모리 타입 하이라이트</div>
        <div class="filter-chips" id="fp-memtypes">
          ${MEM_TYPES.map(m => `
            <button class="chip" data-group="memTypes" data-val="${m}" data-mem="${m}">
              <span class="chip-dot"></span>
              ${memLabel(m)}
            </button>`).join('')}
        </div>
      </div>

      <div class="filter-divider"></div>

      <button class="btn btn-ghost btn-sm" id="fp-reset" style="width:100%;justify-content:center;">필터 초기화</button>

      <div class="filter-count" id="fp-count"></div>
    `;
  }

  _bind() {
    this.el.querySelectorAll('.chip[data-group]').forEach(btn => {
      btn.addEventListener('click', () => {
        const { group, val } = btn.dataset;
        if (this.filters[group].has(val)) {
          this.filters[group].delete(val);
          btn.classList.remove('active');
        } else {
          this.filters[group].add(val);
          btn.classList.add('active');
        }
        this.onChange(this.getFilters());
      });
    });

    this.el.querySelector('#fp-reset').addEventListener('click', () => {
      ['vendors', 'types', 'memTypes'].forEach(g => this.filters[g].clear());
      this.el.querySelectorAll('.chip').forEach(b => b.classList.remove('active'));
      this.onChange(this.getFilters());
    });
  }

  getFilters() {
    return {
      vendors:  this.filters.vendors.size  ? [...this.filters.vendors]  : null,
      types:    this.filters.types.size    ? [...this.filters.types]    : null,
      memTypes: this.filters.memTypes.size ? [...this.filters.memTypes] : null,
    };
  }

  setCount(visible, total) {
    const el = this.el.querySelector('#fp-count');
    if (el) el.textContent = `${visible} / ${total} 플랫폼`;
  }
}

function vendorColor(v) {
  return {
    NVIDIA: '#76b900', AWS: '#ff9900', Google: '#4285f4',
    Azure: '#0078d4', Meta: '#1877f2', Intel: '#0071c5', AMD: '#ed1c24',
    Arm: '#0091bd', Other: '#7c3aed',
  }[v] || '#8888aa';
}

function memLabel(m) {
  return {
    DDR5_RDIMM: 'DDR5 RDIMM', DDR4_RDIMM: 'DDR4 RDIMM',
    LPDDR5X_SOCAMM2: 'LPDDR5X SOCAMM2',
    HBM3e: 'HBM3e', HBM3: 'HBM3', HBM2e: 'HBM2e', HBM2: 'HBM2',
    GDDR6: 'GDDR6', SRAM: 'SRAM',
  }[m] || m;
}
