export class GenerationNav {
  constructor(wrapperEl, navEl, { onGenSelect }) {
    this.wrapper = wrapperEl;
    this.el = navEl;
    this.onGenSelect = onGenSelect;
    this.families = [];
    this.currentPlatform = null;
    this.currentFamilyId = null;
  }

  setData(families) {
    this.families = families;
  }

  show(platform) {
    this.currentPlatform = platform;
    this.currentFamilyId = platform?.generation?.family || null;
    if (!this.currentFamilyId) {
      this.wrapper.classList.remove('visible');
      return;
    }
    this._render();
    this.wrapper.classList.add('visible');
  }

  hide() {
    this.wrapper.classList.remove('visible');
    this.currentPlatform = null;
  }

  _render() {
    const family = this.families.find(f => f.id === this.currentFamilyId);
    if (!family) return;

    const currentGenName = this.currentPlatform?.generation?.generation_name;

    this.el.innerHTML = `
      <span class="gen-nav-family">${family.name}</span>
      <div class="gen-nav-timeline">
        ${this._timelineHTML(family, currentGenName)}
      </div>`;

    this.el.querySelectorAll('.gen-node-btn[data-platform]').forEach(btn => {
      btn.addEventListener('click', () => {
        const pid = btn.dataset.platform;
        if (pid) this.onGenSelect(pid);
      });
    });
  }

  _timelineHTML(family, currentGenName) {
    return family.generations.map((gen, i) => {
      const isCurrent  = gen.name === currentGenName;
      const hasPlatform = gen.platform_ids?.length > 0;
      const firstPid   = gen.platform_ids?.[0] || null;
      const connector  = i > 0
        ? `<div class="gen-connector ${gen.tbd ? 'dashed' : 'solid'}"></div>`
        : '';

      const btnClass = [
        'gen-node-btn',
        isCurrent   ? 'current'      : '',
        hasPlatform ? 'has-platform' : '',
        gen.tbd     ? 'tbd'          : '',
      ].filter(Boolean).join(' ');

      const color = family.color || '#6366f1';

      return `
        ${connector}
        <div class="gen-node">
          <button
            class="${btnClass}"
            data-platform="${firstPid || ''}"
            style="--gen-color:${color}"
            title="${gen.name}${gen.tbd ? ' (예정)' : ''}"
            ${!hasPlatform || isCurrent ? 'disabled' : ''}
          >
            <div class="gen-dot"></div>
            <div class="gen-label">${gen.name}</div>
            <div class="gen-year">${gen.year}</div>
          </button>
        </div>`;
    }).join('');
  }
}
