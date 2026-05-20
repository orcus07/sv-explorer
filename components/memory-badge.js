export const MEM_LABELS = {
  DDR5_RDIMM:      'DDR5 RDIMM',
  DDR4_RDIMM:      'DDR4 RDIMM',
  LPDDR5X_SOCAMM2: 'LPDDR5X SOCAMM2',
  HBM3e:           'HBM3e',
  HBM3:            'HBM3',
  HBM2e:           'HBM2e',
  HBM2:            'HBM2',
  GDDR6:           'GDDR6',
  SRAM:            'SRAM',
};

export function memBadgeHTML(memType, extra = '') {
  if (!memType) return '';
  const label = MEM_LABELS[memType] || memType;
  return `<span class="mem-badge ${memType}${extra ? ' ' + extra : ''}" title="${label}">
    <span class="mem-badge-dot ${memType}"></span>${label}
  </span>`;
}

export function memColor(memType) {
  const map = {
    DDR5_RDIMM:      '#3b82f6',
    DDR4_RDIMM:      '#93c5fd',
    LPDDR5X_SOCAMM2: '#a855f7',
    HBM3e:           '#ef4444',
    HBM3:            '#f87171',
    HBM2e:           '#fb923c',
    HBM2:            '#fbbf24',
    GDDR6:           '#10b981',
    SRAM:            '#e879f9',
  };
  return map[memType] || '#8888aa';
}
