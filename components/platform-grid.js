import { memBadgeHTML, memColor } from './memory-badge.js';

export class PlatformGrid {
  constructor(container, { onSelect, onCompareSelect }) {
    this.el = container;
    this.onSelect = onSelect;
    this.onCompareSelect = onCompareSelect;
    this.platforms = [];
    this.selectedId = null;
    this.compareId = null;
    this.highlightMemType = null;
    this.compareMode = false;
    this.currentPage = 1;
    this.pageSize = 24;
  }

  setData(platforms) {
    this.platforms = platforms;
    this.currentPage = 1;
    this.render();
  }

  setPage(n) {
    this.currentPage = n;
    this.render();
    this.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  setState({ selectedId, compareId, highlightMemType, compareMode }) {
    this.selectedId = selectedId ?? this.selectedId;
    this.compareId = compareId ?? this.compareId;
    this.highlightMemType = highlightMemType !== undefined ? highlightMemType : this.highlightMemType;
    this.compareMode = compareMode ?? this.compareMode;
    this.render();
  }

  render() {
    const { platforms, selectedId, compareId, highlightMemType, compareMode, pageSize } = this;

    if (!platforms.length) {
      this.el.innerHTML = `
        <div style="padding:40px;text-align:center;color:var(--text-muted);font-size:0.82rem;">
          조건에 맞는 플랫폼이 없습니다.
        </div>`;
      return;
    }

    const totalPages = Math.ceil(platforms.length / pageSize);
    const page = Math.max(1, Math.min(this.currentPage, totalPages));
    if (page !== this.currentPage) this.currentPage = page;

    const start = (page - 1) * pageSize;
    const pageItems = platforms.slice(start, start + pageSize);

    const highlightActive = highlightMemType !== null;
    const matchesHighlight = p => highlightActive && (
      p.memory_summary.host_mem_type === highlightMemType ||
      p.memory_summary.accel_mem_type === highlightMemType
    );

    this.el.innerHTML = `
      <div class="platform-grid">
        ${pageItems.map(p => this._cardHTML(p, { selectedId, compareId, highlightActive, matchesHighlight, compareMode, highlightMemType })).join('')}
      </div>
      ${totalPages > 1 ? this._paginationHTML(page, totalPages) : ''}`;

    this.el.querySelectorAll('.platform-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        if (compareMode && selectedId && id !== selectedId) {
          this.onCompareSelect(id);
        } else {
          this.onSelect(id);
        }
      });
    });

    if (totalPages > 1) {
      this.el.querySelectorAll('.page-btn[data-page]').forEach(btn => {
        btn.addEventListener('click', () => {
          const val = btn.dataset.page;
          if (val === 'prev') this.setPage(page - 1);
          else if (val === 'next') this.setPage(page + 1);
          else this.setPage(Number(val));
        });
      });
    }
  }

  _paginationHTML(page, total) {
    const pages = [];
    const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

    let nums;
    if (total <= 7) {
      nums = range(1, total);
    } else if (page <= 4) {
      nums = [...range(1, 5), '…', total];
    } else if (page >= total - 3) {
      nums = [1, '…', ...range(total - 4, total)];
    } else {
      nums = [1, '…', page - 1, page, page + 1, '…', total];
    }

    nums.forEach(n => {
      if (n === '…') {
        pages.push(`<span class="page-ellipsis">…</span>`);
      } else {
        pages.push(`<button class="page-btn${n === page ? ' active' : ''}" data-page="${n}">${n}</button>`);
      }
    });

    return `
      <div class="pagination">
        <button class="page-btn" data-page="prev"${page === 1 ? ' disabled' : ''}>‹</button>
        ${pages.join('')}
        <button class="page-btn" data-page="next"${page === total ? ' disabled' : ''}>›</button>
      </div>`;
  }

  _hasOfficialImage(p) {
    const h = p.hierarchy;
    return ['cluster', 'rack', 'tray', 'server'].some(lvl => {
      const node = h[lvl];
      return node && node.official_image && node.official_image.status === 'found';
    });
  }

  _cardHTML(p, { selectedId, compareId, highlightActive, matchesHighlight, compareMode, highlightMemType }) {
    const isSelected = p.platform_id === selectedId;
    const isCompare  = p.platform_id === compareId;
    const matches    = matchesHighlight(p);
    const dimmed     = highlightActive && !matches && !isSelected && !isCompare;

    const vendorClass = `vendor-${p.vendor.toLowerCase().replace(/\s+/g, '-')}`;
    let cardClass = '';
    if (isSelected) cardClass += ' selected';
    else if (isCompare) cardClass += ' selected-compare';
    if (dimmed) cardClass += ' dimmed';
    if (highlightActive && matches) cardClass += ' highlighted';

    const hostMem  = p.memory_summary.host_mem_type;
    const accelMem = p.memory_summary.accel_mem_type;

    const highlightColor = highlightActive ? memColor(highlightMemType) : null;
    const borderStyle    = (highlightActive && matches)
      ? `style="--highlight-color:${highlightColor};"` : '';

    const pulsing = highlightActive && matches;

    return `
      <div class="platform-card ${cardClass}" data-id="${p.platform_id}" ${borderStyle}>
        <div class="card-vendor-bar ${vendorClass}"></div>
        <div class="card-top">
          <div>
            <div class="card-name">${p.display_name}</div>
            <div class="card-gen">${p.generation.generation_name} · ${p.generation.ga_year}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
            <span class="card-category-badge${p.category === 'AI_SV' ? ' ai' : ''}">${p.category.replace('_', ' ')}</span>
            ${this._hasOfficialImage(p) ? '<span class="card-img-badge" title="공식 이미지 있음">📷</span>' : ''}
            ${isCompare ? '<span class="card-compare-label">B</span>' : ''}
            ${isSelected && compareMode ? '<span class="card-compare-label" style="color:var(--accent-hover)">A</span>' : ''}
          </div>
        </div>
        <div class="card-vendor text-xs text-muted">${p.vendor} · ${p.customer}</div>
        <div class="card-mem-row">
          ${memBadgeHTML(hostMem, pulsing && hostMem === highlightMemType ? 'pulsing' : '')}
          ${accelMem ? memBadgeHTML(accelMem, pulsing && accelMem === highlightMemType ? 'pulsing' : '') : ''}
        </div>
      </div>`;
  }
}
