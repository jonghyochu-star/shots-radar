
/*! Shorts Radar - Click-to-Select Key Pill Patch (v5, direct bind + rescan)
 *  - Adds click/Enter/Space on each key pill to switch NOW
 *  - Binds directly to each pill (capture+bubble), keeps re-binding on DOM changes
 */
(function(){
  const STYLE_ID = 'sr-patch-pickpill-style';
  const CSS = `.pill[role="button"]{cursor:pointer;user-select:none}
               .pill[role="button"]:hover{outline:1px dashed #2a4156}`;

  function injectCSS(){
    if(document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style'); st.id = STYLE_ID;
    st.textContent = CSS.replace(/\s+/g,' ');
    document.head.appendChild(st);
  }

  function parseIdxFrom(el){
    const label = (el.querySelector('b')?.textContent || el.textContent || '').trim();
    const m = /yt_api_key\s*(\d+)/i.exec(label);
    return m ? Math.max(0, parseInt(m[1],10)-1) : -1;
  }

  function getKeys(){
    try { return JSON.parse(localStorage.getItem('yt_api_keys')||'[]'); }
    catch(e){ return []; }
  }

  function reorderTo(idx){
    const keys = getKeys();
    if(!(idx>=0 && idx<keys.length)) return;
    const key = keys[idx];
    const next = [key, ...keys.filter((_,i)=>i!==idx)];
    localStorage.setItem('yt_api_keys', JSON.stringify(next));
    const stat = JSON.parse(localStorage.getItem('sr_keyStat')||'{}');
    if(stat[key]){ stat[key].blocked=false; stat[key].fail=0; }
    localStorage.setItem('sr_keyStat', JSON.stringify(stat));
    if(typeof ROT!=='undefined' && ROT && typeof ROT.load==='function') ROT.load();
    else location.reload();
  }

  function bindPill(el, idxComputed){
    if(el.__srBound) return;
    el.__srBound = true;
    el.setAttribute('role','button'); el.setAttribute('tabindex','0');
    // store a fixed index attribute for fallback
    el.dataset.srIdx = String(idxComputed);

    const handler = (ev)=>{
      if(ev.type==='keydown'){
        if(ev.key!=='Enter' && ev.key!==' ' && ev.code!=='Space') return;
        ev.preventDefault();
      }
      const idxByAttr = Number(el.dataset.srIdx);
      const idxByLabel = parseIdxFrom(el);
      const idx = Number.isFinite(idxByLabel) && idxByLabel>=0 ? idxByLabel
                : (Number.isFinite(idxByAttr) ? idxByAttr : -1);
      if(idx>=0) reorderTo(idx);
    };

    ['click','pointerup'].forEach(t=>{
      el.addEventListener(t, handler, true);   // capture
      el.addEventListener(t, handler, false);  // bubble
    });
    el.addEventListener('keydown', handler, true);
  }

  function scanAndBind(){
    // find visible key pills in order
    const list = [...document.querySelectorAll('.pill')]
      .filter(el => /yt_api_key/i.test(el.textContent||''));
    list.forEach((el, i)=> bindPill(el, i));
  }

  function init(){
    injectCSS();
    scanAndBind();
    const obs = new MutationObserver(()=>scanAndBind());
    obs.observe(document.documentElement, {childList:true, subtree:true});
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
