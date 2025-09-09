
/*! Shorts Radar - Click-to-Select Key Pill Patch (v2, robust)
 *  - Click or Enter/Space on a key pill (yt_api_key1..N) switches NOW to that key
 *  - Works even if the container id differs or re-renders (MutationObserver + delegation)
 *  - Keeps existing rotation logic intact
 */
(function () {
  const STYLE_ID = 'sr-patch-pickpill-style';
  const CSS = `.pill[role="button"]{cursor:pointer;user-select:none}
               .pill[role="button"]:hover{outline:1px dashed #2a4156}`;

  function injectCSS() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style'); el.id = STYLE_ID;
    el.textContent = CSS.replace(/\s+/g, ' ');
    document.head.appendChild(el);
  }

  // Return the live list of key pills in the current DOM (order-sensitive)
  function getPills() {
    // Prefer an explicit container if present
    const keyWrap = document.getElementById('keyState');
    let pills = keyWrap ? keyWrap.querySelectorAll('.pill') : document.querySelectorAll('.pill');
    // Convert NodeList -> Array and keep only pills that look like key pills
    const arr = [...pills].filter(el => /\byt_api_key\d+\b/.test(el.textContent||''));
    // Add minimal ARIA attrs (no harm if repeated)
    arr.forEach(p => { p.setAttribute('role','button'); p.setAttribute('tabindex','0'); });
    return arr;
  }

  function pickByIndex(idx) {
    try {
      const keys = JSON.parse(localStorage.getItem('yt_api_keys') || '[]');
      if (!(idx >= 0 && idx < keys.length)) return;
      const key = keys[idx];
      const next = [key, ...keys.filter((_, i) => i !== idx)];
      localStorage.setItem('yt_api_keys', JSON.stringify(next));
      const stat = JSON.parse(localStorage.getItem('sr_keyStat') || '{}');
      if (stat[key]) { stat[key].blocked = false; stat[key].fail = 0; }
      localStorage.setItem('sr_keyStat', JSON.stringify(stat));
      if (typeof ROT !== 'undefined' && ROT && typeof ROT.load === 'function') ROT.load();
      else location.reload();
    } catch (e) { console.warn('pickpill v2 error', e); }
  }

  // Delegated handlers (document-level to survive re-renders)
  function onClick(ev) {
    const el = ev.target.closest('.pill');
    if (!el) return;
    // Only act on key pills
    if (!/\byt_api_key\d+\b/.test(el.textContent||'')) return;
    const pills = getPills();
    const idx = pills.indexOf(el);
    if (idx !== -1) pickByIndex(idx);
  }

  function onKey(ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ' && ev.code !== 'Space') return;
    const el = ev.target.closest('.pill');
    if (!el || !/\byt_api_key\d+\b/.test(el.textContent||'')) return;
    ev.preventDefault();
    const pills = getPills();
    const idx = pills.indexOf(el);
    if (idx !== -1) pickByIndex(idx);
  }

  // Observe re-renders to reapply ARIA attrs (harmless no-op if unchanged)
  function observe() {
    const obs = new MutationObserver(() => { getPills(); });
    obs.observe(document.documentElement, {subtree:true, childList:true});
  }

  function init() {
    injectCSS();
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    observe();
    // First run
    getPills();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
