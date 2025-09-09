
/*! Shorts Radar - Click-to-Select Key Pill Patch (v1)
 *  - Adds click/keyboard selection on key pills (yt_api_key1~N)
 *  - Keeps existing rotation logic intact (success=stick, fail=rotate)
 *  - No changes to templates; works by delegation & sibling index
 */
(function () {
  const CSS = `.pill[role="button"]{cursor:pointer;user-select:none}
               .pill[role="button"]:hover{outline:1px dashed #2a4156}`;
  function injectCSS() {
    try {
      const el = document.createElement('style');
      el.id = 'sr-patch-pickpill-style';
      el.textContent = CSS.replace(/\s+/g,' ');
      document.head.appendChild(el);
    } catch (e) {}
  }

  function reorderTo(idx) {
    try {
      const keys = JSON.parse(localStorage.getItem('yt_api_keys') || '[]');
      if (!(idx >= 0 && idx < keys.length)) return;
      const key = keys[idx];
      const next = [key, ...keys.filter((_, i) => i !== idx)];
      localStorage.setItem('yt_api_keys', JSON.stringify(next));
      // On manual pick, un-block the chosen key so it can be used immediately
      const stat = JSON.parse(localStorage.getItem('sr_keyStat') || '{}');
      if (stat[key]) { stat[key].blocked = false; stat[key].fail = 0; }
      localStorage.setItem('sr_keyStat', JSON.stringify(stat));
      if (typeof ROT !== 'undefined' && ROT && typeof ROT.load === 'function') {
        ROT.load();
      } else {
        location.reload();
      }
    } catch (e) { console.warn('pickpill reorder error', e); }
  }

  function bind() {
    const wrap = document.getElementById('keyState');
    if (!wrap) return;
    // add ARIA-ish role for accessibility/look without changing template
    const pills = wrap.querySelectorAll('.pill');
    pills.forEach(p => { p.setAttribute('role','button'); p.setAttribute('tabindex','0'); });

    // Delegate click
    wrap.addEventListener('click', (ev) => {
      const el = ev.target.closest('.pill');
      if (!el) return;
      const list = [...wrap.querySelectorAll('.pill')];
      const idx = list.indexOf(el);
      if (idx !== -1) reorderTo(idx);
    });

    // Keyboard (Enter/Space)
    wrap.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ' && ev.code !== 'Space') return;
      const el = ev.target.closest('.pill');
      if (!el) return;
      ev.preventDefault();
      const list = [...wrap.querySelectorAll('.pill')];
      const idx = list.indexOf(el);
      if (idx !== -1) reorderTo(idx);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { injectCSS(); bind(); });
  } else {
    injectCSS(); bind();
  }
})();
