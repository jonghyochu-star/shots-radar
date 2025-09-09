
/*! Shorts Radar - Click-to-Select Key Pill Patch (v4, pointer & dual-index)
 *  - Click/Enter/Space or PointerUp on a key pill selects that key as NOW
 *  - Index detection: 1) parse "yt_api_keyN" label, 2) fallback to DOM order
 *  - Survives re-render; no dependency on container id
 */
(function () {
  const STYLE_ID = 'sr-patch-pickpill-style';
  const CSS = `.pill[role="button"]{cursor:pointer;user-select:none}
               .pill[role="button"]:hover{outline:1px dashed #2a4156}`;

  function injectCSS() {
    if (!document.getElementById(STYLE_ID)) {
      const el = document.createElement('style'); el.id = STYLE_ID;
      el.textContent = CSS.replace(/\s+/g,' ');
      document.head.appendChild(el);
    }
  }

  function pills() {
    const list = [...document.querySelectorAll('.pill')]
      .filter(el => /yt_api_key/i.test(el.textContent||''));
    list.forEach(p => { p.setAttribute('role','button'); p.setAttribute('tabindex','0'); });
    return list;
  }

  function parseIdx(el){
    const label = (el.querySelector('b')?.textContent || el.textContent || '').trim();
    const m = label.match(/yt_api_key\s*(\d+)/i);
    if (m) return Math.max(0, parseInt(m[1],10)-1);
    const arr = pills();                       // fallback: visible order
    const n = arr.indexOf(el);
    return n>=0 ? n : -1;
  }

  function reorderTo(idx){
    const keys = JSON.parse(localStorage.getItem('yt_api_keys')||'[]');
    if (!(idx>=0 && idx<keys.length)) return;
    const key = keys[idx];
    const next = [key, ...keys.filter((_,i)=>i!==idx)];
    localStorage.setItem('yt_api_keys', JSON.stringify(next));
    const stat = JSON.parse(localStorage.getItem('sr_keyStat')||'{}');
    if (stat[key]) { stat[key].blocked=false; stat[key].fail=0; }
    localStorage.setItem('sr_keyStat', JSON.stringify(stat));
    if (typeof ROT!=='undefined' && ROT && typeof ROT.load==='function') ROT.load();
    else setTimeout(()=>location.reload(), 0);
  }

  function activateFrom(ev){
    const el = ev.target && ev.target.closest ? ev.target.closest('.pill') : null;
    if (!el) return;
    if (!/yt_api_key/i.test(el.textContent||'')) return;
    if (ev.type==='keydown'){
      if (ev.key!=='Enter' && ev.key!==' ' && ev.code!=='Space') return;
      ev.preventDefault();
    }
    const idx = parseIdx(el);
    if (idx>=0) reorderTo(idx);
  }

  function observe(){
    const obs = new MutationObserver(()=>pills());
    obs.observe(document.documentElement, {childList:true, subtree:true});
  }

  function init(){
    injectCSS(); pills(); observe();
    // Use capture to avoid being swallowed by other handlers
    document.addEventListener('pointerup', activateFrom, true);
    document.addEventListener('click',      activateFrom, true);
    document.addEventListener('keydown',    activateFrom, true);
  }

  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
