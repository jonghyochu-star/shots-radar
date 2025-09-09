
/*! Shorts Radar - Click-to-Select Key Pill Patch (v3, numeric label parser)
 *  - Click/Enter/Space on a "yt_api_keyN" pill selects that N-th key as NOW
 *  - Robust to re-renders; no dependency on container id
 */
(function () {
  const STYLE_ID = 'sr-patch-pickpill-style';
  const CSS = `.pill[role="button"]{cursor:pointer;user-select:none}
               .pill[role="button"]:hover{outline:1px dashed #2a4156}`;

  function injectCSS() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style'); el.id = STYLE_ID;
    el.textContent = CSS.replace(/\s+/g,' ');
    document.head.appendChild(el);
  }

  function parseIndexFrom(el){
    // Prefer the bold label <b>yt_api_keyN</b>
    const label = (el.querySelector('b')?.textContent || el.textContent || '').trim();
    const m = label.match(/yt_api_key(\d+)/i);
    if(!m) return -1;
    return Math.max(0, parseInt(m[1],10)-1);
  }

  function pickByIndex(idx) {
    try{
      const keys = JSON.parse(localStorage.getItem('yt_api_keys')||'[]');
      if(!(idx>=0 && idx<keys.length)) return;
      const key = keys[idx];
      const next = [key, ...keys.filter((_,i)=>i!==idx)];
      localStorage.setItem('yt_api_keys', JSON.stringify(next));
      const stat = JSON.parse(localStorage.getItem('sr_keyStat')||'{}');
      if(stat[key]){ stat[key].blocked=false; stat[key].fail=0; }
      localStorage.setItem('sr_keyStat', JSON.stringify(stat));
      if(typeof ROT!=='undefined' && ROT && typeof ROT.load==='function') ROT.load();
      else location.reload();
    }catch(e){ console.warn('pickpill v3 error', e); }
  }

  function handleActivate(ev){
    const pill = ev.target.closest?.('.pill');
    if(!pill) return;
    // Only key pills
    const txt = pill.textContent || '';
    if(!/yt_api_key/i.test(txt)) return;
    if(ev.type==='keydown'){
      if(ev.key!=='Enter' && ev.key!==' ' && ev.code!=='Space') return;
      ev.preventDefault();
    }
    const idx = parseIndexFrom(pill);
    if(idx>=0) pickByIndex(idx);
  }

  function primeARIA(){
    document.querySelectorAll('.pill').forEach(p=>{
      if(/yt_api_key/i.test(p.textContent||'')){
        p.setAttribute('role','button'); p.setAttribute('tabindex','0');
      }
    });
  }

  function observe(){
    const obs = new MutationObserver(()=>primeARIA());
    obs.observe(document.documentElement, {childList:true, subtree:true});
  }

  function init(){
    injectCSS();
    primeARIA();
    observe();
    document.addEventListener('click', handleActivate, true);
    document.addEventListener('keydown', handleActivate, true);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
