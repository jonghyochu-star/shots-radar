
/*! Shorts Radar — Inline Click-to-Select Patch (v6)
 *  - One-file drop-in: <script src="./sr-patch-pickpill.inline.v6.js"></script>
 *  - No template edits required.
 *  - Adds click/Enter/Space on key pills (yt_api_key1..N) to switch NOW.
 *  - Hooks renderKeyState() to rewire pills after every render.
 */
(function(){
  const STYLE_ID = 'sr-patch-pickpill-inline-style';

  function injectCSS(){
    if (document.getElementById(STYLE_ID)) return;
    const css = `.pill[role="button"]{cursor:pointer;user-select:none}
                 .pill[role="button"]:hover{outline:1px dashed #2a4156}`.replace(/\s+/g,' ');
    const el = document.createElement('style');
    el.id = STYLE_ID; el.textContent = css; document.head.appendChild(el);
  }

  // Global pick function (used by inline handlers we attach below)
  function ensureGlobalPick(){
    if (typeof window._pickKey === 'function') return;
    window._pickKey = function(i){
      try{
        const keys = JSON.parse(localStorage.getItem('yt_api_keys')||'[]');
        if(!(i>=0 && i<keys.length)) return;
        const key  = keys[i];
        const next = [key, ...keys.filter((_,j)=>j!==i)];
        localStorage.setItem('yt_api_keys', JSON.stringify(next));
        const stat = JSON.parse(localStorage.getItem('sr_keyStat')||'{}');
        if(stat[key]){ stat[key].blocked = false; stat[key].fail = 0; }
        localStorage.setItem('sr_keyStat', JSON.stringify(stat));
        try{ if (window.ROT && typeof ROT.load==='function') ROT.load(); else location.reload(); }
        catch(e){ location.reload(); }
      }catch(e){ console.error('[pickKey]', e); }
    };
  }

  // Find all key pills and attach inline handlers (so bubbling blockers can't stop it)
  function wirePills(){
    const holder = document.getElementById('keyState');
    if(!holder) return;
    const nodes = holder.querySelectorAll('.pill');
    if(!nodes || !nodes.length) return;
    const arr = Array.from(nodes).filter(el => /yt_api_key/i.test(el.textContent||''));
    arr.forEach((el,domIdx)=>{
      // label-index first
      const m = (el.querySelector('b')?.textContent || el.textContent || '').match(/yt_api_key\s*(\d+)/i);
      const idx = m ? Math.max(0, parseInt(m[1],10)-1) : domIdx;

      el.setAttribute('role','button'); el.setAttribute('tabindex','0');
      // Attach inline attributes so they run regardless of other listeners
      el.setAttribute('onclick', `window._pickKey(${idx})`);
      el.setAttribute('onkeydown', `if(event.key==='Enter'||event.key===' '||event.code==='Space'){event.preventDefault();window._pickKey(${idx});}`);
    });
  }

  // Hook renderKeyState to rewire after each call
  function hookRender(){
    const g = window;
    const name = 'renderKeyState';
    if (typeof g[name] !== 'function' || g[name].__srHooked) return;
    const orig = g[name];
    const patched = function(...args){
      const r = orig.apply(this, args);
      try{ wirePills(); }catch(e){}
      return r;
    };
    patched.__srHooked = true;
    g[name] = patched;
  }

  function observeRenders(){
    const obs = new MutationObserver(()=>{ try{ wirePills(); }catch(e){} });
    obs.observe(document.documentElement, { childList:true, subtree:true });
  }

  function tryInit(){
    try{
      injectCSS();
      ensureGlobalPick();
      hookRender();
      wirePills();
      observeRenders();
    }catch(e){ console.warn('inline patch init error', e); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInit);
  } else {
    tryInit();
  }

  // Also retry a few times in case the function is defined later
  let tries = 0;
  const t = setInterval(()=>{
    tries++;
    try { hookRender(); wirePills(); } catch(e){}
    if (tries > 20) clearInterval(t);
  }, 250);
})();
