/* sr-modal-wiring.v3.js
 * - 기존 모달 로직은 건드리지 않고, 채널 셀만 안전하게 다시 연결
 * - 채널 ID/URL 추출, 상대/절대 경로/여러 패턴( /channel/UC…, /@handle, /user/…, /c/… ) 모두 대응
 * - 가능한 값(UCID > @handle > URL) 우선순으로 모달에 전달, 모두 없으면 alert
 */

(function () {
  if (window.__SR_WIRING_V3_LOADED__) return;
  window.__SR_WIRING_V3_LOADED__ = true;

  const CSS = `
  .sr-chan-hover { cursor:pointer; text-decoration: underline; text-decoration-style: dotted; }
  `;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // ====== 모달 호출 래퍼 ======
  function openChannelModalSafe(idOrRef, chTitle) {
    const title = chTitle || '';
    const call =
      window.showChannelModal ||
      window.openChannelModal ||
      window.openChannelDetail || null;

    if (call) {
      try {
        // 보통 ID만 받지만, 일부는 (id,title) 도 받으므로 대응
        call.length >= 2 ? call(idOrRef, title) : call(idOrRef);
        return;
      } catch (e) {
        console.warn('channel modal call failed, fallback to alert', e);
      }
    }
    alert(`채널: ${title || '(제목 미탐지)'}\nID/참조: ${idOrRef || '(ID 미탐지)'}`);
  }

  // ====== href에서 채널 식별값 추출 ======
  function parseChannelIdOrRefFromHref(href) {
    if (!href) return null;
    let u;
    try {
      u = new URL(href, location.origin); // 상대/절대 모두 파싱
    } catch {
      return null;
    }
    const seg = u.pathname.split('/').filter(Boolean);

    // /channel/UCxxxx
    const chIdx = seg.indexOf('channel');
    if (chIdx >= 0 && seg[chIdx + 1]) {
      const maybeUC = seg[chIdx + 1];
      if (/^UC[0-9A-Za-z_-]{20,}$/.test(maybeUC)) return maybeUC; // UCID
      // 그래도 channel 다음 값이 있으면 우선 반환
      return maybeUC;
    }

    // /@handle  혹은 경로 어딘가에 @handle
    const handle = seg.find(s => s.startsWith('@'));
    if (handle) return handle; // @handle

    // /user/…, /c/… → UCID 아님. 그래도 전체 URL 참고값으로 반환(모달에서 변환할 수도 있음)
    if (seg.includes('user') || seg.includes('c')) return u.href;

    // 마지막 수단: youtube 도메인이면 전체 URL을 반환
    if (/youtube\.com/.test(u.hostname)) return u.href;

    return null;
  }

  // ====== 같은 행에서 채널 ID/참조 최대한 복원 ======
  function extractChannelRefFromRow(tr) {
    if (!tr) return null;

    // 1) data-* 속성
    const keys = ['ch','channelId','channel','ytChannelId','yt_channel','chid','channelid'];
    for (const k of keys) {
      const v = tr.dataset?.[k];
      if (v) return v.trim();
    }
    const tds = Array.from(tr.children || []);
    for (const td of tds) {
      for (const k of keys) {
        const v = td.dataset?.[k];
        if (v) return v.trim();
      }
      const el = td.querySelector('[data-ch],[data-channel-id],[data-channel],[data-yt-channel-id],[data-chid],[data-channelid]');
      if (el) {
        const v =
          el.dataset.ch || el.dataset.channelId || el.dataset.channel ||
          el.dataset.ytChannelId || el.dataset.chid || el.dataset.channelid;
        if (v) return v.trim();
      }
    }

    // 2) 채널 관련 a/link 태그들 검사(상대/절대 모두)
    const anchors = tr.querySelectorAll('a,[data-href], [href]');
    for (const a of anchors) {
      const href = a.getAttribute('href') || a.getAttribute('data-href');
      const ref = parseChannelIdOrRefFromHref(href);
      if (ref) return ref;
    }

    return null;
  }

  // ====== 테이블의 채널 컬럼 찾기(헤더 텍스트로 탐지) ======
  function findChannelColumnIndex(table) {
    const ths = table.querySelectorAll('thead th');
    if (!ths.length) return -1;
    for (let i = 0; i < ths.length; i++) {
      const txt = (ths[i].innerText || ths[i].textContent || '').trim();
      if (/채널/.test(txt)) return i;
    }
    return -1;
  }

  // ====== 채널 셀 꾸미기 ======
  function decorateChannelCells(container) {
    const tables = container.querySelectorAll('table');
    tables.forEach(table => {
      const col = findChannelColumnIndex(table);
      if (col < 0) return;
      const rows = table.querySelectorAll('tbody tr');
      rows.forEach(tr => {
        const tds = tr.children;
        if (!tds || !tds[col]) return;
        tds[col].classList.add('sr-chan-hover');
      });
    });
  }

  // 초기 장식 및 DOM 변경 추적
  decorateChannelCells(document);
  const mo = new MutationObserver(() => decorateChannelCells(document));
  mo.observe(document.body, { childList: true, subtree: true });

  // ====== 클릭 위임 ======
  document.addEventListener('click', (e) => {
    const td = e.target.closest('td');
    if (!td) return;
    const table = td.closest('table');
    if (!table) return;

    const col = findChannelColumnIndex(table);
    if (col < 0) return;

    const tr = td.closest('tr');
    if (!tr) return;

    const idx = Array.prototype.indexOf.call(tr.children, td);
    if (idx !== col) return; // 채널 컬럼 외 무시

    e.preventDefault();
    e.stopPropagation();

    const link = td.querySelector('a,[href]');
    const title = (link?.innerText || td.innerText || '').trim();

    const ref = extractChannelRefFromRow(tr);

    // 디버그 로그(원하시면 주석 처리)
    console.debug('[sr-modal-wiring.v3] click channel', { title, ref, tr });

    openChannelModalSafe(ref, title);
  }, true);

  // 간단 진단
  window.__srModalProbe = function () {
    const tables = document.querySelectorAll('table');
    const info = [];
    tables.forEach((t, i) => {
      info.push({ idx: i, channelColumn: findChannelColumnIndex(t), rows: t.querySelectorAll('tbody tr').length });
    });
    console.table(info);
    return info;
  };

  console.log('[sr-modal-wiring.v3] loaded');
})();
