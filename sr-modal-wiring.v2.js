/* sr-modal-wiring.v2.js
 * - 기존 모달 로직은 건드리지 않고, 채널 셀만 안전하게 다시 연결
 * - 채널 ID 추출 우선순위:
 *   (1) data-ch / data-channel-id / data-channel
 *   (2) 같은 행의 /channel/UC... 링크
 *   (3) @handle 링크(핸들은 모달이 ID만 받는 구조면 fallback)
 */

(function () {
  if (window.__SR_WIRING_V2_LOADED__) return;
  window.__SR_WIRING_V2_LOADED__ = true;

  const CSS = `
  /* 채널 셀에 포인터/점선 밑줄 */
  .sr-chan-hover { cursor:pointer; text-decoration: underline; text-decoration-style: dotted; }
  `;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // 모달 호출 래퍼 : 기존 함수만 호출, 없으면 alert
  function openChannelModalSafe(chId, chTitle) {
    const title = chTitle || '';
    const call = (
      window.showChannelModal ||
      window.openChannelModal ||
      window.openChannelDetail ||
      null
    );
    if (call) {
      try {
        // 보통은 ID만 받지만, 제목을 받는 버전도 있어서 두 형태 모두 시도
        call.length >= 2 ? call(chId, title) : call(chId);
        return;
      } catch (e) {
        console.warn('channel modal call failed, fallback to alert', e);
      }
    }
    alert(`채널: ${title || '(제목 미탐지)'}\nID: ${chId || '(ID 미탐지)'}`);
  }

  // 같은 행에서 채널 ID 최대한 복원
  function extractChannelIdFromRow(tr) {
    if (!tr) return null;

    // 1) data-속성
    const attrs = ['ch', 'channelId', 'channel', 'ytChannelId', 'yt_channel'];
    for (const a of attrs) {
      const v = tr.dataset?.[a];
      if (v) return v.trim();
    }
    // td에도 달려 있을 수 있음
    const tds = Array.from(tr.children || []);
    for (const td of tds) {
      for (const a of attrs) {
        const v = td.dataset?.[a];
        if (v) return v.trim();
      }
      const linkWithData = td.querySelector('[data-ch],[data-channel-id],[data-channel],[data-yt-channel-id]');
      if (linkWithData) {
        const v = linkWithData.dataset.ch
          || linkWithData.dataset.channelId
          || linkWithData.dataset.channel
          || linkWithData.dataset.ytChannelId;
        if (v) return v.trim();
      }
    }

    // 2) /channel/UC… 형태 링크
    const aChannel = tr.querySelector('a[href*="/channel/"]');
    if (aChannel) {
      try {
        const u = new URL(aChannel.href, location.origin);
        const seg = u.pathname.split('/').filter(Boolean);
        // /channel/UCxxxxx
        const idx = seg.indexOf('channel');
        if (idx >= 0 && seg[idx + 1]) return seg[idx + 1];
      } catch {}
    }

    // 3) @handle → 핸들만 반환(모달이 ID만 받으면 fallback)
    const aHandle = tr.querySelector('a[href*="://www.youtube.com/@"]');
    if (aHandle) {
      try {
        const u = new URL(aHandle.href, location.origin);
        const handle = u.pathname.split('/').find(p => p.startsWith('@'));
        if (handle) return handle; // @handle
      } catch {}
    }

    return null;
  }

  // 테이블 안 채널 컬럼을 동적으로 판별 (헤더에 "채널" 글자가 있는 열)
  function findChannelColumnIndex(table) {
    const ths = table.querySelectorAll('thead th');
    if (!ths.length) return -1;
    for (let i = 0; i < ths.length; i++) {
      const txt = (ths[i].innerText || ths[i].textContent || '').trim();
      if (/채널/.test(txt)) return i;
    }
    return -1;
  }

  // 채널 셀에 hover 클래스 부여
  function decorateChannelCells(container) {
    const tables = container.querySelectorAll('table');
    tables.forEach(table => {
      const chIdx = findChannelColumnIndex(table);
      if (chIdx < 0) return;

      const rows = table.querySelectorAll('tbody tr');
      rows.forEach(tr => {
        const tds = tr.children;
        if (!tds || !tds.length || !tds[chIdx]) return;
        const td = tds[chIdx];
        td.classList.add('sr-chan-hover');
      });
    });
  }

  // 초기 장식 + DOM 변경 추적
  const root = document;
  decorateChannelCells(root);

  const mo = new MutationObserver(() => {
    decorateChannelCells(root);
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // 이벤트 위임 (테이블 어디서든 채널 셀 클릭 잡기)
  document.addEventListener('click', (e) => {
    const td = e.target.closest('td');
    if (!td) return;

    const table = td.closest('table');
    if (!table) return;

    const chIdx = findChannelColumnIndex(table);
    if (chIdx < 0) return;

    const tr = td.closest('tr');
    if (!tr) return;

    const idx = Array.prototype.indexOf.call(tr.children, td);
    if (idx !== chIdx) return;          // 채널 컬럼이 아니면 무시

    // 여기까지 왔으면 채널 셀 클릭
    e.preventDefault();
    e.stopPropagation();

    // 제목/표시명
    const link = td.querySelector('a');
    const title = (link?.innerText || td.innerText || '').trim();

    // 채널 ID/핸들 추출
    const chId = extractChannelIdFromRow(tr);

    openChannelModalSafe(chId, title);
  }, true);

  // 콘솔에서 빠른 자가 진단
  window.__srModalProbe = function () {
    const tables = document.querySelectorAll('table');
    const info = [];
    tables.forEach((t, i) => {
      info.push({ idx: i, channelColumn: findChannelColumnIndex(t), rows: t.querySelectorAll('tbody tr').length });
    });
    console.table(info);
    return info;
  };

  console.log('[sr-modal-wiring.v2] loaded');
})();
