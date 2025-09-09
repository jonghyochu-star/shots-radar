
/*! Shorts Radar — Inline Click-to-Select Patch (v7, belt & suspenders)
 *  - Drop-in: <script src="./sr-patch-pickpill.inline.v7.js"></script>
 *  - No template edits required.
 *  - Adds click/Enter/Space on key pills to switch NOW, even if other code stops propagation.
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

  function pills(){
    const holder = document.getElementById('keyState');
    if(!holder) return [];
    const list = [...holder.querySelectorAll('.pill')].filter(el => /yt_api_key/i.test(el.textContent||''));
    return list;
  }

  function pillIndex(pill, fallbackDomIdx=0){
    const m = (pill.querySelector('b')?.textContent || pill.textContent || '').match(/yt_api_key\s*(\d+)/i);
    if (m) return Math.max(0, parseInt(m[1],10)-1);
    const list = pills();
    const i = list.indexOf(pill);
    return i>=0 ? i : fallbackDomIdx;
  }

  function attachInline(el, idx){
    el.setAttribute('role','button'); el.setAttribute('tabindex','0');
    el.setAttribute('onclick', `window._pickKey(${idx})`);
    el.setAttribute('onkeydown', `if(event.key==='Enter'||event.key===' '||event.code==='Space'){event.preventDefault();window._pickKey(${idx});}`);
  }

  function wirePills(){
    const list = pills();
    list.forEach((el, i)=>{
      const idx = pillIndex(el, i);
      attachInline(el, idx);
      // also children (e.g., <b>, badges) to bypass bubble blockers
      el.querySelectorAll('*').forEach(child=>{
        if (child instanceof HTMLElement) {
          child.setAttribute('onclick', `window._pickKey(${idx})`);
          child.setAttribute('onkeydown', `if(event.key==='Enter'||event.key===' '||event.code==='Space'){event.preventDefault();window._pickKey(${idx});}`);
        }
      });
    });
  }

  function findPillFromEvent(ev){
    // Prefer composedPath for shadow-dom safe traversal
    const path = (typeof ev.composedPath === 'function') ? ev.composedPath() : [];
    for (const n of path){
      if (n && n.nodeType===1 && n.matches && n.matches('.pill') && /yt_api_key/i.test(n.textContent||'')) return n;
    }
    // fallback
    const t = ev.target && ev.target.closest ? ev.target.closest('.pill') : null;
    return (t && /yt_api_key/i.test(t.textContent||'')) ? t : null;
  }

  function captureHandler(ev){
    // Key activation
    if (ev.type==='keydown'){
      if (ev.key!=='Enter' && ev.key!==' ' && ev.code!=='Space') return;
    } else {
      // Pointer/click activation: only main button
      if (ev.button !== undefined && ev.button !== 0) return;
    }
    const pill = findPillFromEvent(ev);
    if (!pill) return;
    const list = pills();
    const idx = pillIndex(pill, list.indexOf(pill));
    if (idx>=0){
      ev.preventDefault();
      // Do not stop propagation to avoid side effects, but ensure we act
      try{ window._pickKey(idx); }catch(e){}
    }
  }

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

  function init(){
    injectCSS();
    ensureGlobalPick();
    hookRender();
    wirePills();
    const obs = new MutationObserver(()=>{ try{ wirePills(); }catch(e){} });
    obs.observe(document.documentElement, { childList:true, subtree:true });

    // Capture-level safety net
    ['pointerdown','click','keydown'].forEach(t=>{
      document.addEventListener(t, captureHandler, true);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Late bindings retry
  let tries = 0;
  const t = setInterval(()=>{
    tries++;
    try { hookRender(); wirePills(); } catch(e){}
    if (tries > 20) clearInterval(t);
  }, 250);
})();
